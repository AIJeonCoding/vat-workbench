import type { Client, Judgement, Txn, TxnStatus } from '../domain/entities';
import { LAW_REF } from './law';

const VEHICLE_INDUSTRIES = ['주유', '충전소', '정비', '카센터', '렌터카', '렌트카', '주차', '세차', '타이어', '자동차'];
/** 접대·사업무관 가능성이 있어 사람 또는 AI가 봐야 하는 업종 */
const RISKY_INDUSTRIES = ['음식점', '주점', '호프', '골프', '백화점', '면세점', '호텔', '숙박', '유흥', '노래', '선물', '꽃', '화원', '상품권', '레저', '여행'];

type RuleTxn = Pick<Txn, 'kind' | 'date' | 'counterpartyTaxType' | 'industry' | 'vat' | 'counterparty'> & Partial<Pick<Txn, 'memo'>>;

function j(decision: Judgement['decision'], reasonCode: Judgement['reasonCode'], explanation: string): Judgement {
  return { decision, reasonCode, lawRef: LAW_REF[reasonCode], explanation };
}

/**
 * 결정론적 규칙. 확실한 건만 판정하고(RULED), 애매하면 AI로 넘긴다(NEEDS_AI).
 * 매출 건은 판정 대상이 아니라 그대로 확정 상태로 둔다.
 */
export function applyRules(
  t: RuleTxn,
  client: Pick<Client, 'registeredAt' | 'vehicles' | 'businessKeywords'>,
  period: { start: string; end: string },
): {
  status: TxnStatus;
  rule: Judgement | null;
} {
  if (t.kind === 'SALES_INVOICE' || t.kind === 'CARD_SALES') {
    return { status: 'CONFIRMED', rule: null };
  }
  if (t.kind === 'BANK_OUT') return classifyBankOut({ counterparty: t.counterparty, memo: t.memo });

  if (t.date < client.registeredAt) {
    // 제8호 단서: 과세기간 종료 후 20일 이내 등록을 신청했다면, 그 과세기간 기산일 이후 매입은 공제
    const limit = new Date(`${period.end}T00:00:00Z`);
    limit.setUTCDate(limit.getUTCDate() + 20);
    const inGrace = t.date >= period.start && client.registeredAt <= limit.toISOString().slice(0, 10);
    return inGrace
      ? {
          status: 'RULED',
          rule: {
            decision: 'DEDUCT',
            reasonCode: 'BUSINESS',
            lawRef: '부가가치세법 제39조 제1항 제8호 단서',
            explanation: `사업자등록(${client.registeredAt}) 전 매입이지만 과세기간 종료 후 20일 이내 등록이라 공제됩니다.`,
          },
        }
      : {
          status: 'RULED',
          rule: j('NON_DEDUCT', 'BEFORE_REGISTRATION', `거래일(${t.date})이 사업자등록일(${client.registeredAt}) 전이고, 등록 전 매입 공제 기간에도 해당하지 않습니다.`),
        };
  }

  if (t.counterpartyTaxType === 'EXEMPT') {
    return { status: 'RULED', rule: j('NON_DEDUCT', 'EXEMPT_SUPPLIER', '면세 가맹점이라 공제할 매입세액이 없습니다.') };
  }
  if (t.counterpartyTaxType === 'SIMPLIFIED' && (t.kind === 'CARD_PURCHASE' || t.kind === 'CARD_STATEMENT')) {
    return { status: 'RULED', rule: j('NON_DEDUCT', 'SIMPLIFIED_SUPPLIER', '영수증 발급 간이과세 가맹점의 카드 매입은 공제 대상이 아닙니다.') };
  }
  if (t.vat === 0) {
    return { status: 'RULED', rule: j('NON_DEDUCT', 'NO_VAT', '세액이 0원입니다.') };
  }

  const industry = t.industry ?? '';
  if (VEHICLE_INDUSTRIES.some((k) => industry.includes(k))) {
    const kinds = new Set(client.vehicles.map((v) => v.kind));
    if (kinds.size === 0) {
      return { status: 'NEEDS_REVIEW', rule: j('NON_DEDUCT', 'NOT_BUSINESS', '등록된 사업용 차량이 없는데 차량 관련 지출이 있습니다. 용도를 확인하세요.') };
    }
    if (kinds.size === 1 && kinds.has('PASSENGER')) {
      return { status: 'RULED', rule: j('NON_DEDUCT', 'VEHICLE_PASSENGER', `보유 차량(${client.vehicles.map((v) => v.model).join(', ')})이 비영업용 소형승용차라 유지비 매입세액은 불공제입니다.`) };
    }
    if (!kinds.has('PASSENGER')) {
      return { status: 'RULED', rule: j('DEDUCT', 'VEHICLE_OK', `보유 차량(${client.vehicles.map((v) => v.model).join(', ')})이 경차·화물·승합이라 공제 가능합니다.`) };
    }
    return {
      status: 'NEEDS_REVIEW',
      rule: j('NON_DEDUCT', 'VEHICLE_PASSENGER', `승용차와 공제 가능 차량을 함께 보유하고 있어 어느 차량 지출인지 확인이 필요합니다(${client.vehicles.map((v) => `${v.plate} ${v.model}`).join(', ')}).`),
    };
  }

  if (RISKY_INDUSTRIES.some((k) => industry.includes(k))) {
    return { status: 'NEEDS_AI', rule: null };
  }

  const text = `${industry} ${t.counterparty}`;
  if (client.businessKeywords.some((k) => text.includes(k))) {
    return { status: 'RULED', rule: j('DEDUCT', 'BUSINESS', `본업(${industry || t.counterparty})과 직접 관련된 매입입니다.`) };
  }

  if (t.kind === 'PURCHASE_INVOICE') {
    return { status: 'RULED', rule: j('DEDUCT', 'BUSINESS', '세금계산서를 받은 사업 관련 매입입니다.') };
  }

  return { status: 'NEEDS_AI', rule: null };
}

const PUBLIC_DUES = ['국민연금', '건강보험', '고용보험', '산재보험', '국세', '지방세', '부가세', '부가가치세', '종합소득세', '원천세', '4대보험', '과태료', '자동차세'];
const PAYROLL = ['급여', '월급', '상여', '알바', '인건비', '아르바이트'];
const OWNER = ['생활비', '본인', '대표자', '가족'];

/**
 * 계좌 출금 한 줄 분류. 계좌이체는 적격증빙이 아니라서 그 자체로 공제되지 않는다.
 * (카드대금·세금계산서 대금은 reconcile에서 따로 맞춘다)
 */
export function classifyBankOut(t: Pick<Txn, 'counterparty' | 'memo'>): { status: TxnStatus; rule: Judgement } {
  const text = `${t.counterparty} ${t.memo ?? ''}`;
  if (PUBLIC_DUES.some((k) => text.includes(k))) {
    return { status: 'RULED', rule: j('NON_DEDUCT', 'NOT_VAT', '세금·사회보험료는 부가세가 붙지 않는 지출이라 매입세액 공제와 관계없습니다(종합소득세 경비 여부는 별도).') };
  }
  if (PAYROLL.some((k) => text.includes(k))) {
    return { status: 'RULED', rule: j('NON_DEDUCT', 'NOT_VAT', '인건비는 부가세 대상이 아닙니다. 종합소득세 경비로 쓰려면 원천세 신고 여부를 확인하세요.') };
  }
  if (OWNER.some((k) => text.includes(k))) {
    return { status: 'NEEDS_REVIEW', rule: j('NON_DEDUCT', 'NOT_BUSINESS', '대표자 개인 이체로 보입니다. 사업 지출이 아니면 그대로 두세요.') };
  }
  return {
    status: 'NEEDS_REVIEW',
    rule: j('NON_DEDUCT', 'NO_EVIDENCE', '계좌이체 기록만 있고 세금계산서·카드전표가 없습니다. 사업 관련 지출이면 고객에게 세금계산서를 요청하세요(받아서 올리면 공제).'),
  };
}
