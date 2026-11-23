import type { ZodTypeAny, z } from 'zod';
import type { ChatFn, ChatMessage } from './llm';

/**
 * Tool 계약. Zod 스키마 하나로 인수 검증·설명·(필요하면) MCP 노출 스키마를 만든다.
 */
export interface Tool<S extends ZodTypeAny = ZodTypeAny> {
  name: string;
  description: string;
  params: Record<string, string>;
  schema: S;
  run(args: z.infer<S>): Promise<string>;
  /** 화면 진행 표시용 한 줄 요약 */
  summarize(args: z.infer<S>, result: string): string;
}

export interface LoopStep {
  tool: string;
  summary: string;
}

export interface LoopResult<T> {
  result?: T;
  steps: LoopStep[];
  turns: number;
  error?: string;
}

/**
 * Cline식 자율 루프.
 * 1) 모델이 매 턴 Tool 하나를 XML 태그로 고른다
 * 2) 코드가 인수를 Zod로 검증하고 실행해 결과를 다음 턴에 돌려준다
 * 3) 형식이 틀리면 실행하지 않고 오류 메시지를 돌려줘 스스로 고치게 한다
 * 4) attempt_completion이 검증을 통과하면 끝, 최대 턴을 넘으면 실패로 끝낸다
 * 되돌리기 어려운 Action은 Tool 목록에 넣지 않는다 — 이 루프는 '제안'까지만 한다.
 */
export async function runLoop<T>(opts: {
  chat: ChatFn;
  system: string;
  task: string;
  tools: Tool[];
  completion: { name: string; schema: ZodTypeAny };
  maxTurns: number;
  onStep?: (s: LoopStep) => void;
}): Promise<LoopResult<T>> {
  const messages: ChatMessage[] = [
    { role: 'system', content: opts.system },
    { role: 'user', content: opts.task },
  ];
  const steps: LoopStep[] = [];
  const names = [...opts.tools.map((t) => t.name), opts.completion.name];

  for (let turn = 1; turn <= opts.maxTurns; turn++) {
    const reply = await opts.chat(messages);
    messages.push({ role: 'assistant', content: reply });
    const call = parseToolCall(reply, names);

    if (!call) {
      messages.push({
        role: 'user',
        content: `[ERROR] 도구를 하나 호출하지 않았습니다. 사용할 수 있는 도구: ${names.join(', ')}. 형식: <도구이름><파라미터>값</파라미터></도구이름>`,
      });
      steps.push({ tool: 'format_error', summary: '도구 호출 형식 오류 → 다시 요청' });
      continue;
    }

    if (call.name === opts.completion.name) {
      const parsed = opts.completion.schema.safeParse(call.params);
      if (parsed.success) return { result: parsed.data as T, steps, turns: turn };
      messages.push({ role: 'user', content: `[ERROR] ${call.name} 인수 오류: ${issues(parsed.error)}. 고쳐서 다시 호출하세요.` });
      steps.push({ tool: 'format_error', summary: `제안 형식 오류 → 다시 요청` });
      continue;
    }

    const tool = opts.tools.find((t) => t.name === call.name)!;
    const args = tool.schema.safeParse(call.params);
    if (!args.success) {
      messages.push({ role: 'user', content: `[ERROR] ${tool.name} 인수 오류: ${issues(args.error)}` });
      continue;
    }
    let result: string;
    try {
      result = await tool.run(args.data);
    } catch (e) {
      result = `[ERROR] ${(e as Error).message}`;
    }
    const step = { tool: tool.name, summary: tool.summarize(args.data, result) };
    steps.push(step);
    opts.onStep?.(step);
    messages.push({ role: 'user', content: `[${tool.name} 결과]\n${result}` });
  }
  return { steps, turns: opts.maxTurns, error: `최대 ${opts.maxTurns}턴 안에 결론을 내지 못했습니다` };
}

const issues = (e: { issues: { path: (string | number)[]; message: string }[] }) =>
  e.issues.map((i) => `${i.path.join('.') || '(전체)'}: ${i.message}`).join('; ');

/** 응답에서 처음 나오는 도구 태그 하나를 찾아 <param>값</param>을 꺼낸다. */
export function parseToolCall(text: string, names: string[]): { name: string; params: Record<string, string> } | null {
  let best: { name: string; idx: number } | null = null;
  for (const n of names) {
    const idx = text.indexOf(`<${n}>`);
    if (idx >= 0 && (!best || idx < best.idx)) best = { name: n, idx };
  }
  if (!best) return null;
  const open = `<${best.name}>`;
  const end = text.indexOf(`</${best.name}>`, best.idx);
  const inner = text.slice(best.idx + open.length, end >= 0 ? end : undefined);
  const params: Record<string, string> = {};
  for (const m of inner.matchAll(/<([a-z_]+)>([\s\S]*?)<\/\1>/g)) params[m[1]] = m[2].trim();
  return { name: best.name, params };
}

/** 시스템 프롬프트용 도구 설명(Cline 형식) */
export function describeTools(tools: { name: string; description: string; params: Record<string, string> }[]): string {
  return tools
    .map((t) => {
      const ps = Object.entries(t.params);
      const usage = ps.length ? ps.map(([k]) => `<${k}>값</${k}>`).join('\n') : '';
      return `## ${t.name}\n${t.description}\n${ps.map(([k, v]) => `- ${k}: ${v}`).join('\n')}\n사용법:\n<${t.name}>\n${usage}\n</${t.name}>`;
    })
    .join('\n\n');
}
