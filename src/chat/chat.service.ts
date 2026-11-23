import { Injectable } from '@nestjs/common';
import { AgentQueue } from '../agent/agent.queue';
import { ReviewService } from '../review/review.service';
import { checkLlmOutput, EXAMPLES, groundingContext, guard, INTRO, LLM_SYSTEM, route, type ChatReply } from './assistant';

/** 업무 대화: 가드 → 규칙 의도 → (AI 켜져 있으면) 자료 근거 답변. 쓰기는 하지 않는다. */
@Injectable()
export class ChatService {
  constructor(
    private readonly review: ReviewService,
    private readonly agent: AgentQueue,
  ) {}

  async answer(filingId: number, message: string): Promise<ChatReply> {
    const { client } = await this.review.filing(filingId);
    const txns = await this.review.txns(filingId);
    const g = guard(message, [...new Set(txns.map((t) => t.counterparty))]);
    if (!g.ok) return { route: g.route, reply: g.reply, suggestions: EXAMPLES.slice(0, 3) };

    const r = route(message, txns, client);
    if (r) return r;

    const ai = await this.agent.ask(`[자료]\n${groundingContext(message, txns)}\n\n[질문]\n${message.trim()}`, LLM_SYSTEM);
    if (ai) return { route: 'llm', reply: checkLlmOutput(ai) };
    return {
      route: 'fallback',
      reply: `지금은 AI 연결 없이 정해진 질문만 처리하고 있어요. 아래 예시처럼 물어봐 주세요.\n\n${INTRO.split('\n').slice(2, 8).join('\n')}`,
      suggestions: EXAMPLES,
    };
  }
}
