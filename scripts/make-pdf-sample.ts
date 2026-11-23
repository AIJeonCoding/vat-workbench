/**
 * 시연용 PDF 명세서(가상): 은행 사이트에서 "PDF로 저장"한 거래내역처럼 2쪽짜리.
 * 위쪽 안내 줄, 쪽마다 반복되는 열 이름, 쪽 번호가 있어 표 추출을 제대로 시험한다.
 */
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import PDFDocument from 'pdfkit';

const out = join(__dirname, '..', 'samples');
mkdirSync(out, { recursive: true });
const FONT = '/System/Library/Fonts/Supplemental/AppleGothic.ttf';

const cols = [
  { h: '거래일자', x: 40, w: 70 },
  { h: '적요', x: 115, w: 60 },
  { h: '내용', x: 180, w: 140 },
  { h: '출금(원)', x: 325, w: 75, right: true },
  { h: '입금(원)', x: 405, w: 75, right: true },
  { h: '잔액(원)', x: 485, w: 80, right: true },
];
type R = [string, string, string, number, number];
const rows: R[] = [
  ['2026.01.15', '자동이체', '소상공인정책자금 이자', 84_000, 0],
  ['2026.01.25', '타행이체', '김앤리세무회계 기장료', 165_000, 0],
  ['2026.02.14', '카드결제', '삼성카드 결제대금', 812_000, 0],
  ['2026.02.20', '카드입금', '카드매출 정산', 0, 1_950_000],
  ['2026.02.25', '타행이체', '김앤리세무회계 기장료', 165_000, 0],
  ['2026.03.10', '타행이체', '베이킹팩토리 포장재', 187_000, 0],
  ['2026.03.14', '카드결제', '삼성카드 결제대금', 640_000, 0],
  ['2026.03.25', '타행이체', '김앤리세무회계 기장료', 165_000, 0],
  ['2026.04.15', '자동이체', '소상공인정책자금 이자', 84_000, 0],
  ['2026.04.25', '타행이체', '김앤리세무회계 기장료', 165_000, 0],
  ['2026.05.11', '자동이체', '화재보험료', 39_000, 0],
  ['2026.05.25', '타행이체', '김앤리세무회계 기장료', 165_000, 0],
  ['2026.06.14', '카드결제', '삼성카드 결제대금', 733_000, 0],
  ['2026.06.25', '타행이체', '김앤리세무회계 기장료', 165_000, 0],
];

const doc = new PDFDocument({ size: 'A4', margin: 40 });
doc.pipe(createWriteStream(join(out, '08_은행_거래내역_PDF_2026-1기(가상).pdf')));
doc.font(FONT);

const header = (page: number) => {
  doc.fontSize(14).text('입출금 거래내역', 40, 40);
  doc.fontSize(9).text(`계좌 000-000-000000(가상) · 예금주 동네 베이커리(가상) · 조회기간 2026.01.01~2026.06.30 · ${page}/2쪽`, 40, 62);
  doc.fontSize(9);
  for (const c of cols) doc.text(c.h, c.x, 90, { width: c.w, align: c.right ? 'right' : 'left' });
  doc.moveTo(40, 103).lineTo(565, 103).stroke();
};

let bal = 6_000_000;
let y = 110;
header(1);
rows.forEach(([d, memo, who, outAmt, inAmt], i) => {
  if (i === 8) {
    doc.fontSize(8).text('1 / 2', 290, 770);
    doc.addPage();
    doc.font(FONT);
    header(2);
    y = 110;
  }
  bal += inAmt - outAmt;
  const vals = [d, memo, who, outAmt ? outAmt.toLocaleString('ko-KR') : '', inAmt ? inAmt.toLocaleString('ko-KR') : '', bal.toLocaleString('ko-KR')];
  doc.fontSize(9);
  cols.forEach((c, k) => doc.text(vals[k], c.x, y, { width: c.w, align: c.right ? 'right' : 'left', lineBreak: false }));
  y += 18;
});
doc.fontSize(8).text('2 / 2', 290, 770);
doc.end();

// 스캔본 흉내: 글자 없이 그림(사각형)만 있는 PDF
const scan = new PDFDocument({ size: 'A4' });
scan.pipe(createWriteStream(join(out, '09_스캔본_명세서(가상).pdf')));
scan.rect(60, 80, 470, 600).fill('#dddddd');
scan.end();
console.log('samples/ 에 PDF 2개 생성');
