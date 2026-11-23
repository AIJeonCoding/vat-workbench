export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type ChatFn = (messages: ChatMessage[]) => Promise<string>;

export interface LlmConfig {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxTokens: number;
}

export const llmConfigFromEnv = (): LlmConfig => ({
  baseUrl: process.env.LLM_URL ?? 'http://127.0.0.1:8080',
  model: process.env.LLM_MODEL ?? 'mlx-community/Qwen3.6-35B-A3B-4bit-DWQ',
  timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 45_000),
  maxTokens: Number(process.env.LLM_MAX_TOKENS ?? 700),
});

/** 추론 모델의 <think> 블록은 도구 호출 해석에서 뺀다. */
export const stripThinking = (s: string) => s.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^[\s\S]*?<\/think>/, '').trim();

/**
 * OpenAI 호환 /v1/chat/completions 호출(mlx_lm.server, vLLM 등).
 * 타임아웃이 지나면 예외 — 호출한 쪽이 "검토 필요"로 떨어뜨려 업무가 멈추지 않게 한다.
 */
export function openAiChat(cfg: LlmConfig): ChatFn {
  return async (messages) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
    try {
      const res = await fetch(`${cfg.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({
          model: cfg.model,
          messages,
          temperature: 0.1,
          max_tokens: cfg.maxTokens,
          chat_template_kwargs: { enable_thinking: false },
        }),
      });
      if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
      const body = (await res.json()) as { choices: { message: { content: string } }[] };
      return stripThinking(body.choices[0]?.message?.content ?? '');
    } finally {
      clearTimeout(timer);
    }
  };
}

export async function llmHealthy(cfg: LlmConfig): Promise<boolean> {
  if (cfg.baseUrl === 'off') return false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`${cfg.baseUrl}/v1/models`, { signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}
