import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable, Logger } from '@nestjs/common';
import { AgentQueue } from '../agent/agent.queue';
import { describeTools, runLoop } from '../agent/loop';
import { ReviewService } from '../review/review.service';
import { EventBus } from '../common/events';
import { checkLlmOutput, EXAMPLES, groundingContext, guard, INTRO, LLM_SYSTEM, route, type ChatReply } from './assistant';
import { answerSchema, buildChatTools, LOOP_SYSTEM, type Answer } from './chat.tools';

/**
 * 업무 대화: 가드 → (자율 루프 | 규칙 의도) → 대체 답.
 * - 자율 루프: AI가 정의된 읽기 도구만 골라 여러 단계로 조사하고 answer로 답한다. 확정은 카드만.
 * - AI가 꺼져 있거나 루프가 실패하면 규칙 의도 처리로 떨어져 업무가 멈추지 않는다.
 */
@Injectable()
export class ChatService {
  private readonly log = new Logger('Chat');
  constructor(
    private readonly review: ReviewService,
    private readonly agent: AgentQueue,
    private readonly em: EntityManager,
    private readonly events: EventBus,
  ) {}

  async answer(filingId: number, message: string, mode: 'auto' | 'quick' = 'auto'): Promise<ChatReply> {
    const { client } = await this.review.filing(filingId);
    const txns = await this.review.txns(filingId);
    const g = guard(message, [...new Set(txns.map((t) => t.counterparty))]);
    if (!g.ok) return { route: g.route, reply: g.reply, suggestions: EXAMPLES.slice(0, 3) };

    const ruled = route(message, txns, client);
    if (ruled?.route === 'intro') return ruled;

    if (mode === 'auto' && (await this.agent.available())) {
      const looped = await this.loop(filingId, client, message);
      if (looped) return looped;
    }
    if (ruled) return ruled;

    const ai = await this.agent.ask(`[자료]\n${groundingContext(message, txns)}\n\n[질문]\n${message.trim()}`, LLM_SYSTEM);
    if (ai) return { route: 'llm', reply: checkLlmOutput(ai) };
    return {
      route: 'fallback',
      reply: `지금은 AI 연결 없이 정해진 질문만 처리하고 있어요. 아래 예시처럼 물어봐 주세요.\n\n${INTRO.split('\n').slice(2, 8).join('\n')}`,
      suggestions: EXAMPLES,
    };
  }

  private async loop(filingId: number, client: Parameters<typeof buildChatTools>[1]['client'], message: string): Promise<ChatReply | null> {
    const em = this.em.fork();
    const { tools, buildCard } = buildChatTools(em, { filingId, client });
    try {
      const r = await runLoop<Answer>({
        chat: this.agent.chatFn,
        system: LOOP_SYSTEM(describeTools(tools), client.name),
        task: message.trim(),
        tools,
        completion: { name: 'answer', schema: answerSchema },
        maxTurns: 8,
        wrapUpAt: 2,
        onStep: (s) => this.events.emit({ type: 'agentStep', filingId, txnId: 0, tool: s.tool, summary: s.summary }),
      });
      if (!r.result) {
        this.log.warn(`loop: ${r.error}`);
        return null;
      }
      const a = r.result;
      const reply: ChatReply = { route: 'loop', reply: checkLlmOutput(a.reply), steps: r.steps };
      // 확정 카드는 사용자가 확정을 요청했을 때만(모델이 임의로 카드를 만들지 못하게)
      if (a.confirm_ids.length && /확정|승인/.test(message)) {
        const card = await buildCard(a.confirm_ids, a.decision === 'SUGGESTED' ? undefined : a.decision, a.reason_code);
        if (typeof card === 'string') reply.reply += `\n\n${card}`;
        else reply.action = card;
      }
      return reply;
    } catch (e) {
      this.log.warn(`loop: ${(e as Error).message}`);
      return null;
    }
  }
}
