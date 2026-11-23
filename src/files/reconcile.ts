import type { Txn } from '../domain/entities';

/**
 * 대사(맞춰 보기): 같은 돈이 두 번 잡히지 않게 자료끼리 묶는다.
 *  1) 카드사 명세서 줄 ↔ 홈택스 사업용카드 내역: 같은 날짜·같은 합계 → 명세서 줄은 정리(MATCHED)
 *  2) 계좌 출금 중 카드대금 → 개별 사용 내역은 카드 자료로 반영되므로 정리
 *  3) 계좌 출금 ↔ 받은 세금계산서: 같은 합계 + 거래처 이름 비슷 + 작성일 10일 전~60일 후 → 정리
 * 사람이 확정했거나 "같은 거래 아님"으로 풀어 둔 건은 건드리지 않는다.
 * 순수 함수: 바뀐 거래 목록을 돌려주고, 저장은 호출한 쪽이 한다.
 */
const CARD_PAYMENT = /카드\s*(대금|결제)|카드결제|결제대금|(KB|신한|삼성|현대|롯데|하나|우리|BC|비씨|NH)\s*카드/i;

const nameKey = (s: string) =>
  s
    .replace(/\(주\)|㈜|주식회사|\(유\)|유한회사|\(가상\)/g, '')
    .replace(/[\s()·.,-]/g, '')
    .toLowerCase();

export const similarName = (a: string, b: string) => {
  const x = nameKey(a);
  const y = nameKey(b);
  if (!x || !y) return false;
  if (x.includes(y) || y.includes(x)) return true;
  // 은행 기재내용은 7~8글자에서 잘린다 → 앞 4글자가 같으면 같은 곳으로 본다
  return x.length >= 4 && y.length >= 4 && x.slice(0, 4) === y.slice(0, 4);
};

const days = (a: string, b: string) => (Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
const total = (t: Pick<Txn, 'supplyAmount' | 'vat'>) => t.supplyAmount + t.vat;
const free = (t: Txn) => t.status !== 'CONFIRMED' && t.matchType !== 'UNMATCHED';

export function reconcile(txns: Txn[]): Txn[] {
  const changed = new Set<Txn>();
  const takenTargets = new Set(txns.filter((t) => t.status === 'MATCHED' && t.linkedTxnId).map((t) => t.linkedTxnId!));
  const set = (t: Txn, matchType: Txn['matchType'], hint: string, linked?: number) => {
    if (t.status === 'MATCHED' && t.matchType === matchType && (t.linkedTxnId ?? null) === (linked ?? null)) return;
    t.status = 'MATCHED';
    t.matchType = matchType;
    t.linkedTxnId = linked ?? null;
    t.hint = hint;
    if (linked) takenTargets.add(linked);
    changed.add(t);
  };

  const hometaxCards = txns.filter((t) => t.kind === 'CARD_PURCHASE');
  for (const s of txns.filter((t) => t.kind === 'CARD_STATEMENT' && free(t) && t.status !== 'MATCHED')) {
    const hit = hometaxCards.find((c) => !takenTargets.has(c.id) && c.date === s.date && total(c) === total(s));
    if (hit) set(s, 'SAME_AS_HOMETAX_CARD', `홈택스 사업용카드 내역(${hit.counterparty})과 같은 거래 — 한 번만 반영합니다`, hit.id);
  }

  const invoices = txns.filter((t) => t.kind === 'PURCHASE_INVOICE');
  for (const b of txns.filter((t) => t.kind === 'BANK_OUT' && free(t) && t.status !== 'MATCHED').sort((x, y) => x.date.localeCompare(y.date))) {
    const text = `${b.counterparty} ${b.memo ?? ''}`;
    if (CARD_PAYMENT.test(text)) {
      set(b, 'CARD_PAYMENT', '카드대금 결제 — 개별 사용 내역은 카드 자료로 반영되므로 따로 잡지 않습니다');
      continue;
    }
    // 같은 금액이 매달 반복되는 임대료 등은 날짜가 가장 가까운 세금계산서와 묶는다
    const hit = invoices
      .filter((iv) => !takenTargets.has(iv.id) && total(iv) === b.supplyAmount && similarName(iv.counterparty, b.counterparty) && days(b.date, iv.date) >= -10 && days(b.date, iv.date) <= 60)
      .sort((x, y) => Math.abs(days(b.date, x.date)) - Math.abs(days(b.date, y.date)))[0];
    if (hit) set(b, 'INVOICE_PAID', `${hit.date} 세금계산서(${hit.counterparty}) 대금 지급 — 세금계산서로 반영됩니다`, hit.id);
  }
  return [...changed];
}
