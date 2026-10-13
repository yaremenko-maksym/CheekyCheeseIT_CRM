import { z } from 'zod'
import type { InferenceErrorCode } from './errors'

export const MAX_DECISION_QUESTIONS = 50
export const MAX_CHOICE_OPTIONS = 255

const idSchema = z.string().min(1).max(100)

export const decisionQuestionSchema = z.discriminatedUnion('kind', [
  z.object({
    id: idSchema,
    kind: z.literal('choice'),
    options: z.array(z.string().min(1).max(500)).min(1).max(MAX_CHOICE_OPTIONS),
  }),
  z
    .object({ id: idSchema, kind: z.literal('score'), min: z.number(), max: z.number() })
    .refine((q) => q.min < q.max, 'min must be < max'),
  z.object({ id: idSchema, kind: z.literal('noul') }),
])
export type DecisionQuestion = z.infer<typeof decisionQuestionSchema>
export type DecisionChoiceQuestion = Extract<DecisionQuestion, { kind: 'choice' }>
export type DecisionScoreQuestion = Extract<DecisionQuestion, { kind: 'score' }>
export type DecisionNoulQuestion = Extract<DecisionQuestion, { kind: 'noul' }>

export const decisionAnswerSchema = z.object({
  id: idSchema,
  value: z.union([z.string(), z.number(), z.boolean()]),
  confidence: z.number().min(0).max(1),
})
export type DecisionAnswer = z.infer<typeof decisionAnswerSchema>

export const decisionRequestSchema = z.object({
  state: z.unknown(),
  questions: z.array(decisionQuestionSchema).min(1).max(MAX_DECISION_QUESTIONS),
})
export type DecisionRequest = z.infer<typeof decisionRequestSchema>

export type DecisionResult =
  | { ok: true; answers: DecisionAnswer[] }
  | { ok: false; code: InferenceErrorCode }

export interface DecisionPort {
  decide(req: DecisionRequest): Promise<DecisionResult>
}
