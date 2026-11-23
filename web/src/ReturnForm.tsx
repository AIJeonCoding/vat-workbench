import { useMemo, useState } from 'react';
import type { Txn } from './api';
import { current, KIND_LABEL, num, REASON_LABEL } from './format';

/**
 * 일반과세자 부가가치세 신고서(확정) 화면. 홈택스 신고서와 같은 번호·순서로 보여 주고,
 * 줄을 누르면 그 금액을 만든 거래가 오른쪽에 나온다. 값 옆 [복사]로 홈택스에 옮겨 적는다.
 * 데모용 단순화: 영세율·대손·의제매입·경감공제 등은 비워 둔다.
 */
type Line = {
  no: string;
  label: string;
  supply?: number;
  vat?: number;
  rate?: string;
  txns?: Txn[];
  strong?: boolean;
  note?: string;
  pending?: boolean;
};

const live = (t: Txn) => t.status !== 'MATCHED' && t.kind !== 'BANK_OUT';
const deduct = (t: Txn) => current(t).j?.decision === 'DEDUCT';
const sum = (ts: Txn[], k: 'supplyAmount' | 'vat') => ts.reduce((a, t) => a + t[k], 0);

/** 고정자산(감가상각자산) 후보: 데모 규칙 — 100만원 이상 설비·인테리어·기계 */
const FIXED = /인테리어|기계|설비|장비|오븐|냉장|차량|비품/;
const isFixed = (t: Txn) => t.supplyAmount >= 1_000_000 && FIXED.test(`${t.counterparty} ${t.industry ?? ''}`);

export function ReturnForm({ txns, pendingCount }: { txns: Txn[]; pendingCount: number }) {
  const [sel, setSel] = useState<string>('9');
  const [copied, setCopied] = useState<string | null>(null);

  const lines = useMemo<Line[]>(() => {
    const L = txns.filter(live);
    const salesInv = L.filter((t) => t.kind === 'SALES_INVOICE');
    const cardSales = L.filter((t) => t.kind === 'CARD_SALES');
    const inv = L.filter((t) => t.kind === 'PURCHASE_INVOICE');
    const invFixed = inv.filter(isFixed);
    const invGeneral = inv.filter((t) => !isFixed(t));
    const cardDeduct = L.filter((t) => (t.kind === 'CARD_PURCHASE' || t.kind === 'CARD_STATEMENT') && deduct(t));
    const invNon = inv.filter((t) => !deduct(t));
    const outVat = sum(salesInv, 'vat') + sum(cardSales, 'vat');
    const inVat = sum(inv, 'vat') + sum(cardDeduct, 'vat');
    const net = inVat - sum(invNon, 'vat');
    const prepaid = txns.filter((t) => t.kind === 'BANK_OUT' && /예정고지/.test(`${t.counterparty} ${t.memo ?? ''}`));
    const prepaidAmt = sum(prepaid, 'supplyAmount');
    return [
      { no: '1', label: '과세 · 세금계산서 발급분', supply: sum(salesInv, 'supplyAmount'), vat: sum(salesInv, 'vat'), rate: '10/100', txns: salesInv },
      { no: '3', label: '과세 · 신용카드·현금영수증 발행분', supply: sum(cardSales, 'supplyAmount'), vat: sum(cardSales, 'vat'), rate: '10/100', txns: cardSales },
      { no: '5', label: '영세율 · 세금계산서 발급분', supply: 0, vat: 0, rate: '0/100' },
      { no: '9', label: '매출세액 합계', supply: sum(salesInv, 'supplyAmount') + sum(cardSales, 'supplyAmount'), vat: outVat, strong: true, txns: [...salesInv, ...cardSales] },
      { no: '10', label: '세금계산서 수취분 · 일반매입', supply: sum(invGeneral, 'supplyAmount'), vat: sum(invGeneral, 'vat'), txns: invGeneral },
      {
        no: '11',
        label: '세금계산서 수취분 · 고정자산 매입',
        supply: sum(invFixed, 'supplyAmount'),
        vat: sum(invFixed, 'vat'),
        txns: invFixed,
        note: invFixed.length ? '건물등감가상각자산취득명세서 함께 제출' : undefined,
      },
      { no: '14', label: '그 밖의 공제매입세액 (신용카드매출전표등 수령분)', supply: sum(cardDeduct, 'supplyAmount'), vat: sum(cardDeduct, 'vat'), txns: cardDeduct, note: '신용카드매출전표등 수령명세서(갑) 함께 제출' },
      { no: '15', label: '매입세액 합계', supply: sum(inv, 'supplyAmount') + sum(cardDeduct, 'supplyAmount'), vat: inVat, strong: true, txns: [...inv, ...cardDeduct] },
      { no: '16', label: '공제받지 못할 매입세액', supply: sum(invNon, 'supplyAmount'), vat: sum(invNon, 'vat'), txns: invNon, note: invNon.length ? '공제받지 못할 매입세액 명세서 함께 제출' : undefined },
      { no: '17', label: '차감계 (15 − 16)', vat: net, strong: true },
      { no: '가', label: '납부(환급)세액 (매출세액 − 매입세액)', vat: outVat - net, strong: true },
      { no: '19', label: '신용카드매출전표등 발행공제 등', pending: true, note: '경감·공제세액 계산은 준비 중 — 홈택스 화면에서 확인' },
      {
        no: '21',
        label: '예정고지세액',
        vat: prepaidAmt,
        txns: prepaid,
        note: prepaid.length ? '계좌 출금에서 찾은 금액 — 홈택스 고지내역과 맞는지 확인' : '계좌 자료에서 예정고지 출금을 찾지 못함',
      },
      { no: '27', label: '차가감하여 납부할 세액(환급받을 세액)', vat: outVat - net - prepaidAmt, strong: true, note: '경감·공제세액(19) 반영 전' },
    ];
  }, [txns]);

  const selected = lines.find((l) => l.no === sel);
  const copy = async (key: string, v: number) => {
    try {
      await navigator.clipboard.writeText(String(v));
      setCopied(key);
      setTimeout(() => setCopied(null), 1200);
    } catch {
      /* 클립보드 권한이 없으면 조용히 무시 */
    }
  };

  return (
    <div className="wb-return">
      <div>
        <div className="wb-return-head">
          <b>일반과세자 부가가치세 신고서(확정)</b>
          <span className="wb-sub"> · 홈택스 신고서와 같은 번호 · 줄을 누르면 근거 거래가 나옵니다</span>
        </div>
        {pendingCount > 0 && <div className="wb-warn" style={{ marginBottom: 8 }}>미확정 {pendingCount}건이 포함된 예상치입니다. 모두 확정한 뒤 홈택스에 옮겨 적으세요.</div>}
        <table className="wb-form">
          <thead>
            <tr>
              <th style={{ width: 40 }}>번호</th>
              <th>구분</th>
              <th className="wb-num">금액</th>
              <th style={{ width: 60 }}>세율</th>
              <th className="wb-num">세액</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.no} className={`${l.strong ? 'wb-form-strong' : ''}${sel === l.no ? ' wb-row-selected' : ''}`} onClick={() => setSel(l.no)} style={{ cursor: 'pointer' }}>
                <td>({l.no})</td>
                <td>
                  {l.label}
                  {l.note && <div className="wb-sub">{l.note}</div>}
                </td>
                <td className="wb-num">{l.supply === undefined ? '' : <Val v={l.supply} k={`${l.no}s`} copied={copied} onCopy={copy} />}</td>
                <td className="wb-sub">{l.rate ?? ''}</td>
                <td className="wb-num">{l.pending ? <span className="wb-sub">준비 중</span> : l.vat === undefined ? '' : <Val v={l.vat} k={`${l.no}v`} copied={copied} onCopy={copy} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="wb-sub" style={{ marginTop: 8 }}>
          데모용 단순화: 영세율·대손세액·의제매입세액·경감공제세액·가산세는 계산하지 않습니다. 고정자산 구분은 금액·품목으로 추정한 후보입니다.
        </div>
      </div>

      <div className="wb-return-side">
        <div className="wb-block-title">
          ({selected?.no}) {selected?.label} — 근거 {selected?.txns?.length ?? 0}건
        </div>
        {!selected?.txns?.length ? (
          <div className="wb-sub">이 줄은 거래 목록이 없는 계산 줄입니다.</div>
        ) : (
          <table className="wb-preview">
            <thead>
              <tr>
                <th>일자</th>
                <th>거래처</th>
                <th className="wb-num">공급가액</th>
                <th className="wb-num">세액</th>
              </tr>
            </thead>
            <tbody>
              {selected.txns.map((t) => (
                <tr key={t.id} title={`${KIND_LABEL[t.kind]} · ${current(t).j ? REASON_LABEL[current(t).j!.reasonCode] : ''}`}>
                  <td>{t.date.slice(5)}</td>
                  <td>
                    {t.counterparty}
                    <div className="wb-sub">
                      {KIND_LABEL[t.kind]}
                      {t.status !== 'CONFIRMED' ? ' · 미확정' : ''}
                    </div>
                  </td>
                  <td className="wb-num">{num(t.supplyAmount)}</td>
                  <td className="wb-num">
                    {t.vatEstimated ? '≈' : ''}
                    {num(t.vat)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Val({ v, k, copied, onCopy }: { v: number; k: string; copied: string | null; onCopy: (k: string, v: number) => void }) {
  return (
    <span className="wb-val">
      {num(v)}
      <button
        className="wb-copy"
        onClick={(e) => {
          e.stopPropagation();
          onCopy(k, v);
        }}
        title="숫자만 복사(홈택스 입력용)"
      >
        {copied === k ? '복사됨' : '복사'}
      </button>
    </span>
  );
}
