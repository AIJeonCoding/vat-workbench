import { z } from 'zod';
import type { EntityManager } from '@mikro-orm/postgresql';
import { DecisionMemory, Txn, type Client } from '../domain/entities';
import { REASON_LABEL, searchLaw } from '../rules/law';
import { effective, summarize } from '../review/summary';
import type { Tool } from '../agent/loop';
import { isOpen, judgeLabel, row, STATUS_KO, type ActionCard } from './assistant';

/**
 * 업무 대화용 자율 루프 도구. 지금 열린 신고 건 안에서만, 전부 읽기 전용.
 * 여기 정의된 도구 외에는 루프가 실행하지 않는다(정의된 기능만 동작).
 * 확정은 도구로 하지 않는다 — answer의 confirm_ids로 '확정 카드'만 만들고, 실행은 사람이 카드에서 누른다.
 */
export function buildChatTools(em: EntityManager, ctx: { filingId: number; client: Client }) {
  const load = () => em.find(Txn, { filingId: ctx.filingId }, { orderBy: { date: 'asc' } });
  const shown = new Map<number, Txn>();

  const getSummary: Tool = {
    name: 'get_summary',
    description: '이번 신고 기간 요약(매출세액·매입세액·납부 예상·진행 건수·증빙 없는 출금)을 봅니다.',
    params: {},
    schema: z.object({}),
    async run() {
      const s = summarize(await load());
      return JSON.stringify({ 매출세액: s.outputVat, 매입세액: s.inputVat, 납부예상: s.payable, 진행: s.totals, 증빙없는출금: s.bank.noEvidence });
    },
    summarize: () => '신고 요약 확인',
  };

  const listArgs = z.object({
    status: z.enum(['open', 'review', 'suggested', 'confirmed', 'all']).default('open'),
    counterparty: z.string().max(60).optional(),
    reason: z.string().max(40).optional(),
  });
  const listTxns: Tool<typeof listArgs> = {
    name: 'list_txns',
    description: '거래 목록(최대 20건)을 조건으로 찾습니다. status: open(미확정)·review(확인 필요)·suggested(AI 제안)·confirmed(확정)·all',
    params: { status: 'open | review | suggested | confirmed | all', counterparty: '(선택) 거래처 이름 일부', reason: '(선택) 사유 이름 일부(예: 접대, 차량, 증빙)' },
    schema: listArgs,
    async run({ status, counterparty, reason }) {
      let list = (await load()).filter((t) => t.status !== 'MATCHED');
      if (status === 'open') list = list.filter(isOpen);
      if (status === 'review') list = list.filter((t) => t.status === 'NEEDS_REVIEW');
      if (status === 'suggested') list = list.filter((t) => t.status === 'SUGGESTED' || t.status === 'RULED');
      if (status === 'confirmed') list = list.filter((t) => t.status === 'CONFIRMED');
      if (counterparty) list = list.filter((t) => t.counterparty.replace(/\s/g, '').includes(counterparty.replace(/\s/g, '')));
      if (reason) list = list.filter((t) => (REASON_LABEL[effective(t)?.reasonCode ?? ''] ?? '').includes(reason) || judgeLabel(t).includes(reason));
      for (const t of list.slice(0, 20)) shown.set(t.id, t);
      return JSON.stringify({ 전체: list.length, 거래: list.slice(0, 20).map((t) => ({ ...row(t), status: STATUS_KO[t.status] ?? t.status, 근거: (effective(t)?.explanation ?? t.hint ?? '').slice(0, 80) })) });
    },
    summarize: (a, r) => `거래 조회(${a.status}${a.counterparty ? ` · ${a.counterparty}` : ''}${a.reason ? ` · ${a.reason}` : ''}) → ${(JSON.parse(r) as { 전체: number }).전체}건`,
  };

  const idArgs = z.object({ id: z.coerce.number().int().positive() });
  const getTxn: Tool<typeof idArgs> = {
    name: 'get_txn',
    description: '거래 한 건의 상세(업종·과세유형·금액·판정 근거·메모)를 봅니다.',
    params: { id: '거래 id(숫자)' },
    schema: idArgs,
    async run({ id }) {
      const t = await em.findOne(Txn, { id, filingId: ctx.filingId });
      if (!t) return '[ERROR] 이 신고 건에 없는 거래 id입니다.';
      shown.set(t.id, t);
      const j = effective(t);
      return JSON.stringify({ ...row(t), 업종: t.industry, 과세유형: t.counterpartyTaxType, 상태: STATUS_KO[t.status] ?? t.status, 근거: j?.explanation ?? t.memo ?? t.hint, 조문: j?.lawRef });
    },
    summarize: (a) => `거래 #${a.id} 상세`,
  };

  const cpArgs = z.object({ counterparty: z.string().min(1).max(60) });
  const findPrior: Tool<typeof cpArgs> = {
    name: 'find_prior_decisions',
    description: '이 고객의 같은 거래처에 대해 사람이 이전에 내린 판단을 찾습니다.',
    params: { counterparty: '거래처 이름 일부' },
    schema: cpArgs,
    async run({ counterparty }) {
      const mems = await em.find(DecisionMemory, { clientId: ctx.client.id, counterparty: { $ilike: `%${counterparty}%` } }, { limit: 5 });
      if (!mems.length) return '이전 사람 판단 없음';
      return JSON.stringify(mems.map((m) => ({ 거래처: m.counterparty, 판정: m.judgement.decision, 사유: REASON_LABEL[m.judgement.reasonCode] ?? m.judgement.reasonCode, 판단자: m.decidedBy })));
    },
    summarize: (a, r) => (r.startsWith('이전') ? `"${a.counterparty}" 이전 판단 없음` : `"${a.counterparty}" 이전 판단 확인`),
  };

  const lawArgs = z.object({ query: z.string().min(1).max(100) });
  const lawTool: Tool<typeof lawArgs> = {
    name: 'search_law',
    description: '부가세 공제·불공제 조문과 실무 메모를 검색합니다.',
    params: { query: '찾을 내용(예: 접대비, 승용차 주유)' },
    schema: lawArgs,
    async run({ query }) {
      const docs = searchLaw(query, 2);
      return docs.length ? docs.map((d) => `[${d.ref}] ${d.title}\n${d.text}`).join('\n\n') : '관련 조문 없음';
    },
    summarize: (a, r) => `조문 검색 "${a.query}" → ${r.match(/\[[^\]]+\]/)?.[0] ?? '없음'}`,
  };

  const listRequests: Tool = {
    name: 'list_client_requests',
    description: '고객에게 물어볼 건(증빙 없는 출금, 용도 확인 필요 건)을 봅니다.',
    params: {},
    schema: z.object({}),
    async run() {
      const live = (await load()).filter((t) => t.status !== 'MATCHED');
      const ev = live.filter((t) => t.kind === 'BANK_OUT' && effective(t)?.reasonCode === 'NO_EVIDENCE');
      const purpose = live.filter((t) => t.status === 'NEEDS_REVIEW' && t.kind !== 'BANK_OUT');
      for (const t of [...ev, ...purpose]) shown.set(t.id, t);
      return JSON.stringify({ 증빙요청: ev.slice(0, 15).map(row), 용도확인: purpose.slice(0, 15).map(row) });
    },
    summarize: (_a, r) => {
      const j = JSON.parse(r) as { 증빙요청: unknown[]; 용도확인: unknown[] };
      return `고객 요청 확인 → 증빙 ${j.증빙요청.length} · 용도 ${j.용도확인.length}`;
    },
  };

  const tools = [getSummary, listTxns, getTxn, findPrior, lawTool, listRequests];

  /** answer의 confirm_ids → 확정 카드. 이 신고 건의 미확정 거래만, 계좌 출금 공제 확정은 막는다. */
  async function buildCard(ids: number[], decision?: 'DEDUCT' | 'NON_DEDUCT', reasonCode?: string): Promise<ActionCard | string> {
    const txns = (await em.find(Txn, { id: { $in: ids.slice(0, 50) }, filingId: ctx.filingId })).filter(isOpen);
    if (!txns.length) return '확정할 미확정 거래를 찾지 못했어요.';
    if (decision === 'DEDUCT' && txns.some((t) => t.kind === 'BANK_OUT')) return '계좌 출금은 증빙이 없어 공제로 확정할 수 없어요.';
    if (!decision && txns.some((t) => !effective(t))) return '판정이 없는 거래는 제안대로 확정할 수 없어요. 공제·불공제를 말해 주세요.';
    const rc = decision === 'NON_DEDUCT' ? (reasonCode && REASON_LABEL[reasonCode] ? reasonCode : 'NOT_BUSINESS') : decision === 'DEDUCT' ? 'BUSINESS' : undefined;
    return {
      kind: 'confirm',
      title: decision ? `${decision === 'DEDUCT' ? '공제' : '불공제'}(${REASON_LABEL[rc!] ?? ''})로 확정` : '현재 제안대로 확정',
      decision,
      reasonCode: rc,
      txns: txns.map((t) => ({ id: t.id, version: t.version, date: t.date, counterparty: t.counterparty, amount: t.supplyAmount + t.vat, current: judgeLabel(t) })),
    };
  }

  return { tools, buildCard, shown };
}

export const answerSchema = z.object({
  reply: z.string().min(1).max(1500),
  confirm_ids: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(/[,\s]+/).map(Number).filter((n) => Number.isInteger(n) && n > 0) : [])),
  decision: z.enum(['DEDUCT', 'NON_DEDUCT', 'SUGGESTED']).optional(),
  reason_code: z.string().max(40).optional(),
});
export type Answer = z.infer<typeof answerSchema>;

export const LOOP_SYSTEM = (toolsDoc: string, clientName: string) => `당신은 세무사 사무실의 부가세 신고 업무 보조 Agent입니다. 지금 열린 고객은 "${clientName}"입니다.
세무사의 요청을 처리하기 위해 아래 도구를 하나씩 골라 조사하고, 끝나면 answer로 답합니다.

규칙
- 보통 2~3번 조회면 충분합니다. list_txns 결과에 근거가 있으니 건마다 get_txn을 부르지 않습니다.
- 한 번에 도구 하나만 XML 태그로 호출합니다. 결과를 받은 뒤 다음 단계를 정합니다. 도구 태그 외의 글은 쓰지 않습니다.
- 아래 목록에 없는 도구·기능은 없습니다. 도구 결과에 없는 숫자·거래는 지어내지 않습니다.
- 당신은 확정·수정·발송을 할 수 없습니다. 확정 요청이면 대상 거래 id를 confirm_ids에 넣어 '확정 카드'를 만들고, 실행은 세무사가 카드에서 누른다고 안내합니다.
- 부가세 신고 업무와 관계없는 요청이면 도구를 쓰지 말고 바로 answer로 "부가세 신고 업무만 도와드릴 수 있어요."라고 답합니다.
- 세법 판단은 참고이며 최종 판단은 세무사가 한다고 밝힙니다. reply는 한국어 5문장 이내.

# 도구
${toolsDoc}

## answer
조사를 마치고 세무사에게 답합니다.
- reply: 답변(한국어, 도구 결과 근거)
- confirm_ids: (선택) 확정 카드에 넣을 거래 id, 쉼표로 구분
- decision: (선택) DEDUCT(공제) · NON_DEDUCT(불공제) · SUGGESTED(현재 제안대로)
- reason_code: (선택) 불공제 사유 ENTERTAINMENT · NOT_BUSINESS · VEHICLE_PASSENGER 등
사용법:
<answer>
<reply>...</reply>
<confirm_ids>12,15</confirm_ids>
<decision>SUGGESTED</decision>
</answer>`;
