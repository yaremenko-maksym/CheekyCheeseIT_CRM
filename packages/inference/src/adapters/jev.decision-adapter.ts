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

const envelopeSchema = z.object({ answers: z.array(z.unknown()) })

function toSystemOneQuestion(q: DecisionQuestion): Record<string, unknown> {
  switch (q.kind) {
    case 'choice':
      return { id: q.id, type: 'choice', options: q.options }
    case 'score':
      return { id: q.id, type: 'score', min: q.min, max: q.max }
    case 'noul':
      return { id: q.id, type: 'noul' }
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
    model: MODEL,
    state: JSON.parse(state) as unknown,
    questions: req.questions.map(toSystemOneQuestion),
  })
}

/** Validates untrusted answers: per-answer schema, and every id must be a requested question id. */
function validateAnswers(raw: unknown[], req: DecisionRequest): DecisionResult {
  const requested = new Set(req.questions.map((q) => q.id))
  const answers: DecisionAnswer[] = []
  for (const item of raw) {
    const parsed = decisionAnswerSchema.safeParse(item)
    if (!parsed.success || !requested.has(parsed.data.id)) {
      return { ok: false, code: 'INVALID_OUTPUT' }
    }
    answers.push(parsed.data)
  }
  return { ok: true, answers }
}

export function createJevDecisionAdapter(cfg: JevDecisionConfig): DecisionPort {
  return {
    async decide(req: DecisionRequest): Promise<DecisionResult> {
      if (cfg.apiKey === '') return { ok: false, code: 'NOT_CONFIGURED' }
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
          return validateAnswers(env.data.answers, req)
        }
      }
    },
  }
}
