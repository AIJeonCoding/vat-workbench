import type { Judgement, Txn } from '../domain/entities';
import { REASON_LABEL } from '../rules/law';

export interface FilingSummary {
  salesInvoice: { supply: number; vat: number; count: number };
  cardSales: { supply: number; vat: number; count: number };
  outputVat: number;
  purchaseInvoiceDeduct: { supply: number; vat: number; count: number };
  cardPurchaseDeduct: { supply: number; vat: number; count: number };
  inputVat: number;
  /** 세금계산서를 받았지만 공제받지 못할 매입세액(신고서 별도 명세) */
  invoiceNonDeduct: { vat: number; count: number };
  /** 카드 매입 중 불공제 — 신고서 공제란에 넣지 않는 금액 */
  cardNonDeduct: { vat: number; count: number };
  nonDeductByReason: { reasonCode: string; label: string; vat: number; count: number }[];
  payable: number;
  totals: { all: number; confirmed: number; pending: number; needsReview: number; matched: number };
  /** 계좌 출금 정리: 신고서 숫자에는 안 들어가고, 증빙 요청·대사 확인용 */
  bank: { count: number; cardPayment: number; invoicePaid: number; noEvidence: { count: number; amount: number }; notVat: number; other: number };
  /** 카드사 명세서 중 홈택스 사업용카드와 같은 거래로 정리된 건 */
  cardStatementDuplicates: number;
}

/** 확정값이 있으면 확정값, 없으면 AI 제안, 없으면 규칙 판정 */
export function effective(t: Pick<Txn, 'final' | 'ai' | 'rule'>): Judgement | null {
  return t.final ?? t.ai ?? t.rule ?? null;
}

/**
 * 부가세 신고서 요약 조서. 거래 판정이 바뀔 때마다 다시 계산해 화면에 흘려보낸다.
 * (데모용 단순화: 예정고지·가산세·의제매입 등은 다루지 않음)
 */
export function summarize(txns: Txn[]): FilingSummary {
  const z = () => ({ supply: 0, vat: 0, count: 0 });
  const s: FilingSummary = {
    salesInvoice: z(),
    cardSales: z(),
    outputVat: 0,
    purchaseInvoiceDeduct: z(),
    cardPurchaseDeduct: z(),
    inputVat: 0,
    invoiceNonDeduct: { vat: 0, count: 0 },
    cardNonDeduct: { vat: 0, count: 0 },
    nonDeductByReason: [],
    payable: 0,
    totals: { all: txns.length, confirmed: 0, pending: 0, needsReview: 0, matched: 0 },
    bank: { count: 0, cardPayment: 0, invoicePaid: 0, noEvidence: { count: 0, amount: 0 }, notVat: 0, other: 0 },
    cardStatementDuplicates: 0,
  };
  const byReason = new Map<string, { vat: number; count: number }>();
  const add = (b: { supply: number; vat: number; count: number }, t: Txn) => {
    b.supply += t.supplyAmount;
    b.vat += t.vat;
    b.count++;
  };

  for (const t of txns) {
    if (t.status === 'CONFIRMED') s.totals.confirmed++;
    else if (t.status === 'MATCHED') s.totals.matched++;
    else s.totals.pending++;
    if (t.status === 'NEEDS_REVIEW') s.totals.needsReview++;

    if (t.kind === 'BANK_OUT') {
      s.bank.count++;
      const code = effective(t)?.reasonCode;
      if (t.matchType === 'CARD_PAYMENT' && t.status === 'MATCHED') s.bank.cardPayment++;
      else if (t.matchType === 'INVOICE_PAID' && t.status === 'MATCHED') s.bank.invoicePaid++;
      else if (code === 'NO_EVIDENCE') {
        s.bank.noEvidence.count++;
        s.bank.noEvidence.amount += t.supplyAmount;
      } else if (code === 'NOT_VAT') s.bank.notVat++;
      else s.bank.other++;
      continue;
    }
    if (t.status === 'MATCHED') {
      if (t.matchType === 'SAME_AS_HOMETAX_CARD') s.cardStatementDuplicates++;
      continue;
    }

    if (t.kind === 'SALES_INVOICE') add(s.salesInvoice, t);
    else if (t.kind === 'CARD_SALES') add(s.cardSales, t);
    else {
      const j = effective(t);
      const deduct = j ? j.decision === 'DEDUCT' : false;
      if (deduct) add(t.kind === 'PURCHASE_INVOICE' ? s.purchaseInvoiceDeduct : s.cardPurchaseDeduct, t);
      else {
        const bucket = t.kind === 'PURCHASE_INVOICE' ? s.invoiceNonDeduct : s.cardNonDeduct;
        bucket.vat += t.vat;
        bucket.count++;
        const code = j?.reasonCode ?? 'UNDECIDED';
        const r = byReason.get(code) ?? { vat: 0, count: 0 };
        r.vat += t.vat;
        r.count++;
        byReason.set(code, r);
      }
    }
  }
  s.outputVat = s.salesInvoice.vat + s.cardSales.vat;
  s.inputVat = s.purchaseInvoiceDeduct.vat + s.cardPurchaseDeduct.vat;
  s.payable = s.outputVat - s.inputVat;
  s.nonDeductByReason = [...byReason.entries()]
    .map(([reasonCode, v]) => ({ reasonCode, label: REASON_LABEL[reasonCode] ?? '미판정', ...v }))
    .sort((a, b) => b.vat - a.vat);
  return s;
}
