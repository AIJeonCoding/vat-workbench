import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from '@nestjs/common';
import { z } from 'zod';
import { ChatService } from '../chat/chat.service';

/**
 * 음성 대화(통화형) — 브라우저가 받아쓴 말 한 마디를 WebSocket으로 받아, 업무 대화(가드 → 규칙/자율 루프)로 답한다.
 *
 * 통화처럼 동작하게 만든 것
 * - 한 연결에서 턴이 이어지고, 새 말이 오면 이전 턴은 취소(끼어들기)
 * - 답이 0.7초 안에 안 나오면 "확인해 볼게요"를 먼저 보내 침묵을 줄임
 * - 서버는 진행 단계(자율 루프의 도구 호출)를 그대로 흘려 보냄
 *
 * TTS(/api/tts): ElevenLabs 키가 서버에 있으면 음성을 스트리밍으로 중계(키는 브라우저에 안 나감).
 * 공개 데모라 하루 글자 수 상한을 둬 크레딧을 보호한다. 키가 없으면 204 → 브라우저 기기 음성으로 대체.
 */
const log = new Logger('Voice');

const inMsg = z.discriminatedUnion('t', [
  z.object({ t: z.literal('utt'), id: z.string().max(40), filingId: z.number().int().positive(), text: z.string().min(1).max(300), mode: z.enum(['auto', 'quick']).optional() }),
  z.object({ t: z.literal('cancel'), id: z.string().max(40) }),
]);

const TTS_DAILY_CHARS = Number(process.env.TTS_DAILY_CHARS ?? 8000);
let ttsDay = '';
let ttsUsed = 0;

interface WsLike {
  send(data: string): void;
  on(ev: 'message', fn: (raw: Buffer) => void): void;
  on(ev: 'close', fn: () => void): void;
  readyState: number;
}

export async function registerVoice(app: NestFastifyApplication) {
  const chat = app.get(ChatService);
  const fastify = app.getHttpAdapter().getInstance() as unknown as {
    get: (path: string, opts: object, handler: (conn: unknown, req: unknown) => void) => void;
    post: (path: string, handler: (req: { body: unknown }, reply: ReplyLike) => Promise<unknown>) => void;
    websocketServer?: unknown;
  };

  // ── 음성 턴 WebSocket ──
  fastify.get('/ws/voice', { websocket: true }, (conn: unknown) => {
    const ws = ((conn as { socket?: WsLike }).socket ?? conn) as WsLike;
    let current: { id: string; ctrl: AbortController } | null = null;
    const send = (m: object) => ws.readyState === 1 && ws.send(JSON.stringify(m));

    ws.on('message', async (raw) => {
      let msg: z.infer<typeof inMsg>;
      try {
        msg = inMsg.parse(JSON.parse(raw.toString()));
      } catch {
        return send({ t: 'error', text: '형식이 맞지 않는 메시지입니다.' });
      }
      if (msg.t === 'cancel') {
        if (current?.id === msg.id) current.ctrl.abort();
        return;
      }
      // 새 말이 오면 진행 중인 턴은 취소(끼어들기)
      current?.ctrl.abort();
      const ctrl = new AbortController();
      current = { id: msg.id, ctrl };
      const t0 = Date.now();
      const filler = setTimeout(() => !ctrl.signal.aborted && send({ t: 'ack', id: msg.id, text: '확인해 볼게요.' }), 700);
      try {
        const r = await chat.answer(msg.filingId, msg.text, msg.mode ?? 'auto', ctrl.signal);
        clearTimeout(filler);
        if (ctrl.signal.aborted) return send({ t: 'cancelled', id: msg.id });
        send({ t: 'reply', id: msg.id, ms: Date.now() - t0, ...r });
      } catch (e) {
        clearTimeout(filler);
        log.warn(`voice turn: ${(e as Error).message}`);
        send({ t: 'reply', id: msg.id, ms: Date.now() - t0, route: 'error', reply: '지금은 답을 만들지 못했어요. 잠시 뒤 다시 말씀해 주세요.' });
      } finally {
        if (current?.id === msg.id) current = null;
      }
    });
    ws.on('close', () => current?.ctrl.abort());
  });

  // ── TTS 중계(ElevenLabs) ──
  fastify.post('/api/tts', async (req, reply) => {
    const key = process.env.ELEVENLABS_API_KEY;
    const voice = process.env.ELEVENLABS_VOICE_ID;
    const body = z.object({ text: z.string().min(1).max(300) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ message: 'text가 필요합니다(300자 이하)' });
    if (!key || !voice) return reply.code(204).send();
    const today = new Date().toISOString().slice(0, 10);
    if (ttsDay !== today) (ttsDay = today), (ttsUsed = 0);
    if (ttsUsed + body.data.text.length > TTS_DAILY_CHARS) return reply.code(204).send(); // 오늘 한도 → 기기 음성으로
    ttsUsed += body.data.text.length;
    const model = process.env.ELEVENLABS_MODEL ?? 'eleven_multilingual_v2';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}/stream?output_format=mp3_44100_128&optimize_streaming_latency=3`, {
        method: 'POST',
        headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
        body: JSON.stringify({
          text: body.data.text,
          model_id: model,
          ...(/flash|turbo/.test(model) ? { language_code: 'ko' } : {}),
          voice_settings: { stability: 0.6, similarity_boost: 0.8, style: 0, use_speaker_boost: true },
        }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        log.warn(`tts ${res.status}`);
        return reply.code(204).send();
      }
      reply.header('content-type', 'audio/mpeg').header('cache-control', 'no-store');
      return reply.send(Buffer.from(await res.arrayBuffer()));
    } catch (e) {
      log.warn(`tts: ${(e as Error).message}`);
      return reply.code(204).send();
    } finally {
      clearTimeout(timer);
    }
  });
}

interface ReplyLike {
  code(n: number): ReplyLike;
  header(k: string, v: string): ReplyLike;
  send(b?: unknown): unknown;
}
