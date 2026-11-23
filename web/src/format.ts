import type { Txn } from './api';

export const won = (n: number) => `${n.toLocaleString('ko-KR')}원`;
export const num = (n: number) => n.toLocaleString('ko-KR');

export const REASON_LABEL: Record<string, string> = {
  BUSINESS: '일반 사업 매입',
  VEHICLE_PASSENGER: '비영업용 소형승용차',
  VEHICLE_OK: '공제 가능 차량',
  ENTERTAINMENT: '기업업무추진비(접대)',
  NOT_BUSINESS: '사업 무관·가사',
  EXEMPT_SUPPLIER: '면세 가맹점',
  SIMPLIFIED_SUPPLIER: '간이과세 가맹점',
  BEFORE_REGISTRATION: '사업자등록 전',
  NO_VAT: '세액 없음',
  NO_EVIDENCE: '증빙 없음(세금계산서 요청)',
  NOT_VAT: '세금·보험료·인건비',
};

export const KIND_LABEL: Record<string, string> = {
  CARD_PURCHASE: '카드 매입',
  CARD_SALES: '카드 매출',
  PURCHASE_INVOICE: '매입 세금계산서',
  SALES_INVOICE: '매출 세금계산서',
  REVIEW_EXPORT: '검토 결과(재업로드)',
  BANK: '은행 거래내역',
  BANK_OUT: '계좌 출금',
  CARD_STATEMENT: '카드사 이용내역',
};

export const MATCH_LABEL: Record<string, string> = {
  SAME_AS_HOMETAX_CARD: '홈택스 카드와 중복',
  CARD_PAYMENT: '카드대금',
  INVOICE_PAID: '세금계산서 대금',
};

export const isSales = (t: Pick<Txn, 'kind'>) => t.kind === 'SALES_INVOICE' || t.kind === 'CARD_SALES';

/** 화면에 보여 줄 현재 판정과 출처 */
export function current(t: Txn) {
  if (t.final) return { j: t.final, source: '사람' as const };
  if (t.ai) return { j: t.ai, source: t.ai.model === 'memory' ? ('지난 판단' as const) : ('AI' as const) };
  if (t.rule) return { j: t.rule, source: '규칙' as const };
  return { j: null, source: null };
}

export const STATUS: Record<Txn['status'], { label: string; variant: 'success' | 'warning' | 'error' | 'accent' | 'neutral' }> = {
  CONFIRMED: { label: '확정', variant: 'success' },
  RULED: { label: '규칙 판정', variant: 'neutral' },
  SUGGESTED: { label: 'AI 제안', variant: 'accent' },
  NEEDS_AI: { label: 'AI 검토 중', variant: 'accent' },
  NEEDS_REVIEW: { label: '확인 필요', variant: 'warning' },
  MATCHED: { label: '정리됨', variant: 'neutral' },
};

const WEEK = '일월화수목금토';
export const weekday = (d: string) => WEEK[new Date(`${d}T00:00:00`).getDay()];

export const TOOL_LABEL: Record<string, string> = {
  get_transaction: '거래 조회',
  get_client_profile: '고객 정보',
  find_prior_decisions: '이전 판단',
  list_counterparty_history: '결제 내역',
  search_law: '조문 검색',
  format_error: '형식 수정',
  decision_memory: '판단 기억',
};
