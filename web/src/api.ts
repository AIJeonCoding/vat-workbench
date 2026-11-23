import { createClient, type Client } from 'graphql-ws';

export type Role = 'preparer' | 'reviewer';
export interface User {
  userId: string;
  role: Role;
  name: string;
}
export const USERS: User[] = [
  { userId: 'kim', role: 'preparer', name: '김 담당자' },
  { userId: 'lee', role: 'reviewer', name: '이 세무사' },
];

let current: User = USERS[0];
export const setCurrentUser = (u: User) => (current = u);
const authHeaders = () => ({ 'x-user-id': current.userId, 'x-role': current.role });

export class GqlError extends Error {
  constructor(
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

export async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch('/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await res.json()) as { data?: T; errors?: { message: string; extensions?: { code?: string } }[] };
  if (body.errors?.length) throw new GqlError(body.errors[0].message, body.errors[0].extensions?.code);
  return body.data as T;
}

let ws: Client | null = null;
export function subscribeFiling(filingId: number, onEvent: (e: WorkbenchEvent) => void): () => void {
  ws ??= createClient({ url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/graphql` });
  return ws.subscribe<{ filingEvents: WorkbenchEvent }>(
    { query: 'subscription($f:Int!){ filingEvents(filingId:$f){ type filingId txnId tool summary } }', variables: { f: filingId } },
    { next: (m) => m.data && onEvent(m.data.filingEvents), error: () => {}, complete: () => {} },
  );
}

export async function uploadFile(filingId: number, file: File, mapping?: MappingInput): Promise<IngestResult> {
  const res = await fetch(`/api/filings/${filingId}/files`, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'x-filename': encodeURIComponent(file.name),
      ...(mapping ? { 'x-mapping': encodeURIComponent(JSON.stringify(mapping)) } : {}),
      ...authHeaders(),
    },
    body: await file.arrayBuffer(),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.message ?? '업로드 실패');
  return body as IngestResult;
}

export async function applyReviewDiff(filingId: number, changes: ReviewChange[]) {
  const res = await fetch(`/api/filings/${filingId}/review-diff`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ changes }),
  });
  return (await res.json()) as { applied: number; failed: { txnId: number; message: string }[] };
}

export interface WorkbenchEvent {
  type: 'txn' | 'summary' | 'agentStep' | 'file';
  filingId: number;
  txnId?: number | null;
  tool?: string | null;
  summary?: string | null;
}

export interface Judgement {
  decision: 'DEDUCT' | 'NON_DEDUCT';
  reasonCode: string;
  lawRef: string;
  explanation: string;
}
export interface Txn {
  id: number;
  kind: 'SALES_INVOICE' | 'PURCHASE_INVOICE' | 'CARD_PURCHASE' | 'CARD_SALES' | 'BANK_OUT' | 'CARD_STATEMENT';
  date: string;
  counterparty: string;
  counterpartyBrn?: string | null;
  counterpartyTaxType?: string | null;
  industry?: string | null;
  supplyAmount: number;
  vat: number;
  status: 'RULED' | 'NEEDS_AI' | 'SUGGESTED' | 'NEEDS_REVIEW' | 'CONFIRMED' | 'MATCHED';
  rule?: Judgement | null;
  ai?: (Judgement & { confidence: number; steps: { tool: string; summary: string }[]; model: string; ms: number }) | null;
  final?: (Judgement & { decidedBy: string; decidedAt: string; note?: string }) | null;
  hint?: string | null;
  memo?: string | null;
  sourceRow?: number | null;
  vatEstimated: boolean;
  matchType?: 'SAME_AS_HOMETAX_CARD' | 'CARD_PAYMENT' | 'INVOICE_PAID' | 'UNMATCHED' | null;
  linkedTxnId?: number | null;
  sourceFileId: number;
  version: number;
}
export interface FilingCard {
  id: number;
  period: string;
  status: string;
  clientName: string;
  industry: string;
  total: number;
  pending: number;
  needsReview: number;
}
export interface FilingDetail {
  id: number;
  period: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  client: { name: string; brn: string; industry: string; registeredAt: string; vehicles: { plate: string; model: string; kind: string }[] };
  files: { id: number; kind: string; filename: string; rowCount: number; uploadedBy: string; uploadedAt: string }[];
}
export interface Summary {
  salesInvoice: { supply: number; vat: number; count: number };
  cardSales: { supply: number; vat: number; count: number };
  outputVat: number;
  purchaseInvoiceDeduct: { supply: number; vat: number; count: number };
  cardPurchaseDeduct: { supply: number; vat: number; count: number };
  inputVat: number;
  invoiceNonDeduct: { vat: number; count: number };
  cardNonDeduct: { vat: number; count: number };
  nonDeductByReason: { reasonCode: string; label: string; vat: number; count: number }[];
  payable: number;
  totals: { all: number; confirmed: number; pending: number; needsReview: number; matched: number };
  bank: { count: number; cardPayment: number; invoicePaid: number; noEvidence: { count: number; amount: number }; notVat: number; other: number };
  cardStatementDuplicates: number;
}
export interface ReviewChange {
  txnId: number;
  counterparty: string;
  before: string;
  after: string;
  reason: string;
  note: string;
}
export interface IngestResult {
  fileId: number | null;
  filename: string;
  kind: string;
  kindLabel: string;
  duplicate: boolean;
  added: number;
  skippedExisting: number;
  errors: { row: number; message: string }[];
  reviewDiff?: ReviewChange[];
  needsMapping?: NeedsMapping;
  template?: { label: string; reused: boolean };
  matched?: number;
  skippedDeposits?: number;
  skippedCancels?: number;
}

export type StatementKind = 'BANK' | 'CARD_STATEMENT';
export interface FieldDef {
  key: string;
  label: string;
  required: boolean;
}
export interface NeedsMapping {
  kind: StatementKind;
  kindLabel: string;
  headers: string[];
  mapping: Record<string, string>;
  missing: string[];
  guessedBy: 'dictionary' | 'llm';
  samples: string[][];
  fields: Record<StatementKind, FieldDef[]>;
}
export interface MappingInput {
  kind: StatementKind;
  label: string;
  mapping: Record<string, string>;
}

export const TXN_FIELDS = 'id kind date counterparty counterpartyBrn counterpartyTaxType industry supplyAmount vat status rule ai final hint memo sourceRow vatEstimated matchType linkedTxnId sourceFileId version';
