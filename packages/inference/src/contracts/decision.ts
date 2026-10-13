import { z } from 'zod'
import type { InferenceErrorCode } from './errors'

export const MAX_DECISION_QUESTIONS = 50
export const MAX_CHOICE_OPTIONS = 255
export const MIN_SCORE_LEVELS = 2
export const MAX_SCORE_LEVELS = 10
export const MAX_INSTRUCTIONS_CHARS = 2000

const idSchema = z.string().min(1).max(100)
const instructionsSchema = z.string().min(1).max(MAX_INSTRUCTIONS_CHARS)
const labelSchema = z.string().min(1).max(500)
const unit = z.number().min(0).max(1)

export const decisionQuestionSchema = z.discriminatedUnion('kind', [
  z.object({
    id: idSchema,
    kind: z.literal('choice'),
    instructions: instructionsSchema,
    options: z
      .array(z.object({ value: labelSchema, description: z.string().max(500).optional() }))
      .min(1)
      .max(MAX_CHOICE_OPTIONS),
  }),
  z.object({
    id: idSchema,
    kind: z.literal('score'),
    instructions: instructionsSchema,
    levels: z.array(labelSchema).min(MIN_SCORE_LEVELS).max(MAX_SCORE_LEVELS),
  }),
  z.object({
    id: idSchema,
    kind: z.literal('noul'),
    instructions: instructionsSchema,
    trueLabel: z.string().max(500).optional(),
    falseLabel: z.string().max(500).optional(),
  }),
])
export type DecisionQuestion = z.infer<typeof decisionQuestionSchema>
export type DecisionChoiceQuestion = Extract<DecisionQuestion, { kind: 'choice' }>
export type DecisionScoreQuestion = Extract<DecisionQuestion, { kind: 'score' }>
export type DecisionNoulQuestion = Extract<DecisionQuestion, { kind: 'noul' }>

export const decisionAnswerSchema = z.discriminatedUnion('kind', [
  z.object({
    id: idSchema,
    kind: z.literal('choice'),
    value: z.string(),
    confidence: unit,
    probabilities: z.record(z.string(), unit),
  }),
  z.object({ id: idSchema, kind: z.literal('score'), value: z.number(), confidence: unit }),
  z.object({ id: idSchema, kind: z.literal('noul'), value: z.boolean(), probability: unit }),
])
export type DecisionAnswer = z.infer<typeof decisionAnswerSchema>

export const decisionRequestSchema = z.object({
  state: z.unknown(),
  questions: z.array(decisionQuestionSchema).min(1).max(MAX_DECISION_QUESTIONS),
})
export type DecisionRequest = z.infer<typeof decisionRequestSchema>

export type DecisionResult =
  | { ok: true; answers: DecisionAnswer[]; usage?: { totalTokens: number } }
  | { ok: false; code: InferenceErrorCode }

export interface DecisionPort {
  decide(req: DecisionRequest): Promise<DecisionResult>
}
