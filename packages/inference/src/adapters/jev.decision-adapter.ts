import { z } from 'zod'
import {
  decisionAnswerSchema,
  type DecisionAnswer,
  type DecisionPort,
  type DecisionQuestion,
  type DecisionRequest,
  type DecisionResult,
} from '../contracts/decision'
import {
  boundedRequest,
  DEFAULT_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  type FetchLike,
} from '../http/bounded-request'

export type JevDecisionConfig = {
  apiKey: string
  baseUrl?: string
  timeoutMs?: number
  fetchImpl?: FetchLike
}

const DEFAULT_BASE_URL = 'https://api.typesafe.ai'
const MODEL = 'jev-latest'
export const MAX_DECISION_STATE_BYTES = 256 * 1024

const unit = z.number().min(0).max(1)

const envelopeSchema = z.object({
  answers: z.record(z.string(), z.unknown()),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).optional(),
})

const wireAnswerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('choice'),
    choice: z.string(),
    probabilities: z.record(z.string(), unit),
    confidence: unit,
  }),
  z.object({
    type: z.literal('score'),
    score: z.number(),
    probabilities: z.record(z.string(), unit).optional(),
    confidence: unit,
  }),
  z.object({ type: z.literal('noul'), noul: unit }),
])

function toSystemOneQuestion(q: DecisionQuestion): Record<string, unknown> {
  switch (q.kind) {
    case 'choice':
      return {
        type: 'choice',
        instructions: q.instructions,
        criteria: Object.fromEntries(q.options.map((o) => [o.value, o.description ?? o.value])),
      }
    case 'score':
      return { type: 'score', instructions: q.instructions, criteria: q.levels }
    case 'noul': {
      const criteria = {
        ...(q.trueLabel !== undefined && { true: q.trueLabel }),
        ...(q.falseLabel !== undefined && { false: q.falseLabel }),
      }
      return {
        type: 'noul',
        instructions: q.instructions,
        ...(Object.keys(criteria).length > 0 && { criteria }),
      }
    }
  }
}

/** Serializes the request; null when the state is unserializable or over the size cap. */
function serializeBody(req: DecisionRequest): string | null {
  let state: string | undefined
  try {
    state = JSON.stringify(req.state ?? null)
  } catch {
    return null
  }
  if (
    state === undefined ||
    new TextEncoder().encode(state).byteLength > MAX_DECISION_STATE_BYTES
  ) {
    return null
  }
  return JSON.stringify({
    state: JSON.parse(state) as unknown,
    model: MODEL,
    questions: Object.fromEntries(req.questions.map((q) => [q.id, toSystemOneQuestion(q)])),
  })
}

/** Validates one untrusted wire answer against ITS question; null when invalid. */
function mapAnswer(q: DecisionQuestion, raw: unknown): DecisionAnswer | null {
  const wire = wireAnswerSchema.safeParse(raw)
  if (!wire.success || wire.data.type !== q.kind) return null
  const w = wire.data
  let candidate: unknown
  if (w.type === 'choice' && q.kind === 'choice') {
    if (!q.options.some((o) => o.value === w.choice)) return null
    candidate = {
      id: q.id,
      kind: 'choice',
      value: w.choice,
      confidence: w.confidence,
      probabilities: w.probabilities,
    }
  } else if (w.type === 'score' && q.kind === 'score') {
    if (w.score < 0 || w.score > q.levels.length - 1) return null
    candidate = { id: q.id, kind: 'score', value: w.score, confidence: w.confidence }
  } else if (w.type === 'noul') {
    candidate = { id: q.id, kind: 'noul', value: w.noul >= 0.5, probability: w.noul }
  } else {
    return null
  }
  const parsed = decisionAnswerSchema.safeParse(candidate)
  return parsed.success ? parsed.data : null
}

/** Every requested id answered exactly once, no extras, each validated against its question. */
function validateAnswers(
  raw: Record<string, unknown>,
  req: DecisionRequest,
  totalTokens: number | undefined,
): DecisionResult {
  const requested = new Set(req.questions.map((q) => q.id))
  if (Object.keys(raw).some((id) => !requested.has(id)))
    return { ok: false, code: 'INVALID_OUTPUT' }
  const answers: DecisionAnswer[] = []
  for (const q of req.questions) {
    if (!Object.prototype.hasOwnProperty.call(raw, q.id))
      return { ok: false, code: 'INVALID_OUTPUT' }
    const a = mapAnswer(q, raw[q.id])
    if (a === null) return { ok: false, code: 'INVALID_OUTPUT' }
    answers.push(a)
  }
  return { ok: true, answers, ...(totalTokens !== undefined && { usage: { totalTokens } }) }
}

export function createJevDecisionAdapter(cfg: JevDecisionConfig): DecisionPort {
  return {
    async decide(req: DecisionRequest): Promise<DecisionResult> {
      if (cfg.apiKey === '') return { ok: false, code: 'NOT_CONFIGURED' }
      // The wire request is a map keyed by question id: duplicates would silently collapse.
      if (new Set(req.questions.map((q) => q.id)).size !== req.questions.length)
        return { ok: false, code: 'INVALID_OUTPUT' }
      const body = serializeBody(req)
      if (body === null) return { ok: false, code: 'PROVIDER_ERROR' }

      const result = await boundedRequest({
        url: `${(cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')}/v1/systemone`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body,
        timeoutMs: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBytes: DEFAULT_MAX_BYTES,
        ...(cfg.fetchImpl !== undefined && { fetchImpl: cfg.fetchImpl }),
      })
      switch (result.kind) {
        case 'rate_limited':
          return { ok: false, code: 'RATE_LIMITED' }
        case 'timeout':
          return { ok: false, code: 'TIMEOUT' }
        case 'transport':
          return { ok: false, code: 'PROVIDER_ERROR' }
        case 'ok': {
          let json: unknown
          try {
            json = JSON.parse(result.text)
          } catch {
            return { ok: false, code: 'PROVIDER_ERROR' }
          }
          const env = envelopeSchema.safeParse(json)
          if (!env.success) return { ok: false, code: 'PROVIDER_ERROR' }
          const u = env.data.usage
          return validateAnswers(
            env.data.answers,
            req,
            u === undefined ? undefined : u.input_tokens + u.output_tokens,
          )
        }
      }
    },
  }
}
