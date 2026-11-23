import { Entity, Enum, Index, PrimaryKey, Property, Unique } from '@mikro-orm/core';

/** 차량 구분: 비영업용 소형승용차만 매입세액 불공제(부가가치세법 제39조 제1항 제5호) */
export type VehicleKind = 'PASSENGER' | 'LIGHT' | 'VAN9PLUS' | 'TRUCK';

export interface Vehicle {
  plate: string;
  model: string;
  kind: VehicleKind;
}

/** 고객사(세무 대리 대상 소상공인). 규칙 엔진이 업종·등록일·보유 차량을 참고한다. */
@Entity({ tableName: 'client' })
export class Client {
  @PrimaryKey({ type: 'integer', autoincrement: true })
  id!: number;

  @Property({ type: 'string' })
  name!: string;

  @Property({ type: 'string', length: 10 })
  brn!: string;

  /** 주업종(예: 제과점업) */
  @Property({ type: 'string' })
  industry!: string;

  /** 본업과 직접 관련된 매입 업종 키워드 — 규칙이 '일반 사업 매입'으로 바로 판정 */
  @Property({ type: 'json' })
  businessKeywords!: string[];

  @Property({ type: 'date' })
  registeredAt!: string;

  @Property({ type: 'json' })
  vehicles!: Vehicle[];
}

export enum FilingStatus {
  COLLECTING = 'COLLECTING',
  REVIEWING = 'REVIEWING',
  READY = 'READY',
}

/** 신고 건(고객 × 과세기간) */
@Entity({ tableName: 'filing' })
export class Filing {
  @PrimaryKey({ type: 'integer', autoincrement: true })
  id!: number;

  @Property({ type: 'integer' })
  clientId!: number;

  /** 예: 2026-1 (2026년 제1기) */
  @Property({ type: 'string' })
  period!: string;

  @Property({ type: 'date' })
  periodStart!: string;

  @Property({ type: 'date' })
  periodEnd!: string;

  @Enum({ items: () => FilingStatus, type: 'string' })
  status: FilingStatus = FilingStatus.COLLECTING;
}

export type FileKind = 'SALES_INVOICE' | 'PURCHASE_INVOICE' | 'CARD_PURCHASE' | 'CARD_SALES' | 'BANK' | 'CARD_STATEMENT';

/** 거래 한 줄의 출처. BANK_OUT(계좌 출금)은 증빙이 아니라 대사·증빙 요청용이다. */
export type TxnKind = 'SALES_INVOICE' | 'PURCHASE_INVOICE' | 'CARD_PURCHASE' | 'CARD_SALES' | 'BANK_OUT' | 'CARD_STATEMENT';

/**
 * 대사(맞춰 보기) 결과
 * - SAME_AS_HOMETAX_CARD: 카드사 명세서 줄이 홈택스 사업용카드 내역과 같은 거래 → 한 번만 반영
 * - CARD_PAYMENT: 계좌에서 나간 카드대금 → 개별 사용 내역은 카드 자료로 반영
 * - INVOICE_PAID: 계좌 출금이 받은 세금계산서 대금 → 세금계산서로 반영
 * - UNMATCHED: 담당자가 "같은 거래 아님"으로 풀어 둔 건(다시 묶지 않음)
 */
export type MatchType = 'SAME_AS_HOMETAX_CARD' | 'CARD_PAYMENT' | 'INVOICE_PAID' | 'UNMATCHED';

/** 고객이 준 원본 파일. 같은 신고 건에 같은 내용(해시)이 다시 오면 새로 만들지 않는다. */
@Entity({ tableName: 'source_file' })
@Unique({ properties: ['filingId', 'contentHash'] })
export class SourceFile {
  @PrimaryKey({ type: 'integer', autoincrement: true })
  id!: number;

  @Property({ type: 'integer' })
  filingId!: number;

  @Property({ type: 'string' })
  kind!: FileKind;

  @Property({ type: 'string' })
  filename!: string;

  @Property({ type: 'string', length: 64 })
  contentHash!: string;

  @Property({ type: 'integer' })
  rowCount!: number;

  @Property({ type: 'string' })
  uploadedBy!: string;

  @Property({ type: 'datetime' })
  uploadedAt: Date = new Date();
}

export type Decision = 'DEDUCT' | 'NON_DEDUCT';

export type ReasonCode =
  | 'BUSINESS' // 일반 사업 매입
  | 'VEHICLE_PASSENGER' // 비영업용 소형승용차(제5호)
  | 'VEHICLE_OK' // 경차·화물·9인승 이상
  | 'ENTERTAINMENT' // 기업업무추진비(제6호)
  | 'NOT_BUSINESS' // 사업과 직접 관련 없는 지출(제4호)
  | 'EXEMPT_SUPPLIER' // 면세 가맹점 — 매입세액 없음
  | 'SIMPLIFIED_SUPPLIER' // 영수증 발급 간이과세자
  | 'BEFORE_REGISTRATION' // 사업자등록 전 매입(제8호)
  | 'NO_VAT' // 세액 0
  | 'NO_EVIDENCE' // 계좌이체만 있고 적격증빙 없음 → 세금계산서 요청
  | 'NOT_VAT'; // 세금·사회보험료·인건비 등 부가세가 없는 지출

export interface Judgement {
  decision: Decision;
  reasonCode: ReasonCode;
  lawRef: string;
  explanation: string;
}

export interface AiSuggestion extends Judgement {
  confidence: number;
  steps: { tool: string; summary: string }[];
  model: string;
  ms: number;
}

/**
 * 판정 상태
 * - RULED: 규칙이 확실하게 판정(승인만 하면 됨)
 * - NEEDS_AI: AI 제안 대기
 * - SUGGESTED: AI가 제안함(사람 확인 필요)
 * - NEEDS_REVIEW: AI도 결론을 못 냄 / AI 사용 불가 → 사람이 직접
 * - CONFIRMED: 사람이 확정
 * - MATCHED: 다른 자료와 같은 거래로 맞춰져 따로 반영하지 않음(대사)
 */
export type TxnStatus = 'RULED' | 'NEEDS_AI' | 'SUGGESTED' | 'NEEDS_REVIEW' | 'CONFIRMED' | 'MATCHED';

/** 사람이 더 볼 필요 없는 상태(확정 또는 다른 자료와 맞춰져 정리됨) */
export const DONE_STATUSES: TxnStatus[] = ['CONFIRMED', 'MATCHED'];

/** 매입·매출 한 줄. 카드 매입이 검토의 중심이고, 세금계산서도 같은 파이프라인을 탄다. */
@Entity({ tableName: 'txn' })
@Index({ properties: ['filingId', 'status'] })
@Unique({ properties: ['filingId', 'externalKey'] })
export class Txn {
  @PrimaryKey({ type: 'integer', autoincrement: true })
  id!: number;

  @Property({ type: 'integer' })
  filingId!: number;

  @Property({ type: 'integer' })
  sourceFileId!: number;

  @Property({ type: 'string' })
  kind!: TxnKind;

  /** 원본에서 거래를 식별하는 키(승인번호·세금계산서 승인번호). 재업로드 차이 비교의 기준 */
  @Property({ type: 'string' })
  externalKey!: string;

  @Property({ type: 'date' })
  date!: string;

  @Property({ type: 'string' })
  counterparty!: string;

  @Property({ type: 'string', length: 10, nullable: true })
  counterpartyBrn?: string;

  /** 가맹점 과세유형: GENERAL | SIMPLIFIED | EXEMPT */
  @Property({ type: 'string', nullable: true })
  counterpartyTaxType?: string;

  @Property({ type: 'string', nullable: true })
  industry?: string;

  @Property({ type: 'integer' })
  supplyAmount!: number;

  @Property({ type: 'integer' })
  vat!: number;

  @Property({ type: 'string' })
  status!: TxnStatus;

  @Property({ type: 'json', nullable: true })
  rule?: Judgement | null;

  @Property({ type: 'json', nullable: true })
  ai?: AiSuggestion | null;

  /** 사람에게 보여 줄 확인 포인트(AI 실패 사유 등) */
  @Property({ type: 'string', nullable: true })
  hint?: string | null;

  @Property({ type: 'json', nullable: true })
  final?: (Judgement & { decidedBy: string; decidedAt: string; note?: string }) | null;

  /** 은행 적요·카드 구분 등 원본의 보조 설명 */
  @Property({ type: 'string', nullable: true })
  memo?: string | null;

  /** 원본 파일의 줄 번호(사람이 원본과 대조할 때) */
  @Property({ type: 'integer', nullable: true })
  sourceRow?: number | null;

  /** 카드사 명세서처럼 세액이 없는 자료에서 합계의 1/11로 추정했는지 */
  @Property({ type: 'boolean', default: false })
  vatEstimated: boolean = false;

  @Property({ type: 'string', nullable: true })
  matchType?: MatchType | null;

  /** 맞춰진 상대 거래 */
  @Property({ type: 'integer', nullable: true })
  linkedTxnId?: number | null;

  @Property({ type: 'integer', version: true })
  version: number = 1;
}

/** 담당자가 확인한 은행·카드사 파일의 열 연결. 같은 형식(열 이름 묶음)이 다시 오면 자동으로 쓴다. */
@Entity({ tableName: 'column_template' })
export class ColumnTemplate {
  @PrimaryKey({ type: 'integer', autoincrement: true })
  id!: number;

  @Property({ type: 'string', length: 40, unique: true })
  signature!: string;

  @Property({ type: 'string' })
  kind!: 'BANK' | 'CARD_STATEMENT';

  /** 예: 국민은행 거래내역 */
  @Property({ type: 'string' })
  label!: string;

  @Property({ type: 'json' })
  mapping!: Record<string, string>;

  @Property({ type: 'string' })
  createdBy!: string;

  @Property({ type: 'datetime' })
  createdAt: Date = new Date();

  @Property({ type: 'integer' })
  timesUsed: number = 0;
}

/** 사람의 판단 기억: 같은 고객·가맹점이 다시 나오면 다음 판단의 근거로 쓴다. */
@Entity({ tableName: 'decision_memory' })
@Unique({ properties: ['clientId', 'counterpartyKey'] })
export class DecisionMemory {
  @PrimaryKey({ type: 'integer', autoincrement: true })
  id!: number;

  @Property({ type: 'integer' })
  clientId!: number;

  /** 사업자번호가 있으면 번호, 없으면 가맹점명 */
  @Property({ type: 'string' })
  counterpartyKey!: string;

  @Property({ type: 'string' })
  counterparty!: string;

  @Property({ type: 'json' })
  judgement!: Judgement & { note?: string };

  @Property({ type: 'string' })
  decidedBy!: string;

  @Property({ type: 'datetime' })
  decidedAt: Date = new Date();

  @Property({ type: 'integer' })
  timesApplied: number = 1;
}

/** 감사이력(append-only). 사람·규칙·Agent 모두 같은 형식으로 남는다. */
@Entity({ tableName: 'audit_log' })
@Index({ properties: ['entity', 'entityId'] })
export class AuditLog {
  @PrimaryKey({ type: 'integer', autoincrement: true })
  id!: number;

  @Property({ type: 'string' })
  entity!: string;

  @Property({ type: 'integer' })
  entityId!: number;

  @Property({ type: 'string' })
  action!: string;

  @Property({ type: 'string' })
  actor!: string;

  @Property({ type: 'json', nullable: true })
  before?: unknown;

  @Property({ type: 'json', nullable: true })
  after?: unknown;

  @Property({ type: 'datetime' })
  at: Date = new Date();
}

export const ENTITIES = [Client, Filing, SourceFile, Txn, DecisionMemory, AuditLog, ColumnTemplate];
