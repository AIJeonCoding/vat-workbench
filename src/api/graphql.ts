import { EntityManager } from '@mikro-orm/postgresql';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { GraphQLError, GraphQLScalarType } from 'graphql';
import mercurius from 'mercurius';
import { ZodError, type ZodSchema } from 'zod';
import { actorFromHeaders } from '../common/actor';
import { EventBus } from '../common/events';
import { AgentQueue } from '../agent/agent.queue';
import { Client, DONE_STATUSES, Filing, Txn } from '../domain/entities';
import { bulkConfirmInputSchema, confirmInputSchema, requestStatusSchema, type Actor } from '../domain/schemas';
import { REASON_LABEL } from '../rules/law';
import { ReviewService } from '../review/review.service';

export const schema = /* GraphQL */ `
  scalar JSON

  type FilingCard {
    id: Int!
    period: String!
    status: String!
    clientName: String!
    industry: String!
    total: Int!
    pending: Int!
    needsReview: Int!
  }

  type FileInfo {
    id: Int!
    kind: String!
    filename: String!
    rowCount: Int!
    uploadedBy: String!
    uploadedAt: String!
  }

  type FilingDetail {
    id: Int!
    period: String!
    periodStart: String!
    periodEnd: String!
    status: String!
    client: JSON!
    files: [FileInfo!]!
  }

  type Txn {
    id: Int!
    kind: String!
    date: String!
    counterparty: String!
    counterpartyBrn: String
    counterpartyTaxType: String
    industry: String
    supplyAmount: Int!
    vat: Int!
    status: String!
    rule: JSON
    ai: JSON
    final: JSON
    hint: String
    memo: String
    sourceRow: Int
    vatEstimated: Boolean!
    matchType: String
    linkedTxnId: Int
    clientRequest: JSON
    sourceFileId: Int!
    version: Int!
  }

  type Audit {
    action: String!
    actor: String!
    at: String!
    after: JSON
  }

  type AgentStatus {
    pending: Int!
    model: String!
    currentTxnId: Int
  }

  type BulkResult {
    confirmed: Int!
    skipped: Int!
  }

  type ApplyResult {
    applied: Int!
  }

  type Event {
    type: String!
    filingId: Int!
    txnId: Int
    tool: String
    summary: String
  }

  input ConfirmInput {
    txnId: Int!
    expectedVersion: Int!
    decision: String
    reasonCode: String
    note: String
  }

  type Query {
    filings: [FilingCard!]!
    filing(id: Int!): FilingDetail!
    txns(filingId: Int!): [Txn!]!
    summary(filingId: Int!): JSON!
    txnHistory(txnId: Int!): [Audit!]!
    agentStatus: AgentStatus!
    reasonLabels: JSON!
  }

  type Mutation {
    confirm(input: ConfirmInput!): Txn!
    bulkConfirm(filingId: Int!, txnIds: [Int!]!): BulkResult!
    applyToSameCounterparty(txnId: Int!): ApplyResult!
    markReady(filingId: Int!): FilingCard!
    unmatch(txnId: Int!): Txn!
    setRequestStatus(filingId: Int!, txnIds: [Int!]!, status: String!): ApplyResult!
  }

  type Subscription {
    filingEvents(filingId: Int!): Event!
  }
`;

interface Ctx {
  actor: () => Actor;
}

/** Zod·Nest 예외를 GraphQL 오류로 바꾼다(REST와 같은 메시지·코드). */
function toGqlError(e: unknown): never {
  if (e instanceof ZodError) {
    throw new GraphQLError('validation failed', { extensions: { code: 'BAD_REQUEST', issues: e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } });
  }
  const err = e as { getStatus?: () => number; message: string };
  const status = err.getStatus?.() ?? 500;
  const code = status === 409 ? 'CONFLICT' : status === 403 ? 'FORBIDDEN' : status === 401 ? 'UNAUTHENTICATED' : status === 404 ? 'NOT_FOUND' : status === 400 ? 'BAD_REQUEST' : 'INTERNAL';
  throw new GraphQLError(err.message, { extensions: { code, status } });
}

const parse = <T>(s: ZodSchema<T>, v: unknown): T => {
  const r = s.safeParse(v);
  if (!r.success) throw r.error;
  return r.data;
};

const wrap =
  <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
  async (...a: A): Promise<R> => {
    try {
      return await fn(...a);
    } catch (e) {
      return toGqlError(e);
    }
  };

/** Mercurius(GraphQL)를 Nest의 Fastify 인스턴스에 붙인다. 리졸버는 Nest 서비스를 그대로 호출한다. */
export async function registerGraphql(app: NestFastifyApplication) {
  const review = app.get(ReviewService);
  const agent = app.get(AgentQueue);
  const events = app.get(EventBus);
  const em = app.get(EntityManager);
  const fastify = app.getHttpAdapter().getInstance();

  const filingCard = async (f: Filing) => {
    const fem = em.fork();
    const client = await fem.findOneOrFail(Client, f.clientId);
    const [total, pending, needsReview] = await Promise.all([
      fem.count(Txn, { filingId: f.id }),
      fem.count(Txn, { filingId: f.id, status: { $nin: DONE_STATUSES } }),
      fem.count(Txn, { filingId: f.id, status: 'NEEDS_REVIEW' }),
    ]);
    return { id: f.id, period: f.period, status: f.status, clientName: client.name, industry: client.industry, total, pending, needsReview };
  };

  const resolvers = {
    JSON: new GraphQLScalarType({ name: 'JSON', serialize: (v) => v, parseValue: (v) => v }),
    Query: {
      filings: wrap(async () => Promise.all((await em.fork().find(Filing, {}, { orderBy: { id: 'asc' } })).map(filingCard))),
      filing: wrap(async (_: unknown, { id }: { id: number }) => {
        const { filing, client, files } = await review.filing(id);
        return { ...filing, client, files: files.map((f) => ({ ...f, uploadedAt: f.uploadedAt.toISOString() })) };
      }),
      txns: wrap(async (_: unknown, { filingId }: { filingId: number }) => review.txns(filingId)),
      summary: wrap(async (_: unknown, { filingId }: { filingId: number }) => review.summary(filingId)),
      txnHistory: wrap(async (_: unknown, { txnId }: { txnId: number }) =>
        (await review.history(txnId)).map((a) => ({ action: a.action, actor: a.actor, at: a.at.toISOString(), after: a.after })),
      ),
      agentStatus: () => ({ pending: agent.pending, model: agent.model, currentTxnId: agent.current?.txnId ?? null }),
      reasonLabels: () => REASON_LABEL,
    },
    Mutation: {
      confirm: wrap(async (_: unknown, { input }: { input: unknown }, ctx: Ctx) => review.confirm(ctx.actor(), parse(confirmInputSchema, input))),
      bulkConfirm: wrap(async (_: unknown, args: unknown, ctx: Ctx) => review.bulkConfirm(ctx.actor(), parse(bulkConfirmInputSchema, args))),
      applyToSameCounterparty: wrap(async (_: unknown, { txnId }: { txnId: number }, ctx: Ctx) => review.applyToSameCounterparty(ctx.actor(), txnId)),
      markReady: wrap(async (_: unknown, { filingId }: { filingId: number }, ctx: Ctx) => filingCard(await review.markReady(ctx.actor(), filingId))),
      unmatch: wrap(async (_: unknown, { txnId }: { txnId: number }, ctx: Ctx) => review.unmatch(ctx.actor(), txnId)),
      setRequestStatus: wrap(async (_: unknown, args: unknown, ctx: Ctx) => {
        const a = parse(requestStatusSchema, args);
        const r = await review.setRequestStatus(ctx.actor(), a.filingId, a.txnIds, a.status);
        return { applied: r.updated };
      }),
    },
    Subscription: {
      filingEvents: {
        subscribe: async (_: unknown, { filingId }: { filingId: number }, { pubsub }: { pubsub: { subscribe: (t: string) => Promise<unknown> } }) =>
          pubsub.subscribe(`filing:${filingId}`),
      },
    },
  };

  await fastify.register(mercurius, {
    schema,
    resolvers: resolvers as never,
    subscription: true,
    graphiql: process.env.NODE_ENV !== 'production',
    context: (req: { headers: Record<string, string | string[] | undefined> }) => ({
      actor: () => {
        try {
          return actorFromHeaders(req.headers);
        } catch (e) {
          return toGqlError(e);
        }
      },
    }),
  });

  // 서비스 이벤트 → 같은 신고 건을 보고 있는 모든 화면으로 중계
  events.on((e) => {
    void fastify.graphql.pubsub.publish({ topic: `filing:${e.filingId}`, payload: { filingEvents: { txnId: null, tool: null, summary: null, ...e } } });
  });
}
