import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import type { ChatFn } from './agent/llm';
import { registerGraphql } from './api/graphql';
import { registerVoice } from './voice/voice';

/** 서버와 테스트가 같은 설정으로 앱을 만든다. */
export async function createApp(opts: { serveWeb?: boolean; chat?: ChatFn } = {}): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule.forRoot({ chat: opts.chat }), new FastifyAdapter({ bodyLimit: 20 * 1024 * 1024 }), {
    logger: ['error', 'warn'],
  });
  const fastify = app.getHttpAdapter().getInstance();
  // 업로드 파일은 원본 바이트 그대로 받는다
  fastify.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  // GraphQL 구독과 음성 대화가 같은 WebSocket 플러그인을 쓰도록 루트에 먼저 등록
  await fastify.register(fastifyWebsocket, { options: { maxPayload: 1048576 } });
  await registerGraphql(app);
  await registerVoice(app);

  const webDist = join(__dirname, '..', 'web', 'dist');
  if (opts.serveWeb && existsSync(webDist)) {
    // 화면은 한 페이지(SPA)라 정적 파일만 서빙하면 된다(404 처리는 Nest가 맡음)
    await fastify.register(fastifyStatic, { root: webDist, wildcard: true });
  }

  await app.init();
  await fastify.ready();
  return app;
}
