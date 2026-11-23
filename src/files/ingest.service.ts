import { createHash } from 'node:crypto';
import { EntityManager } from '@mikro-orm/postgresql';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EventBus } from '../common/events';
import { Client, ColumnTemplate, DecisionMemory, Filing, FilingStatus, SourceFile, Txn, type FileKind, type TxnKind } from '../domain/entities';
import type { Actor } from '../domain/schemas';
import { audit } from '../review/audit';
import { applyRules } from '../rules/rules';
import { AgentQueue } from '../agent/agent.queue';
import { KIND_LABEL, parseTable, readTable, type ParseError, type ParsedRow } from './parse';
import { reconcile } from './reconcile';
import { ScannedPdfError } from './pdf';
import {
  findHeaderRow,
  guessKind,
  guessMapping,
  headerSignature,
  mappingPrompt,
  parseMappingAnswer,
  parseStatement,
  STATEMENT_FIELDS,
  STATEMENT_LABEL,
  validateMapping,
  type Mapping,
  type MappingInput,
  type StatementKind,
} from './statement';

export interface NeedsMapping {
  kind: StatementKind;
  kindLabel: string;
  headers: string[];
  mapping: Mapping;
  missing: string[];
  /** dictionary: 열 이름 사전으로 다 찾음 / llm: 사전으로 못 찾은 열을 로컬 AI가 추측 */
  guessedBy: 'dictionary' | 'llm';
  samples: string[][];
  fields: { BANK: { key: string; label: string; required: boolean }[]; CARD_STATEMENT: { key: string; label: string; required: boolean }[] };
}

export interface IngestResult {
  fileId: number | null;
  filename: string;
  kind: string;
  kindLabel: string;
  duplicate: boolean;
  added: number;
  skippedExisting: number;
  errors: ParseError[];
  /** 검토 결과 파일을 다시 올린 경우: 바뀐 판정 목록(적용 전 확인용) */
  reviewDiff?: { txnId: number; counterparty: string; before: string; after: string; reason: string; note: string }[];
  /** 처음 보는 은행·카드사 형식: 담당자가 열 연결을 확인해야 들어간다(아직 아무것도 저장 안 됨) */
  needsMapping?: NeedsMapping;
  /** 쓰인 열 연결 형식 */
  template?: { label: string; reused: boolean };
  /** 이번 업로드 뒤 다른 자료와 맞춰져 정리된 건수(이 파일 + 기존 거래) */
  matched?: number;
  skippedDeposits?: number;
  skippedCancels?: number;
}

type Row = ParsedRow & { rowKind: TxnKind; memo?: string; vatEstimated?: boolean };

export const counterpartyKey = (t: Pick<Txn, 'counterpartyBrn' | 'counterparty'>) => t.counterpartyBrn ?? `name:${t.counterparty}`;

const cellText = (c: unknown) => (c instanceof Date ? c.toISOString().slice(0, 10) : String(c ?? '').trim());

@Injectable()
export class IngestService {
  constructor(
    private readonly em: EntityManager,
    private readonly events: EventBus,
    private readonly agent: AgentQueue,
  ) {}

  /**
   * 고객이 준 파일 하나를 받아 종류를 알아내고 거래로 바꾼다.
   * - 홈택스 양식(카드·세금계산서)은 헤더로 바로 인식
   * - 은행·카드사 명세서는 열 연결을 추측 → 처음 보는 형식이면 담당자 확인 후 저장, 다음부터 자동
   * - 같은 파일(내용 해시)·같은 거래(키)는 한 번만 들어간다
   * - 규칙 판정 → 이전 사람 판단 재사용 → 대사(중복·대금 정리) → 나머지는 AI 대기열
   */
  async ingest(actor: Actor, filingId: number, filename: string, buf: Buffer, mappingInput?: MappingInput): Promise<IngestResult> {
    if (actor.role === 'agent') throw new BadRequestException('Agent는 파일을 올릴 수 없습니다');
    const em = this.em.fork();
    const filing = await em.findOne(Filing, filingId);
    if (!filing) throw new NotFoundException('신고 건이 없습니다');
    const client = await em.findOneOrFail(Client, filing.clientId);

    let table: unknown[][];
    try {
      table = await readTable(filename, buf);
    } catch (e) {
      if (e instanceof ScannedPdfError) {
        return { filename, kind: 'UNKNOWN', kindLabel: '스캔 PDF', errors: [{ row: 0, message: e.message }], fileId: null, duplicate: false, added: 0, skippedExisting: 0 };
      }
      throw new BadRequestException(`파일을 읽지 못했습니다: ${(e as Error).message}`);
    }
    const parsed = parseTable(table);

    if (parsed.kind === 'REVIEW_EXPORT') return this.reviewDiff(em, filingId, filename, parsed);

    const contentHash = createHash('sha256').update(buf).digest('hex');
    const existingFile = await em.findOne(SourceFile, { filingId, contentHash });
    if (existingFile) {
      return {
        filename,
        kind: existingFile.kind,
        kindLabel: KIND_LABEL[existingFile.kind],
        errors: [],
        fileId: existingFile.id,
        duplicate: true,
        added: 0,
        skippedExisting: existingFile.rowCount,
      };
    }

    if (!parsed.unknown) {
      const rows: Row[] = parsed.rows.map((r) => ({ ...r, rowKind: parsed.kind as TxnKind }));
      const r = await this.commit(em, actor, filing, client, filename, contentHash, parsed.kind as FileKind, rows);
      return { filename, kind: parsed.kind, kindLabel: KIND_LABEL[parsed.kind], errors: parsed.errors, duplicate: false, ...r };
    }

    // ── 은행 거래내역·카드사 명세서 ──
    const unknownResult = (errors: ParseError[]): IngestResult => ({
      filename,
      kind: 'UNKNOWN',
      kindLabel: '알 수 없음',
      errors,
      fileId: null,
      duplicate: false,
      added: 0,
      skippedExisting: 0,
    });
    const headerIdx = findHeaderRow(table);
    if (headerIdx < 0) return unknownResult(parsed.errors);
    const headers = (table[headerIdx] ?? []).map(cellText);
    const signature = headerSignature(headers);

    let kind: StatementKind;
    let mapping: Mapping;
    let template: ColumnTemplate;
    let reused = false;

    if (mappingInput) {
      const problems = validateMapping(headers, mappingInput.kind, mappingInput.mapping);
      if (problems.length) throw new BadRequestException(problems.join(', '));
      kind = mappingInput.kind;
      mapping = Object.fromEntries(Object.entries(mappingInput.mapping).filter(([, v]) => v));
      const existing = await em.findOne(ColumnTemplate, { signature });
      template = existing ?? em.create(ColumnTemplate, { signature, kind, label: mappingInput.label, mapping, createdBy: actor.userId, createdAt: new Date(), timesUsed: 0 });
      Object.assign(template, { kind, label: mappingInput.label, mapping });
    } else {
      const existing = await em.findOne(ColumnTemplate, { signature });
      if (!existing) {
        const g = await this.guess(headers, table.slice(headerIdx + 1, headerIdx + 4));
        if (!g) return unknownResult([{ row: headerIdx + 1, message: `알 수 없는 양식입니다(헤더: ${headers.filter(Boolean).join(', ')})` }]);
        const cols = headers.map((h, i) => [h, i] as const).filter(([h]) => h);
        const samples = table
          .slice(headerIdx + 1)
          .filter((r) => r && r.some((c) => cellText(c)))
          .slice(0, 5)
          .map((r) => cols.map(([, i]) => cellText(r[i])));
        return {
          ...unknownResult([]),
          kind: g.kind,
          kindLabel: STATEMENT_LABEL[g.kind],
          needsMapping: {
            ...g,
            kindLabel: STATEMENT_LABEL[g.kind],
            headers: headers.filter(Boolean),
            samples,
            fields: {
              BANK: STATEMENT_FIELDS.BANK.map(({ key, label, required }) => ({ key, label, required })),
              CARD_STATEMENT: STATEMENT_FIELDS.CARD_STATEMENT.map(({ key, label, required }) => ({ key, label, required })),
            },
          },
        };
      }
      template = existing;
      kind = existing.kind;
      mapping = existing.mapping;
      reused = true;
    }

    template.timesUsed += 1;
    await em.flush();
    if (mappingInput) {
      audit(em, actor, 'column_template', template.id, 'TEMPLATE_SAVED', null, { label: template.label, kind, mapping });
      await em.flush();
    }

    const sp = parseStatement(table, headerIdx, kind, mapping);
    const rows: Row[] = sp.rows.map((r) => ({ ...r, rowKind: r.rowKind }));
    const r = await this.commit(em, actor, filing, client, filename, contentHash, kind, rows);
    return {
      filename,
      kind,
      kindLabel: STATEMENT_LABEL[kind],
      errors: sp.errors,
      duplicate: false,
      template: { label: template.label, reused },
      skippedDeposits: sp.skippedDeposits,
      skippedCancels: sp.skippedCancels,
      ...r,
    };
  }

  /** 열 연결 추측: 사전 먼저, 필수 열이 비면 로컬 AI에게 물어 빈 칸만 채운다 */
  private async guess(headers: string[], samples: unknown[][]): Promise<Omit<NeedsMapping, 'kindLabel' | 'headers' | 'samples' | 'fields'> | null> {
    const kind = guessKind(headers);
    if (!kind) return null;
    const g = guessMapping(headers, kind);
    if (!g.missing.length) return { kind, mapping: g.mapping, missing: [], guessedBy: 'dictionary' };
    const answer = await this.agent.ask(mappingPrompt(kind, headers, samples));
    const llm = answer ? parseMappingAnswer(answer, headers) : {};
    const used = new Set(Object.values(g.mapping));
    const mapping = { ...g.mapping };
    for (const key of g.missing) if (llm[key] && !used.has(llm[key])) mapping[key] = llm[key];
    const missing = STATEMENT_FIELDS[kind].filter((f) => f.required && !mapping[f.key]).map((f) => f.key);
    return { kind, mapping, missing, guessedBy: Object.keys(mapping).length > Object.keys(g.mapping).length ? 'llm' : 'dictionary' };
  }

  private async commit(em: EntityManager, actor: Actor, filing: Filing, client: Client, filename: string, contentHash: string, fileKind: FileKind, rows: Row[]) {
    const memories = await em.find(DecisionMemory, { clientId: client.id });
    const memoryByKey = new Map(memories.map((m) => [m.counterpartyKey, m]));
    const memoryByName = new Map(memories.map((m) => [m.counterparty, m]));
    const filingId = filing.id;

    const result = await em.transactional(async (tx) => {
      const file = tx.create(SourceFile, { filingId, kind: fileKind, filename, contentHash, rowCount: rows.length, uploadedBy: actor.userId, uploadedAt: new Date() });
      await tx.flush();

      const existingKeys = new Set(
        (await tx.find(Txn, { filingId, externalKey: { $in: rows.map((r) => r.externalKey) } }, { fields: ['externalKey'] })).map((t) => t.externalKey),
      );
      const created: Txn[] = [];
      for (const { rowKind, ...row } of rows) {
        if (existingKeys.has(row.externalKey)) continue;
        existingKeys.add(row.externalKey);
        const { status, rule } = applyRules({ ...row, kind: rowKind }, client, { start: filing.periodStart, end: filing.periodEnd });
        const t = tx.create(Txn, {
          ...row,
          filingId,
          sourceFileId: file.id,
          kind: rowKind,
          status,
          rule,
          ai: null,
          final: null,
          vatEstimated: row.vatEstimated ?? false,
          hint: rowKind === 'CARD_STATEMENT' ? '카드사 명세서에는 세액이 없어 합계의 1/11로 추정했습니다. 가맹점이 간이·면세인지 확인하세요.' : null,
          version: 1,
        });
        const mem = rowKind === 'BANK_OUT' ? undefined : (memoryByKey.get(counterpartyKey(t)) ?? memoryByName.get(t.counterparty));
        if (mem && (status === 'NEEDS_AI' || status === 'NEEDS_REVIEW')) {
          t.status = 'SUGGESTED';
          t.ai = {
            ...mem.judgement,
            explanation: `지난 신고 때 ${mem.decidedBy} 담당자 판단을 재사용: ${mem.judgement.explanation}`,
            confidence: 0.9,
            steps: [{ tool: 'decision_memory', summary: `${mem.counterparty} 이전 판단 ${mem.timesApplied}회` }],
            model: 'memory',
            ms: 0,
          };
        }
        created.push(t);
      }
      await tx.flush();

      // 대사: 새 자료와 기존 자료를 함께 보고 같은 돈이 두 번 잡히지 않게 정리
      const all = await tx.find(Txn, { filingId });
      const matched = reconcile(all);
      for (const t of matched) audit(tx, 'system:reconcile', 'txn', t.id, 'MATCHED', null, { matchType: t.matchType, linkedTxnId: t.linkedTxnId });

      audit(tx, actor, 'source_file', file.id, 'UPLOADED', null, { filename, kind: fileKind, rows: rows.length, added: created.length, matched: matched.length });
      if (filing.status === FilingStatus.COLLECTING) filing.status = FilingStatus.REVIEWING;
      await tx.flush();
      return { file, created, matched };
    });

    this.events.emit({ type: 'file', filingId, fileId: result.file.id });
    for (const t of new Set([...result.created, ...result.matched])) this.events.emit({ type: 'txn', filingId, txnId: t.id });
    this.events.emit({ type: 'summary', filingId });
    this.agent.enqueue(
      filingId,
      result.created.filter((t) => t.status === 'NEEDS_AI').map((t) => t.id),
    );
    return {
      fileId: result.file.id,
      added: result.created.length,
      skippedExisting: rows.length - result.created.length,
      matched: result.matched.length,
    };
  }

  private async reviewDiff(em: EntityManager, filingId: number, filename: string, parsed: ReturnType<typeof parseTable>): Promise<IngestResult> {
    const ids = parsed.reviewRows!.map((r) => r.txnId);
    const txns = await em.find(Txn, { id: { $in: ids }, filingId });
    const byId = new Map(txns.map((t) => [t.id, t]));
    const reviewDiff: NonNullable<IngestResult['reviewDiff']> = [];
    for (const r of parsed.reviewRows!) {
      const t = byId.get(r.txnId);
      if (!t) {
        parsed.errors.push({ row: r.row, message: `이 신고 건에 없는 거래ID(${r.txnId})` });
        continue;
      }
      if (t.status === 'MATCHED') continue;
      const cur = (t.final ?? t.ai ?? t.rule)?.decision === 'DEDUCT' ? '공제' : '불공제';
      const next = r.decision.includes('불') ? '불공제' : r.decision.includes('공제') ? '공제' : '';
      if (!next) {
        parsed.errors.push({ row: r.row, message: `판정 값은 "공제" 또는 "불공제"여야 합니다(${r.decision || '빈칸'})` });
        continue;
      }
      if (next !== cur || (r.note && r.note !== (t.final?.note ?? ''))) {
        reviewDiff.push({ txnId: t.id, counterparty: t.counterparty, before: cur, after: next, reason: r.reason, note: r.note });
      }
    }
    return { filename, kind: 'REVIEW_EXPORT', kindLabel: KIND_LABEL.REVIEW_EXPORT, errors: parsed.errors, fileId: null, duplicate: false, added: 0, skippedExisting: 0, reviewDiff };
  }
}
