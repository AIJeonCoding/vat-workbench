import { z } from 'zod';
import type { EntityManager } from '@mikro-orm/postgresql';
import { Client, DecisionMemory, Txn } from '../domain/entities';
import { searchLaw } from '../rules/law';
import type { Tool } from './loop';

const won = (n: number) => n.toLocaleString('ko-KR');
const weekday = (d: string) => '일월화수목금토'[new Date(`${d}T00:00:00`).getDay()];

/**
 * 세무 업무 Action을 Tool로 정의한다. 전부 읽기 전용 — 쓰기(확정)는 사람 화면에서만.
 * 같은 정의를 MCP 서버로도 노출할 수 있게 이름·설명·Zod 스키마를 분리해 둔다.
 */
export function buildTools(em: EntityManager, ctx: { filingId: number; clientId: number; txnId: number }): Tool[] {
  const getTransaction: Tool = {
    name: 'get_transaction',
    description: '검토할 카드 매입 거래의 상세(가맹점, 업종, 과세유형, 금액, 요일)를 조회합니다.',
    params: {},
    schema: z.object({}),
    async run() {
      const t = await em.findOneOrFail(Txn, ctx.txnId);
      return JSON.stringify({
        거래ID: t.id,
        일자: `${t.date}(${weekday(t.date)})`,
        가맹점: t.counterparty,
        가맹점사업자번호: t.counterpartyBrn ?? '없음',
        과세유형: t.counterpartyTaxType ?? '모름',
        업종: t.industry ?? '모름',
        공급가액: won(t.supplyAmount),
        세액: won(t.vat),
      });
    },
    summarize: () => '거래 상세 조회',
  };

  const getClientProfile: Tool = {
    name: 'get_client_profile',
    description: '고객사의 업종, 사업자등록일, 보유 차량, 본업 관련 매입 키워드를 조회합니다.',
    params: {},
    schema: z.object({}),
    async run() {
      const c = await em.findOneOrFail(Client, ctx.clientId);
      return JSON.stringify({ 상호: c.name, 업종: c.industry, 등록일: c.registeredAt, 차량: c.vehicles, 본업관련: c.businessKeywords });
    },
    summarize: () => '고객 업종·차량 확인',
  };

  const findPrior = z.object({ counterparty: z.string().min(1).max(100) });
  const findPriorDecisions: Tool<typeof findPrior> = {
    name: 'find_prior_decisions',
    description: '같은 고객이 이전에 같은(비슷한) 가맹점에 대해 사람이 내린 판단을 찾습니다. 사람 판단이 있으면 가장 강한 근거입니다.',
    params: { counterparty: '가맹점명(일부만 써도 됨)' },
    schema: findPrior,
    async run({ counterparty }) {
      const mems = await em.find(DecisionMemory, { clientId: ctx.clientId, counterparty: { $ilike: `%${counterparty}%` } }, { limit: 5 });
      if (!mems.length) return '이전 사람 판단 없음';
      return JSON.stringify(mems.map((m) => ({ 가맹점: m.counterparty, 판정: m.judgement.decision, 사유: m.judgement.reasonCode, 메모: m.judgement.note ?? m.judgement.explanation, 판단자: m.decidedBy })));
    },
    summarize: (a, r) => (r.startsWith('이전') ? `"${a.counterparty}" 이전 판단 없음` : `"${a.counterparty}" 이전 사람 판단 확인`),
  };

  const history = z.object({ counterparty: z.string().min(1).max(100) });
  const listCounterpartyHistory: Tool<typeof history> = {
    name: 'list_counterparty_history',
    description: '이번 신고 기간에 같은 가맹점에서 결제한 다른 내역(일자·요일·금액)을 봅니다. 반복성·주말·고액 여부 판단에 씁니다.',
    params: { counterparty: '가맹점명(일부만 써도 됨)' },
    schema: history,
    async run({ counterparty }) {
      const rows = await em.find(Txn, { filingId: ctx.filingId, counterparty: { $ilike: `%${counterparty}%` } }, { orderBy: { date: 'asc' }, limit: 20 });
      return JSON.stringify(rows.map((t) => ({ 일자: `${t.date}(${weekday(t.date)})`, 금액: won(t.supplyAmount + t.vat), 상태: t.status })));
    },
    summarize: (a, r) => `"${a.counterparty}" 결제 내역 ${(JSON.parse(r) as unknown[]).length}건 확인`,
  };

  const law = z.object({ query: z.string().min(1).max(200) });
  const searchLawTool: Tool<typeof law> = {
    name: 'search_law',
    description: '부가세 매입세액 공제·불공제 조문과 실무 메모를 검색합니다.',
    params: { query: '찾을 내용(예: 거래처 식사 접대)' },
    schema: law,
    async run({ query }) {
      const docs = searchLaw(query);
      if (!docs.length) return '관련 조문 없음. 다른 단어로 검색하세요.';
      return docs.map((d) => `[${d.ref}] ${d.title}\n${d.text}`).join('\n\n');
    },
    summarize: (a, r) => `조문 검색 "${a.query}" → ${r.match(/\[[^\]]+\]/)?.[0] ?? '없음'}`,
  };

  return [getTransaction, getClientProfile, findPriorDecisions, listCounterpartyHistory, searchLawTool];
}
