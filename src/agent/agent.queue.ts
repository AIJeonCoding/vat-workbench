import { EntityManager } from '@mikro-orm/postgresql';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { EventBus } from '../common/events';
import { Filing, Txn } from '../domain/entities';
import { proposalSchema, type Proposal } from '../domain/schemas';
import { audit } from '../review/audit';
import { llmConfigFromEnv, llmHealthy, openAiChat, type ChatFn, type LlmConfig } from './llm';
import { describeTools, runLoop } from './loop';
import { buildTools } from './tools';

export const AGENT_ACTOR = 'agent:qwen';
export const CHAT_FN = 'CHAT_FN';

const SYSTEM = (toolsDoc: string) => `당신은 세무사 사무실의 부가세 검토 보조 Agent입니다.
소상공인 고객의 카드 매입 한 건이 매입세액 공제 대상인지 판단해 "제안"합니다. 최종 확정은 사람이 합니다.

규칙
- 한 번에 도구 하나만 XML 태그로 호출합니다. 결과를 받은 뒤 다음 단계를 정합니다.
- 보통 get_transaction → find_prior_decisions → (필요하면 list_counterparty_history, search_law) → attempt_completion 순서면 충분합니다.
- 이전 사람 판단이 있으면 그것을 가장 강한 근거로 씁니다.
- 확신이 없으면 confidence를 낮게(0.5 이하) 주고, explanation에 사람이 확인할 점을 적습니다.
- 답변은 도구 태그만 씁니다. 다른 설명은 쓰지 않습니다.
- explanation은 한국어(한글)로만 씁니다. 한자·중국어를 섞지 않습니다.
- 일반음식점 소액 평일 점심은 직원 식대일 가능성이 높습니다. 금액·요일·반복성을 보고 판단합니다.

reason_code
- BUSINESS: 본업과 관련된 정상 매입(공제)
- ENTERTAINMENT: 거래처 접대·선물(불공제, 제39조 제1항 제6호)
- NOT_BUSINESS: 가사·개인 지출(불공제, 제39조 제1항 제4호)
- VEHICLE_PASSENGER / VEHICLE_OK: 차량 유지비
- 직원 회식·복리후생은 접대가 아니라 BUSINESS입니다.

# 도구
${toolsDoc}

## attempt_completion
판단을 마치고 제안을 제출합니다.
- decision: DEDUCT 또는 NON_DEDUCT
- reason_code: 위 목록 중 하나
- law_ref: 근거 조문
- explanation: 사람이 읽을 이유 한두 문장(확인할 점 포함)
- confidence: 0~1
사용법:
<attempt_completion>
<decision>NON_DEDUCT</decision>
<reason_code>ENTERTAINMENT</reason_code>
<law_ref>부가가치세법 제39조 제1항 제6호</law_ref>
<explanation>...</explanation>
<confidence>0.7</confidence>
</attempt_completion>`;

/**
 * AI 제안 대기열. 로컬 LLM은 한 번에 한 요청씩 처리하므로 순서대로 돈다.
 * LLM이 꺼져 있거나 실패·타임아웃이면 해당 건은 "검토 필요"로 넘기고 다음 건으로 간다 — 업무는 멈추지 않는다.
 */
@Injectable()
export class AgentQueue {
  private readonly log = new Logger('Agent');
  private readonly queue: { filingId: number; txnId: number }[] = [];
  private running = false;
  private readonly cfg: LlmConfig;
  private readonly chat: ChatFn;
  current: { txnId: number; startedAt: number } | null = null;

  constructor(
    private readonly em: EntityManager,
    private readonly events: EventBus,
    @Optional() @Inject(CHAT_FN) chat?: ChatFn,
  ) {
    this.cfg = llmConfigFromEnv();
    this.chat = chat ?? openAiChat(this.cfg);
  }

  get pending() {
    return this.queue.length + (this.current ? 1 : 0);
  }

  get model() {
    return this.cfg.model;
  }

  /** 한 번 묻고 답만 받는 호출(파일 열 연결 추측 등). AI가 꺼져 있거나 실패하면 null — 호출한 쪽은 사전 추측만 쓴다. */
  async ask(prompt: string, system = '당신은 세무사 사무실의 자료 정리 보조입니다. 요청한 형식으로만 답합니다.'): Promise<string | null> {
    if (this.cfg.baseUrl === 'off') return null;
    if (process.env.LLM_SKIP_HEALTH !== '1' && !(await llmHealthy(this.cfg))) return null;
    try {
      return await this.chat([
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ]);
    } catch (e) {
      this.log.warn(`ask: ${(e as Error).message}`);
      return null;
    }
  }

  enqueue(filingId: number, txnIds: number[]) {
    for (const txnId of txnIds) this.queue.push({ filingId, txnId });
    void this.drain();
  }

  /** 테스트용: 대기열이 빌 때까지 기다린다 */
  async idle(timeoutMs = 60_000) {
    const until = Date.now() + timeoutMs;
    while ((this.running || this.queue.length) && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
  }

  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      const healthy = this.cfg.baseUrl !== 'off' && (process.env.LLM_SKIP_HEALTH === '1' || (await llmHealthy(this.cfg)));
      while (this.queue.length) {
        const job = this.queue.shift()!;
        if (!healthy) {
          await this.fallback(job.txnId, 'AI 서버에 연결할 수 없어 직접 판단이 필요합니다.');
          continue;
        }
        await this.process(job.filingId, job.txnId);
      }
    } finally {
      this.running = false;
      this.current = null;
    }
  }

  private async process(filingId: number, txnId: number) {
    const em = this.em.fork();
    const t = await em.findOne(Txn, txnId);
    if (!t || t.status !== 'NEEDS_AI') return;
    const filing = await em.findOneOrFail(Filing, filingId);
    this.current = { txnId, startedAt: Date.now() };
    const tools = buildTools(em.fork(), { filingId, clientId: filing.clientId, txnId });
    const started = Date.now();
    try {
      const r = await runLoop<Proposal>({
        chat: this.chat,
        system: SYSTEM(describeTools(tools)),
        task: `거래ID ${txnId}를 검토해 공제 여부를 제안하세요.`,
        tools,
        completion: { name: 'attempt_completion', schema: proposalSchema },
        maxTurns: 7,
        onStep: (s) => this.events.emit({ type: 'agentStep', filingId, txnId, tool: s.tool, summary: s.summary }),
      });
      if (!r.result) {
        await this.fallback(txnId, `AI가 결론을 내지 못했습니다(${r.error}).`, r.steps);
        return;
      }
      const ms = Date.now() - started;
      const fresh = await em.findOneOrFail(Txn, txnId, { refresh: true });
      if (fresh.status !== 'NEEDS_AI') return; // 그사이 사람이 먼저 확정함
      fresh.ai = {
        decision: r.result.decision,
        reasonCode: r.result.reason_code,
        lawRef: r.result.law_ref,
        explanation: r.result.explanation,
        confidence: r.result.confidence,
        steps: r.steps,
        model: this.cfg.model,
        ms,
      };
      fresh.status = r.result.confidence < 0.5 ? 'NEEDS_REVIEW' : 'SUGGESTED';
      audit(em, AGENT_ACTOR, 'txn', txnId, 'SUGGESTED', null, { ai: fresh.ai });
      await em.flush();
      this.emit(filingId, txnId);
    } catch (e) {
      this.log.warn(`txn ${txnId}: ${(e as Error).message}`);
      await this.fallback(txnId, `AI 응답 실패(${(e as Error).name === 'AbortError' ? '시간 초과' : (e as Error).message}) — 직접 판단해 주세요.`);
    } finally {
      this.current = null;
    }
  }

  private async fallback(txnId: number, why: string, steps: { tool: string; summary: string }[] = []) {
    const em = this.em.fork();
    const t = await em.findOne(Txn, txnId);
    if (!t || t.status !== 'NEEDS_AI') return;
    t.status = 'NEEDS_REVIEW';
    audit(em, AGENT_ACTOR, 'txn', txnId, 'AGENT_SKIPPED', null, { why, steps });
    t.hint = why;
    await em.flush();
    this.emit(t.filingId, txnId);
  }

  private emit(filingId: number, txnId: number) {
    this.events.emit({ type: 'txn', filingId, txnId });
    this.events.emit({ type: 'summary', filingId });
  }
}

