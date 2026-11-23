import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ParseError, ParsedRow } from './parse';

/**
 * 은행 거래내역·카드사 이용대금 명세서처럼 "회사마다 열 이름이 다른" 파일 읽기.
 *
 * 1) 열 이름 사전으로 어느 열이 날짜·금액·거래처인지 추측한다(guessMapping).
 * 2) 처음 보는 형식이면 바로 넣지 않고 담당자에게 "이렇게 읽을게요"를 보여 준다.
 * 3) 담당자가 확인한 연결은 형식(열 이름 묶음)별로 저장해 다음부터 자동으로 쓴다.
 */
export type StatementKind = 'BANK' | 'CARD_STATEMENT';

export interface FieldDef {
  key: string;
  label: string;
  required: boolean;
  synonyms: string[];
}

export const STATEMENT_FIELDS: Record<StatementKind, FieldDef[]> = {
  BANK: [
    { key: 'date', label: '거래일', required: true, synonyms: ['거래일시', '거래일자', '거래일', '거래날짜', '일자', '날짜'] },
    { key: 'counterparty', label: '거래처(받는 분·내용)', required: true, synonyms: ['기재내용', '받는분', '받는 분', '거래내용', '상대방', '상대계좌예금주', '내용', '통장표시'] },
    { key: 'out', label: '출금액', required: true, synonyms: ['찾으신금액', '출금액', '출금', '지급액', '지급금액', '인출'] },
    { key: 'in', label: '입금액', required: false, synonyms: ['맡기신금액', '입금액', '입금'] },
    { key: 'memo', label: '적요', required: false, synonyms: ['적요', '거래구분', '메모', '비고'] },
  ],
  CARD_STATEMENT: [
    { key: 'date', label: '이용일', required: true, synonyms: ['이용일자', '이용일시', '이용일', '승인일자', '승인일시', '거래일자'] },
    { key: 'merchant', label: '가맹점', required: true, synonyms: ['이용가맹점', '이용하신곳', '가맹점명', '가맹점', '사용처'] },
    { key: 'amount', label: '이용금액', required: true, synonyms: ['이용금액', '승인금액', '결제금액', '금액'] },
    { key: 'industry', label: '업종', required: false, synonyms: ['업종', '가맹점업종'] },
    { key: 'approvalNo', label: '승인번호', required: false, synonyms: ['승인번호'] },
    { key: 'card', label: '카드', required: false, synonyms: ['이용카드', '카드번호', '카드구분'] },
  ],
};

export const STATEMENT_LABEL: Record<StatementKind, string> = { BANK: '은행 거래내역', CARD_STATEMENT: '카드사 이용내역' };

/** 필드 key → 원본 열 이름 */
export type Mapping = Record<string, string>;

export const mappingInputSchema = z.object({
  kind: z.enum(['BANK', 'CARD_STATEMENT']),
  label: z.string().trim().min(1).max(60),
  mapping: z.record(z.string(), z.string()),
});
export type MappingInput = z.infer<typeof mappingInputSchema>;

const norm = (s: unknown) => String(s ?? '').replace(/[\s()·_\-]/g, '').toLowerCase();

const allSynonyms = Object.values(STATEMENT_FIELDS).flatMap((fs) => fs.flatMap((f) => f.synonyms.map(norm)));

/** 은행 파일은 위쪽에 "계좌번호·조회기간" 같은 줄이 있다. 열 이름 사전과 가장 많이 맞는 줄을 헤더로 본다. */
export function findHeaderRow(table: unknown[][]): number {
  let best = -1;
  let bestScore = 1;
  for (let i = 0; i < Math.min(table.length, 20); i++) {
    const cells = (table[i] ?? []).map(norm).filter(Boolean);
    const score = cells.filter((c) => allSynonyms.some((s) => c === s || c.includes(s))).length;
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  }
  return best;
}

export const headerSignature = (headers: string[]) =>
  createHash('sha1')
    .update(headers.map(norm).filter(Boolean).join('|'))
    .digest('hex');

function matchField(headers: string[], f: FieldDef, used: Set<string>): string | undefined {
  // 정확히 같은 이름 → 포함하는 이름 순서로 찾고, 이미 다른 필드에 쓴 열은 건너뛴다
  for (const exact of [true, false]) {
    for (const syn of f.synonyms.map(norm)) {
      const h = headers.find((x) => !used.has(x) && (exact ? norm(x) === syn : norm(x).includes(syn)));
      if (h) return h;
    }
  }
  return undefined;
}

export function guessMapping(headers: string[], kind: StatementKind): { mapping: Mapping; missing: string[] } {
  const used = new Set<string>();
  const mapping: Mapping = {};
  for (const f of STATEMENT_FIELDS[kind]) {
    const h = matchField(headers, f, used);
    if (h) {
      mapping[f.key] = h;
      used.add(h);
    }
  }
  const missing = STATEMENT_FIELDS[kind].filter((f) => f.required && !mapping[f.key]).map((f) => f.key);
  return { mapping, missing };
}

/** 출금·입금 열이 있으면 은행, 가맹점·이용금액이 있으면 카드사 명세서. 둘 다 아니면 null */
export function guessKind(headers: string[]): StatementKind | null {
  const bank = guessMapping(headers, 'BANK');
  const card = guessMapping(headers, 'CARD_STATEMENT');
  const bankScore = Object.keys(bank.mapping).length - bank.missing.length * 2;
  const cardScore = Object.keys(card.mapping).length - card.missing.length * 2;
  if (bank.mapping.out && bankScore >= cardScore) return 'BANK';
  if (card.mapping.merchant) return 'CARD_STATEMENT';
  if (bank.mapping.out || bank.mapping.in) return 'BANK';
  return null;
}

export function validateMapping(headers: string[], kind: StatementKind, mapping: Mapping): string[] {
  const problems: string[] = [];
  for (const f of STATEMENT_FIELDS[kind]) {
    const h = mapping[f.key];
    if (!h) {
      if (f.required) problems.push(`${f.label} 열을 골라 주세요`);
      continue;
    }
    if (!headers.includes(h)) problems.push(`"${h}" 열이 파일에 없습니다`);
  }
  return problems;
}

function toDate(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const m = String(v ?? '')
    .trim()
    .match(/^(\d{4})[-./년\s]*(\d{1,2})[-./월\s]*(\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null;
}

function toAmount(v: unknown): number | null {
  if (v === null || v === undefined || String(v).trim() === '') return 0;
  if (typeof v === 'number') return Math.round(v);
  const s = String(v).replace(/[,\s원]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Math.round(Number(s));
}

export interface StatementRow extends ParsedRow {
  rowKind: 'BANK_OUT' | 'CARD_STATEMENT';
  memo?: string;
  sourceRow: number;
  vatEstimated?: boolean;
}

export interface StatementParse {
  rows: StatementRow[];
  errors: ParseError[];
  /** 은행 입금(매출 정산 등) — 이번 단계에서는 비용 검토 대상이 아니라 건수만 알려 준다 */
  skippedDeposits: number;
  /** 카드 취소(음수) 건 */
  skippedCancels: number;
}

/** 확인된 열 연결로 표를 거래로 바꾼다. 원본 줄 번호를 남겨 사람이 대조할 수 있게 한다. */
export function parseStatement(table: unknown[][], headerIdx: number, kind: StatementKind, mapping: Mapping): StatementParse {
  const headers = (table[headerIdx] ?? []).map((c) => String(c ?? '').trim());
  const idx = (key: string) => (mapping[key] ? headers.indexOf(mapping[key]) : -1);
  const rows: StatementRow[] = [];
  const errors: ParseError[] = [];
  const seen = new Map<string, number>();
  let skippedDeposits = 0;
  let skippedCancels = 0;

  for (let i = headerIdx + 1; i < table.length; i++) {
    const r = table[i];
    const line = i + 1;
    if (!r || r.every((c) => !String(c ?? '').trim())) continue;
    const get = (key: string) => (idx(key) >= 0 ? r[idx(key)] : undefined);
    const text = (key: string) => String(get(key) ?? '').trim();
    const date = toDate(get('date'));
    // 합계·소계 줄은 날짜가 없다
    if (!date && /합계|소계|total/i.test(r.map((c) => String(c ?? '')).join(''))) continue;

    if (kind === 'BANK') {
      const out = toAmount(get('out'));
      const inn = toAmount(get('in'));
      // 페이지 번호·안내 문구처럼 날짜도 금액도 없는 줄은 거래가 아니다
      if (!date && !out && !inn) continue;
      const problems: string[] = [];
      if (!date) problems.push('날짜 형식이 맞지 않습니다');
      if (out === null) problems.push('출금액이 숫자가 아닙니다');
      if (inn === null) problems.push('입금액이 숫자가 아닙니다');
      if (problems.length) {
        errors.push({ row: line, message: problems.join(', ') });
        continue;
      }
      if (!out) {
        if (inn) skippedDeposits++;
        continue;
      }
      const counterparty = text('counterparty') || text('memo') || '(내용 없음)';
      const base = `${date}|${out}|${counterparty}|${text('memo')}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      rows.push({
        rowKind: 'BANK_OUT',
        externalKey: `BANK:${createHash('sha1').update(`${base}|${n}`).digest('hex').slice(0, 16)}`,
        date: date!,
        counterparty,
        memo: text('memo') || undefined,
        supplyAmount: out!,
        vat: 0,
        sourceRow: line,
      });
      continue;
    }

    const amount = toAmount(get('amount'));
    const merchant = text('merchant');
    if (!date && !amount) continue;
    const problems: string[] = [];
    if (!date) problems.push('날짜 형식이 맞지 않습니다');
    if (amount === null) problems.push('이용금액이 숫자가 아닙니다');
    if (!merchant) problems.push('가맹점이 비어 있습니다');
    if (problems.length) {
      errors.push({ row: line, message: problems.join(', ') });
      continue;
    }
    if (amount! < 0) {
      skippedCancels++;
      continue;
    }
    if (amount === 0) continue;
    // 명세서에는 부가세가 따로 없다 → 일반과세 가맹점 기준 합계의 1/11로 추정하고 표시한다
    const supply = Math.round(amount! / 1.1);
    const approval = text('approvalNo');
    const base = approval ? `A:${approval}` : `${date}|${amount}|${merchant}|${text('card')}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    rows.push({
      rowKind: 'CARD_STATEMENT',
      externalKey: `CARDST:${createHash('sha1').update(`${base}|${n}`).digest('hex').slice(0, 16)}`,
      date: date!,
      counterparty: merchant,
      industry: text('industry') || undefined,
      memo: text('card') || undefined,
      supplyAmount: supply,
      vat: amount! - supply,
      vatEstimated: true,
      sourceRow: line,
    });
  }
  return { rows, errors, skippedDeposits, skippedCancels };
}

/** LLM에게 열 연결을 물어볼 때 쓰는 프롬프트(사전으로 못 찾은 열이 있을 때만) */
export function mappingPrompt(kind: StatementKind, headers: string[], samples: unknown[][]): string {
  const fields = STATEMENT_FIELDS[kind].map((f) => `- ${f.key}: ${f.label}${f.required ? ' (필수)' : ''}`).join('\n');
  return `${STATEMENT_LABEL[kind]} 파일의 열 연결을 정해 주세요.
열 이름: ${JSON.stringify(headers.filter(Boolean))}
예시 줄: ${JSON.stringify(samples.slice(0, 3).map((r) => r.map((c) => (c instanceof Date ? c.toISOString().slice(0, 10) : c))))}
필드:
${fields}
JSON 하나로만 답하세요. 키는 필드 이름, 값은 위 열 이름 중 하나 그대로. 맞는 열이 없으면 키를 빼세요.`;
}

export function parseMappingAnswer(answer: string, headers: string[]): Mapping {
  const m = answer.match(/\{[\s\S]*\}/);
  if (!m) return {};
  try {
    const obj = JSON.parse(m[0]) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(obj).filter(([, v]) => typeof v === 'string' && headers.includes(v))) as Mapping;
  } catch {
    return {};
  }
}
