import ExcelJS from 'exceljs';
import type { FileKind } from '../domain/entities';
import { isPdf, readPdfTable } from './pdf';

export interface ParsedRow {
  externalKey: string;
  date: string;
  counterparty: string;
  counterpartyBrn?: string;
  counterpartyTaxType?: 'GENERAL' | 'SIMPLIFIED' | 'EXEMPT';
  industry?: string;
  supplyAmount: number;
  vat: number;
  sourceRow?: number;
}

export interface ParseError {
  row: number;
  message: string;
}

export interface ParsedFile {
  kind: Exclude<FileKind, 'BANK' | 'CARD_STATEMENT'> | 'REVIEW_EXPORT';
  /** 홈택스 양식이 아님 → 은행·카드사 명세서 읽기(statement.ts)로 넘긴다 */
  unknown?: boolean;
  rows: ParsedRow[];
  errors: ParseError[];
  /** REVIEW_EXPORT일 때 거래ID → 판정 */
  reviewRows?: { txnId: number; decision: string; reason: string; note: string; row: number }[];
}

/** 홈택스 내려받기 양식을 단순화한 헤더 규칙. 첫 줄 헤더 이름으로 파일 종류를 알아낸다. */
const SIGNATURES: { kind: ParsedFile['kind']; must: string[] }[] = [
  { kind: 'REVIEW_EXPORT', must: ['거래id', '판정'] },
  { kind: 'CARD_PURCHASE', must: ['가맹점명', '승인번호', '공급가액'] },
  { kind: 'CARD_SALES', must: ['카드매출', '승인일자'] },
  { kind: 'PURCHASE_INVOICE', must: ['공급자상호', '승인번호'] },
  { kind: 'SALES_INVOICE', must: ['공급받는자상호', '승인번호'] },
];

export const KIND_LABEL: Record<string, string> = {
  BANK: '은행 거래내역',
  BANK_OUT: '계좌 출금',
  CARD_STATEMENT: '카드사 이용내역',
  CARD_PURCHASE: '사업용 카드 매입',
  CARD_SALES: '카드 매출',
  PURCHASE_INVOICE: '매입 세금계산서',
  SALES_INVOICE: '매출 세금계산서',
  REVIEW_EXPORT: '검토 결과(재업로드)',
};

const norm = (s: unknown) => String(s ?? '').replace(/\s+/g, '').toLowerCase();

export function detectKind(headers: string[]): ParsedFile['kind'] | null {
  const hs = headers.map(norm);
  const hit = SIGNATURES.find((s) => s.must.every((m) => hs.some((h) => h.includes(norm(m)))));
  return hit?.kind ?? null;
}

function toDate(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v ?? '').trim();
  const m = s.match(/^(\d{4})[-./]?(\d{1,2})[-./]?(\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

function toInt(v: unknown): number | null {
  if (typeof v === 'number') return Math.round(v);
  const s = String(v ?? '').replace(/[,\s원]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Math.round(Number(s));
}

const brn = (v: unknown) => {
  const s = String(v ?? '').replace(/\D/g, '');
  return s.length === 10 ? s : undefined;
};

function taxType(v: unknown): ParsedRow['counterpartyTaxType'] {
  const s = String(v ?? '');
  if (s.includes('면세')) return 'EXEMPT';
  if (s.includes('간이')) return 'SIMPLIFIED';
  if (s.trim()) return 'GENERAL';
  return undefined;
}

/** 표(2차원 배열)를 파일 종류별 규칙으로 정규화한다. 잘못된 줄은 줄번호와 이유로 모은다. */
export function parseTable(table: unknown[][]): ParsedFile {
  const headerIdx = table.findIndex((r) => r.filter((c) => String(c ?? '').trim()).length >= 3);
  if (headerIdx < 0) return { kind: 'CARD_PURCHASE', rows: [], errors: [{ row: 1, message: '헤더 줄을 찾지 못했습니다' }] };
  const headers = table[headerIdx].map((c) => String(c ?? '').trim());
  const kind = detectKind(headers);
  if (!kind) {
    return { kind: 'CARD_PURCHASE', unknown: true, rows: [], errors: [{ row: headerIdx + 1, message: `알 수 없는 양식입니다(헤더: ${headers.filter(Boolean).join(', ')})` }] };
  }
  const col = (...names: string[]) => headers.findIndex((h) => names.some((n) => norm(h).includes(norm(n))));
  const rows: ParsedRow[] = [];
  const errors: ParseError[] = [];
  const reviewRows: NonNullable<ParsedFile['reviewRows']> = [];

  for (let i = headerIdx + 1; i < table.length; i++) {
    const r = table[i];
    const line = i + 1;
    if (!r || r.every((c) => !String(c ?? '').trim())) continue;
    const get = (idx: number) => (idx >= 0 ? r[idx] : undefined);

    if (kind === 'REVIEW_EXPORT') {
      const id = toInt(get(col('거래id')));
      if (!id) {
        errors.push({ row: line, message: '거래ID가 없습니다' });
        continue;
      }
      reviewRows.push({
        txnId: id,
        decision: String(get(col('판정')) ?? '').trim(),
        reason: String(get(col('사유')) ?? '').trim(),
        note: String(get(col('메모')) ?? '').trim(),
        row: line,
      });
      continue;
    }

    const date = toDate(get(col('승인일자', '작성일자', '일자')));
    let supply = toInt(get(col('공급가액')));
    let vat = toInt(get(col('부가세', '세액')));
    const total = toInt(get(col('합계', '카드매출')));

    if (kind === 'CARD_SALES' && total !== null && (supply === null || vat === null)) {
      supply = Math.round(total / 1.1);
      vat = total - supply;
    }
    const key = String(get(col('승인번호')) ?? '').trim() || (kind === 'CARD_SALES' ? `${date}-${i}` : '');

    const problems: string[] = [];
    if (!date) problems.push('날짜 형식이 맞지 않습니다');
    if (supply === null) problems.push('공급가액이 숫자가 아닙니다');
    if (vat === null) problems.push('세액이 숫자가 아닙니다');
    if (!key) problems.push('승인번호가 없습니다');
    if (supply !== null && vat !== null && total !== null && kind !== 'CARD_SALES' && supply + vat !== total) {
      problems.push(`공급가액+세액(${supply + vat})이 합계(${total})와 다릅니다`);
    }
    if (problems.length) {
      errors.push({ row: line, message: problems.join(', ') });
      continue;
    }

    const counterpartyCol =
      kind === 'CARD_PURCHASE' ? col('가맹점명') : kind === 'PURCHASE_INVOICE' ? col('공급자상호') : kind === 'SALES_INVOICE' ? col('공급받는자상호') : -1;
    const brnCol =
      kind === 'CARD_PURCHASE' ? col('가맹점사업자') : kind === 'PURCHASE_INVOICE' ? col('공급자사업자') : kind === 'SALES_INVOICE' ? col('공급받는자사업자') : -1;

    rows.push({
      externalKey: `${kind}:${key}`,
      date: date!,
      counterparty: counterpartyCol >= 0 ? String(get(counterpartyCol) ?? '').trim() : '카드 매출',
      counterpartyBrn: brn(get(brnCol)),
      counterpartyTaxType: kind === 'CARD_PURCHASE' ? taxType(get(col('과세유형'))) : 'GENERAL',
      industry: String(get(col('업종', '품목')) ?? '').trim() || undefined,
      supplyAmount: supply!,
      vat: vat!,
      sourceRow: line,
    });
  }
  return { kind, rows, errors, reviewRows: kind === 'REVIEW_EXPORT' ? reviewRows : undefined };
}

function parseCsv(text: string): string[][] {
  return text
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .map((l) => {
      const out: string[] = [];
      let cur = '';
      let q = false;
      for (let i = 0; i < l.length; i++) {
        const ch = l[i];
        if (q) {
          if (ch === '"' && l[i + 1] === '"') {
            cur += '"';
            i++;
          } else if (ch === '"') q = false;
          else cur += ch;
        } else if (ch === '"') q = true;
        else if (ch === ',') {
          out.push(cur);
          cur = '';
        } else cur += ch;
      }
      out.push(cur);
      return out;
    });
}

/** 파일 바이트 → 표. PDF는 글자 좌표로 표를 만들고, xlsx는 첫 시트, 나머지는 CSV(UTF-8)로 본다. */
export async function readTable(filename: string, buf: Buffer): Promise<unknown[][]> {
  if (isPdf(buf)) return (await readPdfTable(buf)).table;
  const isXlsx = filename.toLowerCase().endsWith('.xlsx') || buf.subarray(0, 2).toString() === 'PK';
  if (!isXlsx) return parseCsv(buf.toString('utf8'));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  const table: unknown[][] = [];
  ws.eachRow({ includeEmpty: true }, (row, n) => {
    const vals = (row.values as unknown[]).slice(1).map((v) => {
      if (v && typeof v === 'object' && 'result' in (v as object)) return (v as { result: unknown }).result;
      if (v && typeof v === 'object' && 'text' in (v as object)) return (v as { text: unknown }).text;
      return v;
    });
    table[n - 1] = vals;
  });
  return table.map((r) => r ?? []);
}
