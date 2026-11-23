import { OptimisticLockError } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EventBus } from '../common/events';
import { AuditLog, Client, DecisionMemory, DONE_STATUSES, Filing, FilingStatus, SourceFile, Txn, type Judgement } from '../domain/entities';
import { AgentQueue } from '../agent/agent.queue';
import { applyRules } from '../rules/rules';
import type { Actor, BulkConfirmInput, ConfirmInput } from '../domain/schemas';
import { counterpartyKey } from '../files/ingest.service';
import { LAW_REF, REASON_LABEL } from '../rules/law';
import { audit } from './audit';
import { effective, summarize } from './summary';

const requireHuman = (actor: Actor) => {
  if (actor.role === 'agent') throw new ForbiddenException('확정은 사람만 할 수 있습니다(Agent는 제안까지)');
};

@Injectable()
export class ReviewService {
  constructor(
    private readonly em: EntityManager,
    private readonly events: EventBus,
    private readonly agent: AgentQueue,
  ) {}

  async filing(id: number) {
    const em = this.em.fork();
    const filing = await em.findOne(Filing, id);
    if (!filing) throw new NotFoundException();
    const client = await em.findOneOrFail(Client, filing.clientId);
    const files = await em.find(SourceFile, { filingId: id }, { orderBy: { id: 'asc' } });
    return { filing, client, files };
  }

  async txns(filingId: number) {
    return this.em.fork().find(Txn, { filingId }, { orderBy: { date: 'asc', id: 'asc' } });
  }

  async txn(id: number) {
    const t = await this.em.fork().findOne(Txn, id);
    if (!t) throw new NotFoundException();
    return t;
  }

  async summary(filingId: number) {
    return summarize(await this.txns(filingId));
  }

  async history(txnId: number) {
    return this.em.fork().find(AuditLog, { entity: 'txn', entityId: txnId }, { orderBy: { id: 'asc' } });
  }

  /**
   * 사람 확정. expectedVersion이 다르면(다른 사람이 먼저 바꿈) 409로 알려 화면이 최신 값을 다시 보여 주게 한다.
   * 확정한 판단은 같은 고객·가맹점의 다음 판단 근거(DecisionMemory)로 남는다.
   */
  async confirm(actor: Actor, input: ConfirmInput): Promise<Txn> {
    requireHuman(actor);
    const em = this.em.fork();
    try {
      const t = await em.transactional(async (tx) => {
        const t = await tx.findOne(Txn, input.txnId);
        if (!t) throw new NotFoundException();
        if (t.version !== input.expectedVersion) {
          throw new ConflictException(`다른 사용자가 먼저 수정했습니다(현재 v${t.version}). 화면을 새 값으로 갱신했어요.`);
        }
        if (t.kind === 'SALES_INVOICE' || t.kind === 'CARD_SALES') throw new ConflictException('매출 거래는 판정 대상이 아닙니다');
        if (t.status === 'MATCHED') throw new ConflictException('다른 자료와 같은 거래로 정리된 건입니다. 따로 반영하려면 먼저 "같은 거래 아님"으로 풀어 주세요');
        if (t.kind === 'BANK_OUT' && input.decision === 'DEDUCT') {
          throw new BadRequestException('계좌이체 기록만으로는 매입세액을 공제할 수 없습니다. 세금계산서를 받아 올려 주세요');
        }

        const base = effective(t);
        let j: Judgement;
        if (input.decision && input.reasonCode) {
          j = {
            decision: input.decision,
            reasonCode: input.reasonCode,
            lawRef: LAW_REF[input.reasonCode],
            explanation: input.note?.trim() || `${REASON_LABEL[input.reasonCode]}(담당자 판단)`,
          };
        } else if (base) {
          j = base.reasonCode ? { decision: base.decision, reasonCode: base.reasonCode, lawRef: base.lawRef, explanation: base.explanation } : base;
        } else {
          throw new ConflictException('제안이 없는 거래는 판정을 직접 골라야 합니다');
        }

        const before = { status: t.status, final: t.final ?? null };
        t.final = { ...j, decidedBy: actor.userId, decidedAt: new Date().toISOString(), note: input.note };
        t.status = 'CONFIRMED';
        audit(tx, actor, 'txn', t.id, input.decision ? 'OVERRIDDEN' : 'CONFIRMED', before, { final: t.final });
        await this.remember(tx, t, actor);
        return t;
      });
      this.emitTxn(t);
      return t;
    } catch (e) {
      if (e instanceof OptimisticLockError) throw new ConflictException('다른 사용자가 동시에 수정했습니다. 다시 시도해 주세요.');
      throw e;
    }
  }

  /** 여러 건을 현재 제안 그대로 확정(예: 규칙 판정 전체 승인, 같은 가맹점 일괄). 이미 확정된 건은 건너뛴다. */
  async bulkConfirm(actor: Actor, input: BulkConfirmInput) {
    requireHuman(actor);
    const em = this.em.fork();
    const changed = await em.transactional(async (tx) => {
      const txns = await tx.find(Txn, { id: { $in: input.txnIds }, filingId: input.filingId });
      const done: Txn[] = [];
      for (const t of txns) {
        if (DONE_STATUSES.includes(t.status)) continue;
        const j = effective(t);
        if (!j) continue;
        const before = { status: t.status };
        t.final = { ...j, decidedBy: actor.userId, decidedAt: new Date().toISOString() };
        t.status = 'CONFIRMED';
        audit(tx, actor, 'txn', t.id, 'CONFIRMED_BULK', before, { final: t.final });
        await this.remember(tx, t, actor);
        done.push(t);
      }
      return done;
    });
    for (const t of changed) this.events.emit({ type: 'txn', filingId: t.filingId, txnId: t.id });
    this.events.emit({ type: 'summary', filingId: input.filingId });
    return { confirmed: changed.length, skipped: input.txnIds.length - changed.length };
  }

  /** 확정한 판단을 같은 신고 건의 같은 가맹점 미확정 거래에 그대로 적용 */
  async applyToSameCounterparty(actor: Actor, txnId: number) {
    requireHuman(actor);
    const src = await this.txn(txnId);
    if (src.status !== 'CONFIRMED' || !src.final) throw new ConflictException('먼저 이 거래를 확정하세요');
    const others = await this.em.fork().find(Txn, {
      filingId: src.filingId,
      status: { $nin: DONE_STATUSES },
      kind: src.kind === 'BANK_OUT' ? 'BANK_OUT' : { $ne: 'BANK_OUT' },
      ...(src.counterpartyBrn ? { counterpartyBrn: src.counterpartyBrn } : { counterparty: src.counterparty }),
    });
    let n = 0;
    for (const o of others) {
      await this.confirm(actor, {
        txnId: o.id,
        expectedVersion: o.version,
        decision: src.final.decision,
        reasonCode: src.final.reasonCode,
        note: `같은 가맹점 일괄 적용(기준 거래 #${src.id})`,
      });
      n++;
    }
    return { applied: n };
  }

  /** 검토자만 신고 준비 완료 처리. 미확정 건이 있으면 막는다. */
  async markReady(actor: Actor, filingId: number) {
    if (actor.role !== 'reviewer') throw new ForbiddenException('신고 준비 완료는 검토 세무사만 할 수 있습니다');
    const em = this.em.fork();
    const pending = await em.count(Txn, { filingId, status: { $nin: DONE_STATUSES } });
    if (pending > 0) throw new ConflictException(`미확정 거래 ${pending}건이 남아 있습니다`);
    const f = await em.findOneOrFail(Filing, filingId);
    f.status = FilingStatus.READY;
    audit(em, actor, 'filing', filingId, 'READY');
    await em.flush();
    this.events.emit({ type: 'summary', filingId });
    return f;
  }

  /** 고객 요청 진행 상태(요청 전·요청함·답 받음). 여러 건을 한 번에 바꾼다. */
  async setRequestStatus(actor: Actor, filingId: number, txnIds: number[], status: 'todo' | 'sent' | 'answered') {
    requireHuman(actor);
    const em = this.em.fork();
    const list = await em.find(Txn, { id: { $in: txnIds }, filingId });
    const at = new Date().toISOString();
    for (const t of list) {
      const before = t.clientRequest ?? null;
      t.clientRequest = { status, by: actor.userId, at };
      audit(em, actor, 'txn', t.id, `REQUEST_${status.toUpperCase()}`, before, t.clientRequest);
    }
    await em.flush();
    for (const t of list) this.events.emit({ type: 'txn', filingId, txnId: t.id });
    return { updated: list.length };
  }

  /**
   * 대사 풀기: 자동으로 묶인 두 거래가 실제로는 다른 거래일 때. 다시 규칙 판정을 받고, 이후 자동으로 다시 묶지 않는다.
   */
  async unmatch(actor: Actor, txnId: number) {
    requireHuman(actor);
    const em = this.em.fork();
    const t = await em.findOne(Txn, txnId);
    if (!t) throw new NotFoundException();
    if (t.status !== 'MATCHED') throw new ConflictException('정리된(맞춰진) 거래가 아닙니다');
    const filing = await em.findOneOrFail(Filing, t.filingId);
    const client = await em.findOneOrFail(Client, filing.clientId);
    const before = { status: t.status, matchType: t.matchType, linkedTxnId: t.linkedTxnId };
    const { status, rule } = applyRules(t, client, { start: filing.periodStart, end: filing.periodEnd });
    Object.assign(t, { status, rule, matchType: 'UNMATCHED', linkedTxnId: null, hint: '담당자가 "같은 거래 아님"으로 풀었습니다' });
    audit(em, actor, 'txn', t.id, 'UNMATCHED', before, { status });
    await em.flush();
    if (status === 'NEEDS_AI') this.agent.enqueue(t.filingId, [t.id]);
    this.emitTxn(t);
    return t;
  }

  private async remember(tx: EntityManager, t: Txn, actor: Actor) {
    if (!t.final || t.kind === 'BANK_OUT') return;
    const filing = await tx.findOneOrFail(Filing, t.filingId);
    const key = counterpartyKey(t);
    const mem = await tx.findOne(DecisionMemory, { clientId: filing.clientId, counterpartyKey: key });
    const judgement = {
      decision: t.final.decision,
      reasonCode: t.final.reasonCode,
      lawRef: t.final.lawRef,
      explanation: t.final.explanation,
      note: t.final.note,
    };
    if (mem) {
      mem.judgement = judgement;
      mem.decidedBy = actor.userId;
      mem.decidedAt = new Date();
      mem.timesApplied += 1;
    } else {
      tx.create(DecisionMemory, {
        clientId: filing.clientId,
        counterpartyKey: key,
        counterparty: t.counterparty,
        judgement,
        decidedBy: actor.userId,
        decidedAt: new Date(),
        timesApplied: 1,
      });
    }
  }

  private emitTxn(t: Txn) {
    this.events.emit({ type: 'txn', filingId: t.filingId, txnId: t.id });
    this.events.emit({ type: 'summary', filingId: t.filingId });
  }
}
