#!/usr/bin/env node
// 로컬 LLM(mlx_lm.server :8080) 앞에 두는 토큰 확인 프록시. 터널로는 이 포트만 내보낸다.
// - Authorization: Bearer <LLM_API_KEY> 가 맞을 때만 통과
// - /v1/models, /v1/chat/completions 두 경로만 허용(다른 기능은 막음)
// - 한 번에 한 요청만(로컬 GPU 보호), 본문 200KB 상한
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

const KEY = process.env.LLM_API_KEY;
const UPSTREAM = process.env.LLM_UPSTREAM ?? 'http://127.0.0.1:8080';
const PORT = Number(process.env.PROXY_PORT ?? 8081);
if (!KEY || KEY.length < 24) {
  console.error('LLM_API_KEY(24자 이상)가 필요합니다');
  process.exit(1);
}
const ALLOWED = new Set(['GET /v1/models', 'POST /v1/chat/completions']);
const ok = (h) => {
  const got = Buffer.from(String(h ?? '').replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(KEY);
  return got.length === want.length && timingSafeEqual(got, want);
};
let busy = false;

http
  .createServer((req, res) => {
    const route = `${req.method} ${(req.url ?? '').split('?')[0]}`;
    if (!ALLOWED.has(route)) return res.writeHead(404).end();
    if (!ok(req.headers.authorization)) return res.writeHead(401).end();
    if (route.startsWith('POST') && busy) return res.writeHead(429, { 'retry-after': '5' }).end('busy');
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 200_000) req.destroy();
      else chunks.push(c);
    });
    req.on('end', async () => {
      if (route.startsWith('POST')) busy = true;
      try {
        const up = await fetch(`${UPSTREAM}${req.url}`, {
          method: req.method,
          headers: { 'content-type': 'application/json' },
          body: req.method === 'POST' ? Buffer.concat(chunks) : undefined,
        });
        res.writeHead(up.status, { 'content-type': up.headers.get('content-type') ?? 'application/json' });
        res.end(Buffer.from(await up.arrayBuffer()));
      } catch (e) {
        res.writeHead(502).end(String(e));
      } finally {
        if (route.startsWith('POST')) busy = false;
      }
    });
  })
  .listen(PORT, '127.0.0.1', () => console.log(`llm-proxy :${PORT} → ${UPSTREAM}`));
