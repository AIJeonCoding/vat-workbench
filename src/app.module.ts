import { MikroOrmModule } from '@mikro-orm/nestjs';
import { type DynamicModule, Module } from '@nestjs/common';
import { AgentQueue, CHAT_FN } from './agent/agent.queue';
import type { ChatFn } from './agent/llm';
import { RestController } from './api/rest.controller';
import { EventBus } from './common/events';
import { IngestService } from './files/ingest.service';
import { ormConfig } from './mikro-orm.config';
import { ExportService } from './review/export.service';
import { ReviewService } from './review/review.service';

@Module({})
export class AppModule {
  /** chat을 넘기면 실제 LLM 대신 그 함수를 쓴다(테스트에서 시나리오 LLM 주입) */
  static forRoot(opts: { chat?: ChatFn } = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [MikroOrmModule.forRoot(ormConfig())],
      controllers: [RestController],
      providers: [
        EventBus,
        AgentQueue,
        IngestService,
        ReviewService,
        ExportService,
        ...(opts.chat ? [{ provide: CHAT_FN, useValue: opts.chat }] : []),
      ],
    };
  }
}
