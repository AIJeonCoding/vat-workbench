import { BadRequestException, Body, Controller, Get, Headers, Param, ParseIntPipe, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { actorFromHeaders } from '../common/actor';
import { AgentQueue } from '../agent/agent.queue';
import { llmConfigFromEnv, llmHealthy } from '../agent/llm';
import { IngestService } from '../files/ingest.service';
import { mappingInputSchema } from '../files/statement';
import { ExportService } from '../review/export.service';
import { ChatService } from '../chat/chat.service';

const applyDiffSchema = z.object({
  changes: z
    .array(z.object({ txnId: z.number().int(), after: z.enum(['공제', '불공제']), reason: z.string().optional(), note: z.string().optional() }))
    .min(1),
});

/** 파일 업로드·내보내기처럼 바이너리를 다루는 일은 REST, 나머지 조회·판정은 GraphQL. 같은 서비스·검증을 공유한다. */
@Controller('api')
export class RestController {
  constructor(
    private readonly ingest: IngestService,
    private readonly exporter: ExportService,
    private readonly agent: AgentQueue,
    private readonly chat: ChatService,
  ) {}

  /** 업무 대화(조회·확정 카드 제안만, 쓰기 없음) */
  @Post('filings/:id/chat')
  async chatTurn(@Param('id', ParseIntPipe) id: number, @Body() body: unknown) {
    const r = z.object({ message: z.string().max(2000), mode: z.enum(['auto', 'quick']).optional() }).safeParse(body);
    if (!r.success) throw new BadRequestException('message가 필요합니다');
    return this.chat.answer(id, r.data.message, r.data.mode);
  }

  @Get('health')
  async health() {
    const cfg = llmConfigFromEnv();
    return { ok: true, llm: { up: await llmHealthy(cfg), model: cfg.model }, agentQueue: this.agent.pending };
  }

  /** 본문 = 파일 바이트(application/octet-stream), 파일명은 x-filename(URI 인코딩) */
  @Post('filings/:id/files')
  async upload(
    @Param('id', ParseIntPipe) id: number,
    @Headers() headers: Record<string, string>,
    @Req() req: FastifyRequest,
  ) {
    const actor = actorFromHeaders(headers);
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) throw new BadRequestException('파일 내용이 비어 있습니다');
    const filename = decodeURIComponent(headers['x-filename'] ?? 'upload.xlsx');
    // 처음 보는 은행·카드사 형식: 담당자가 확인한 열 연결을 함께 보낸다(URI 인코딩한 JSON)
    let mapping;
    if (headers['x-mapping']) {
      let raw: unknown;
      try {
        raw = JSON.parse(decodeURIComponent(headers['x-mapping']));
      } catch {
        throw new BadRequestException('열 연결 정보(x-mapping)가 JSON이 아닙니다');
      }
      const r = mappingInputSchema.safeParse(raw);
      if (!r.success) throw new BadRequestException(r.error.issues.map((i) => i.message).join(', '));
      mapping = r.data;
    }
    return this.ingest.ingest(actor, id, filename, body, mapping);
  }

  @Post('filings/:id/review-diff')
  async applyDiff(@Param('id', ParseIntPipe) _id: number, @Headers() headers: Record<string, string>, @Body() body: unknown) {
    const actor = actorFromHeaders(headers);
    const r = applyDiffSchema.safeParse(body);
    if (!r.success) throw new BadRequestException(r.error.issues);
    return this.exporter.applyReviewDiff(actor, r.data.changes);
  }

  @Get('filings/:id/export.xlsx')
  async export(@Param('id', ParseIntPipe) id: number, @Res() reply: FastifyReply) {
    const buf = await this.exporter.exportXlsx(id);
    reply
      .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`부가세검토_${id}.xlsx`)}`)
      .send(buf);
  }
}
