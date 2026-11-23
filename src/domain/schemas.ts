import { z } from 'zod';

/** 사람·Agent 모두 이 Actor로 기록된다. Agent는 role=agent라 제안만 가능하다. */
export const actorSchema = z.object({
  userId: z.string().min(1).max(64),
  role: z.enum(['preparer', 'reviewer', 'agent']),
});
export type Actor = z.infer<typeof actorSchema>;

export const decisionSchema = z.enum(['DEDUCT', 'NON_DEDUCT']);
export const reasonCodeSchema = z.enum([
  'BUSINESS',
  'VEHICLE_PASSENGER',
  'VEHICLE_OK',
  'ENTERTAINMENT',
  'NOT_BUSINESS',
  'EXEMPT_SUPPLIER',
  'SIMPLIFIED_SUPPLIER',
  'BEFORE_REGISTRATION',
  'NO_VAT',
  'NO_EVIDENCE',
  'NOT_VAT',
]);

/** 사람 확정 입력. GraphQL mutation과 REST가 같은 스키마로 검증한다. */
export const confirmInputSchema = z
  .object({
    txnId: z.number().int().positive(),
    expectedVersion: z.number().int().positive(),
    /** 비우면 현재 제안(AI 또는 규칙)을 그대로 승인 */
    decision: decisionSchema.optional(),
    reasonCode: reasonCodeSchema.optional(),
    note: z.string().max(500).optional(),
  })
  .refine((v) => (v.decision === undefined) === (v.reasonCode === undefined), {
    message: '판정을 바꾸려면 decision과 reasonCode를 함께 보내야 합니다',
    path: ['reasonCode'],
  });
export type ConfirmInput = z.infer<typeof confirmInputSchema>;

export const bulkConfirmInputSchema = z.object({
  filingId: z.number().int().positive(),
  txnIds: z.array(z.number().int().positive()).min(1).max(500),
});
export type BulkConfirmInput = z.infer<typeof bulkConfirmInputSchema>;

/** Agent 최종 제안 계약(attempt_completion 인수). 형식이 틀리면 Agent에게 오류를 돌려줘 고치게 한다. */
export const proposalSchema = z.object({
  decision: decisionSchema,
  reason_code: reasonCodeSchema,
  law_ref: z.string().min(2).max(120),
  explanation: z.string().min(5).max(400),
  confidence: z.coerce.number().min(0).max(1),
});
export type Proposal = z.infer<typeof proposalSchema>;

export const requestStatusSchema = z.object({
  filingId: z.number().int().positive(),
  txnIds: z.array(z.number().int().positive()).min(1).max(500),
  status: z.enum(['todo', 'sent', 'answered']),
});
