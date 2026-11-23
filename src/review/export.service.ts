import ExcelJS from 'exceljs';
import { Injectable } from '@nestjs/common';
import { KIND_LABEL } from '../files/parse';
import { REASON_LABEL } from '../rules/law';
import type { Actor } from '../domain/schemas';
import { ReviewService } from './review.service';
import { effective } from './summary';

const STATUS_LABEL: Record<string, string> = {
  RULED: '규칙 판정(미확정)',
  NEEDS_AI: 'AI 대기',
  SUGGESTED: 'AI 제안(미확정)',
  NEEDS_REVIEW: '검토 필요',
  CONFIRMED: '확정',
  MATCHED: '대사 정리(중복·대금)',
};

const reasonByLabel = Object.fromEntries(Object.entries(REASON_LABEL).map(([k, v]) => [v, k]));

@Injectable()
export class ExportService {
  constructor(private readonly review: ReviewService) {}

  /**
   * 검토 결과 + 신고서 요약을 Excel로. 고객·검토자가 "판정"·"메모" 칸을 고쳐 다시 올리면
   * 거래ID 기준으로 차이만 계산해 보여 준다(손실 없는 왕복).
   */
  async exportXlsx(filingId: number): Promise<Buffer> {
    const { client, filing } = await this.review.filing(filingId);
    const txns = await this.review.txns(filingId);
    const s = await this.review.summary(filingId);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'vat-workbench';
    const ws = wb.addWorksheet('검토결과', { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = [
      { header: '거래ID', key: 'id', width: 8 },
      { header: '일자', key: 'date', width: 11 },
      { header: '구분', key: 'kind', width: 14 },
      { header: '거래처', key: 'cp', width: 22 },
      { header: '사업자번호', key: 'brn', width: 13 },
      { header: '업종', key: 'industry', width: 14 },
      { header: '공급가액', key: 'supply', width: 12, style: { numFmt: '#,##0' } },
      { header: '세액', key: 'vat', width: 10, style: { numFmt: '#,##0' } },
      { header: '판정', key: 'decision', width: 8 },
      { header: '사유', key: 'reason', width: 18 },
      { header: '근거', key: 'law', width: 30 },
      { header: '설명', key: 'exp', width: 50 },
      { header: '상태', key: 'status', width: 14 },
      { header: '확정자', key: 'by', width: 8 },
      { header: '메모', key: 'note', width: 30 },
    ];
    ws.getRow(1).font = { bold: true };
    for (const t of txns) {
      if (t.status === 'MATCHED') continue; // 다른 자료와 같은 거래 — 아래 "대사" 시트에서 따로 보여 줌
      const isSales = t.kind === 'SALES_INVOICE' || t.kind === 'CARD_SALES';
      const j = effective(t);
      ws.addRow({
        id: t.id,
        date: t.date,
        kind: KIND_LABEL[t.kind],
        cp: t.counterparty,
        brn: t.counterpartyBrn ?? '',
        industry: t.industry ?? '',
        supply: t.supplyAmount,
        vat: t.vat,
        decision: isSales ? '매출' : j ? (j.decision === 'DEDUCT' ? '공제' : '불공제') : '미판정',
        reason: isSales ? '' : j ? REASON_LABEL[j.reasonCode] : '',
        law: isSales ? '' : (j?.lawRef ?? ''),
        exp: isSales ? '' : (j?.explanation ?? t.hint ?? ''),
        status: STATUS_LABEL[t.status],
        by: t.final?.decidedBy ?? '',
        note: t.final?.note ?? '',
      });
    }

    const sum = wb.addWorksheet('신고서요약');
    sum.columns = [
      { header: '항목', key: 'k', width: 40 },
      { header: '공급가액', key: 'supply', width: 16, style: { numFmt: '#,##0' } },
      { header: '세액', key: 'vat', width: 16, style: { numFmt: '#,##0' } },
    ];
    sum.getRow(1).font = { bold: true };
    sum.addRows([
      { k: `${client.name} · ${filing.period.replace('-', '년 제')}기` },
      { k: '매출 — 세금계산서 발급분', supply: s.salesInvoice.supply, vat: s.salesInvoice.vat },
      { k: '매출 — 신용카드·현금영수증 발행분', supply: s.cardSales.supply, vat: s.cardSales.vat },
      { k: '매출세액 합계', vat: s.outputVat },
      { k: '매입 — 세금계산서 수취분(공제)', supply: s.purchaseInvoiceDeduct.supply, vat: s.purchaseInvoiceDeduct.vat },
      { k: '매입 — 신용카드매출전표 등 수령분(공제)', supply: s.cardPurchaseDeduct.supply, vat: s.cardPurchaseDeduct.vat },
      { k: '공제받는 매입세액 합계', vat: s.inputVat },
      { k: '공제받지 못할 매입세액(세금계산서)', vat: s.invoiceNonDeduct.vat },
      { k: '카드 매입 불공제(신고서 미반영)', vat: s.cardNonDeduct.vat },
      { k: '납부(환급)세액', vat: s.payable },
      { k: `미확정 ${s.totals.pending}건 포함 — 확정 전 수치입니다` },
    ]);

    // 고객에게 보낼 증빙 요청 목록: 계좌이체만 있고 세금계산서·카드전표가 없는 출금
    const ask = wb.addWorksheet('증빙요청');
    ask.columns = [
      { header: '거래일', key: 'date', width: 11 },
      { header: '받는 분·내용', key: 'cp', width: 28 },
      { header: '적요', key: 'memo', width: 14 },
      { header: '금액', key: 'amt', width: 14, style: { numFmt: '#,##0' } },
      { header: '요청 내용', key: 'req', width: 50 },
      { header: '고객 답변', key: 'answer', width: 30 },
    ];
    ask.getRow(1).font = { bold: true };
    for (const t of txns.filter((x) => x.kind === 'BANK_OUT' && x.status !== 'MATCHED' && effective(x)?.reasonCode === 'NO_EVIDENCE')) {
      ask.addRow({ date: t.date, cp: t.counterparty, memo: t.memo ?? '', amt: t.supplyAmount, req: '사업 관련이면 세금계산서(또는 카드전표) 사본을 보내 주세요. 개인 지출이면 "개인"이라고 적어 주세요.' });
    }

    const rec = wb.addWorksheet('대사');
    rec.columns = [
      { header: '거래ID', key: 'id', width: 8 },
      { header: '일자', key: 'date', width: 11 },
      { header: '구분', key: 'kind', width: 14 },
      { header: '거래처', key: 'cp', width: 24 },
      { header: '금액', key: 'amt', width: 14, style: { numFmt: '#,##0' } },
      { header: '정리 내용', key: 'why', width: 60 },
      { header: '맞춘 거래ID', key: 'linked', width: 12 },
    ];
    rec.getRow(1).font = { bold: true };
    for (const t of txns.filter((x) => x.status === 'MATCHED')) {
      rec.addRow({ id: t.id, date: t.date, kind: KIND_LABEL[t.kind], cp: t.counterparty, amt: t.supplyAmount + t.vat, why: t.hint ?? '', linked: t.linkedTxnId ?? '' });
    }
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  /** 재업로드 차이를 확인한 뒤 반영(사람 확정과 같은 경로·감사이력) */
  async applyReviewDiff(actor: Actor, changes: { txnId: number; after: string; reason?: string; note?: string }[]) {
    let applied = 0;
    const failed: { txnId: number; message: string }[] = [];
    for (const c of changes) {
      try {
        const t = await this.review.txn(c.txnId);
        const decision = c.after === '공제' ? 'DEDUCT' : 'NON_DEDUCT';
        const reasonCode = (c.reason && reasonByLabel[c.reason]) || (decision === 'DEDUCT' ? 'BUSINESS' : 'NOT_BUSINESS');
        await this.review.confirm(actor, {
          txnId: t.id,
          expectedVersion: t.version,
          decision,
          reasonCode: reasonCode as never,
          note: c.note || '수정 파일 재업로드로 반영',
        });
        applied++;
      } catch (e) {
        failed.push({ txnId: c.txnId, message: (e as Error).message });
      }
    }
    return { applied, failed };
  }
}
