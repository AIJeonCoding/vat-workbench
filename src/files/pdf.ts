import { findHeaderRow } from './statement';

/**
 * 글자가 들어 있는 PDF(은행·카드사에서 내려받은 명세서)를 표로 바꾼다.
 *
 * PDF에는 "표"가 없고 글자 조각과 좌표만 있다. 그래서
 *  1) 같은 높이(y)의 조각을 한 줄로 묶고,
 *  2) 줄 안에서 간격이 벌어진 곳을 칸 경계로 보고,
 *  3) 열 이름 줄(헤더)을 찾은 뒤, 아래 줄의 각 칸을 가운데 위치가 가장 가까운 열에 붙인다
 *     (숫자는 오른쪽 정렬, 글자는 왼쪽 정렬이라 시작점이 아니라 가운데로 맞춘다).
 * 이후는 엑셀과 똑같이 열 연결 확인 → 형식 저장 → 대사 흐름을 탄다.
 * 스캔 이미지 PDF는 글자 조각이 없으므로 OCR이 필요하다고 알려 준다.
 */
export class ScannedPdfError extends Error {
  constructor() {
    super('글자를 찾을 수 없는 PDF입니다(스캔 이미지로 보임). 은행·카드사 사이트에서 엑셀이나 글자 있는 PDF로 다시 받아 주세요. 스캔본 글자 인식은 아직 지원하지 않습니다.');
  }
}

interface Piece {
  str: string;
  x: number;
  y: number;
  w: number;
}

interface Cell {
  text: string;
  x0: number;
  x1: number;
}

export const isPdf = (buf: Buffer) => buf.subarray(0, 5).toString('latin1') === '%PDF-';

// pdfjs는 ESM 전용이라 CommonJS 빌드에서도 동적 import가 되도록 감싼다
const esmImport = new Function('s', 'return import(s)') as (s: string) => Promise<any>;

async function extractPieces(buf: Buffer): Promise<Piece[][]> {
  const spec = 'pdfjs-dist/legacy/build/pdf.mjs';
  // 빌드(CommonJS)에서는 진짜 동적 import, 테스트 러너(vitest)에서는 일반 import()가 동작한다
  const pdfjs = await esmImport(spec).catch(() => import(spec));
  const task = pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, isEvalSupported: false });
  const doc = await task.promise;
  const pages: Piece[][] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    pages.push(
      (content.items as { str: string; transform: number[]; width: number }[])
        .filter((it) => typeof it.str === 'string' && it.str.trim())
        .map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width })),
    );
  }
  await task.destroy();
  return pages;
}

/** 한 페이지의 조각 → 줄(위에서 아래) → 칸 */
function toRows(pieces: Piece[]): Cell[][] {
  const sorted = [...pieces].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Piece[][] = [];
  for (const pc of sorted) {
    const line = lines.find((l) => Math.abs(l[0].y - pc.y) <= 3);
    if (line) line.push(pc);
    else lines.push([pc]);
  }
  return lines.map((l) => {
    const ps = l.sort((a, b) => a.x - b.x);
    const cells: Cell[] = [];
    for (const pc of ps) {
      const last = cells[cells.length - 1];
      // 앞 조각 끝과 6pt 이내면 같은 칸(한 단어가 여러 조각으로 나뉘는 경우)
      if (last && pc.x - last.x1 < 6) {
        last.text += (pc.x - last.x1 > 1.5 ? ' ' : '') + pc.str;
        last.x1 = pc.x + pc.w;
      } else cells.push({ text: pc.str, x0: pc.x, x1: pc.x + pc.w });
    }
    return cells.map((c) => ({ ...c, text: c.text.trim() }));
  });
}

export interface PdfTable {
  table: string[][];
  pages: number;
}

export async function readPdfTable(buf: Buffer): Promise<PdfTable> {
  const pages = await extractPieces(buf);
  if (pages.every((p) => p.length === 0)) throw new ScannedPdfError();
  const rows = pages.flatMap(toRows);

  const headerIdx = findHeaderRow(rows.map((r) => r.map((c) => c.text)));
  if (headerIdx < 0) return { table: rows.map((r) => r.map((c) => c.text)), pages: pages.length };

  const header = rows[headerIdx];
  const centers = header.map((c) => (c.x0 + c.x1) / 2);
  const headerKey = header.map((c) => c.text).join('|');
  const table: string[][] = rows.slice(0, headerIdx).map((r) => r.map((c) => c.text));
  table.push(header.map((c) => c.text));

  for (const r of rows.slice(headerIdx + 1)) {
    // 페이지마다 반복되는 열 이름 줄은 건너뛴다
    if (r.map((c) => c.text).join('|') === headerKey) continue;
    const out: string[] = header.map(() => '');
    for (const c of r) {
      const mid = (c.x0 + c.x1) / 2;
      let best = 0;
      for (let i = 1; i < centers.length; i++) if (Math.abs(centers[i] - mid) < Math.abs(centers[best] - mid)) best = i;
      out[best] = out[best] ? `${out[best]} ${c.text}` : c.text;
    }
    table.push(out);
  }
  return { table, pages: pages.length };
}
