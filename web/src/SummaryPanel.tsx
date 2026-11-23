import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { useState } from 'react';
import { gql, type Summary, type User } from './api';
import { num } from './format';

/** 부가세 신고서 요약 조서. 판정이 바뀔 때마다 실시간으로 다시 계산된다. */
export function SummaryPanel({ filingId, summary: s, user, status, onChanged }: { filingId: number; summary?: Summary; user: User; status?: string; onChanged: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  if (!s) return <Text type="supporting">불러오는 중…</Text>;
  // 정리됨(대사)은 사람이 더 볼 필요 없으므로 진행률에서 뺀다
  const purchaseTotal = s.totals.all - s.salesInvoice.count - s.cardSales.count - s.totals.matched;
  const confirmedPurchases = s.totals.confirmed - s.salesInvoice.count - s.cardSales.count;

  return (
    <VStack gap={3}>
      <div>
        <div className="wb-sub">납부세액(가) 예상 · 카드발행공제·예정고지 전</div>
        <div className="wb-big">{s.payable < 0 ? `환급 ${num(-s.payable)}` : num(s.payable)}원</div>
        <div className="wb-sub">
          매입 {confirmedPurchases}/{purchaseTotal}건 확정
        </div>
      </div>

      <section className="wb-sec">
        <h5>매출세액</h5>
        <Row k="세금계산서 발급분" v={s.salesInvoice.vat} sub={`${s.salesInvoice.count}건`} />
        <Row k="신용카드·현금영수증 발행분" v={s.cardSales.vat} sub={`${s.cardSales.count}개월`} />
        <Row k="합계" v={s.outputVat} strong />
      </section>

      <section className="wb-sec">
        <h5>공제받는 매입세액</h5>
        <Row k="세금계산서 수취분" v={s.purchaseInvoiceDeduct.vat} sub={`${s.purchaseInvoiceDeduct.count}건`} />
        <Row k="신용카드매출전표 등 수령분" v={s.cardPurchaseDeduct.vat} sub={`${s.cardPurchaseDeduct.count}건`} />
        <Row k="합계" v={s.inputVat} strong />
      </section>

      <section className="wb-sec">
        <h5>공제 안 되는 매입세액</h5>
        {s.nonDeductByReason.length === 0 && <div className="wb-sub">없음</div>}
        {s.nonDeductByReason.map((r) => (
          <Row key={r.reasonCode} k={r.label} v={r.vat} sub={`${r.count}건`} />
        ))}
        <div className="wb-sub" style={{ marginTop: 4 }}>카드 불공제분은 신고서 공제란에 넣지 않고, 세금계산서 불공제분은 별도 명세로 냅니다.</div>
      </section>

      {(s.bank.count > 0 || s.cardStatementDuplicates > 0) && (
        <section className="wb-sec">
          <h5>계좌·카드 명세서 정리 (신고서 숫자에는 안 들어감)</h5>
          {s.bank.count > 0 && (
            <>
              <Line k="카드대금으로 맞춤" v={`${s.bank.cardPayment}건`} />
              <Line k="세금계산서 대금으로 맞춤" v={`${s.bank.invoicePaid}건`} />
              <Line k="세금·보험료·인건비" v={`${s.bank.notVat}건`} />
              <Line k="증빙 요청 필요" v={`${s.bank.noEvidence.count}건 · ${num(s.bank.noEvidence.amount)}원`} warn={s.bank.noEvidence.count > 0} />
              {s.bank.other > 0 && <Line k="개인 지출 등 확인" v={`${s.bank.other}건`} />}
            </>
          )}
          {s.cardStatementDuplicates > 0 && <Line k="카드 명세서 중 홈택스와 중복" v={`${s.cardStatementDuplicates}건 제외`} />}
          {s.bank.noEvidence.count > 0 && <div className="wb-sub" style={{ marginTop: 4 }}>내보낸 Excel의 "증빙요청" 시트를 고객에게 보내면 됩니다.</div>}
        </section>
      )}

      {s.totals.pending > 0 && <div className="wb-warn">미확정 {s.totals.pending}건이 포함된 예상치입니다.</div>}
      {err && <Banner status="error" title={err} collapsible={false} isDismissable onDismiss={() => setErr(null)} />}

      <VStack gap={2}>
        <Button label="검토 결과 Excel 내보내기" href={`/api/filings/${filingId}/export.xlsx`} width="100%" />
        {status === 'READY' ? (
          <div className="wb-sec">신고 준비 완료 — 홈택스 신고서 작성에 이 요약을 쓰면 됩니다.</div>
        ) : (
          <Button
            variant="primary"
            width="100%"
            label="신고 준비 완료"
            isDisabled={user.role !== 'reviewer' || s.totals.pending > 0}
            tooltip={user.role !== 'reviewer' ? '검토 세무사만 완료할 수 있습니다' : s.totals.pending > 0 ? `미확정 ${s.totals.pending}건을 먼저 확정하세요` : undefined}
            clickAction={async () => {
              try {
                await gql(`mutation($f:Int!){ markReady(filingId:$f){ status } }`, { f: filingId });
              } catch (e) {
                setErr((e as Error).message);
              }
              onChanged();
            }}
          />
        )}
      </VStack>
    </VStack>
  );
}

function Row({ k, v, sub, strong }: { k: string; v: number; sub?: string; strong?: boolean }) {
  return (
    <div className={`wb-sum-row${strong ? ' wb-sum-total' : ''}`}>
      <span>
        {k} {sub && <span className="wb-sub">{sub}</span>}
      </span>
      <span>{num(v)}</span>
    </div>
  );
}

function Line({ k, v, warn }: { k: string; v: string; warn?: boolean }) {
  return (
    <div className="wb-sum-row">
      <span>{k}</span>
      <span className={warn ? 'wb-warn' : undefined}>{v}</span>
    </div>
  );
}
