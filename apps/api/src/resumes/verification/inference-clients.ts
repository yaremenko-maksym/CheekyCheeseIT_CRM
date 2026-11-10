import {
  createExtractionWorkerTransport,
  createJevDecisionAdapter,
  decisionRequestSchema,
  INFERENCE_ERROR_CODES,
  MAX_DECISION_QUESTIONS,
  type DecisionPort,
  type DecisionRequest,
  type ExtractionWorkerRoute,
  type ExtractionWorkerTransport,
} from '@crm/inference'
import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { z } from 'zod'
import type { Env } from '../../config/env'
import {
  bulletsReplySchema,
  summaryReplySchema,
  type ResumeWriteReply,
} from '../../extraction-worker/resume-write'
import { resumeWriteBodySchema, visualCheckBodySchema } from '../../extraction-worker/schema'
import { findingsReplySchema, type VisualCheckReply } from '../../extraction-worker/visual-check'
import {
  readExtractionWorkerEnv,
  WORKER_ADAPTER_TIMEOUT_MS,
} from '../../job-sourcing/structuring/model-extraction-wiring'

export type WriterTask = 'summary' | 'bullets'
export type WriterReply = ResumeWriteReply
export type VisualReply = VisualCheckReply
export type EntailmentClaim = { id: string; text: string; sources: string[] }

/** `INVALID_INPUT`: the client refused the request before sending it. */
type Unavailable = { kind: 'unavailable'; reason: string }
const unavailable = (reason: string): Unavailable => ({ kind: 'unavailable', reason })
const reasonSchema = z.enum(INFERENCE_ERROR_CODES)

/** The worker transport, or undefined when its env is unset or invalid. */
function workerTransport(): ExtractionWorkerTransport | undefined {
  const env = readExtractionWorkerEnv(process.env)
  return env.kind === 'ok'
    ? createExtractionWorkerTransport({ baseUrl: env.url, secret: env.secret })
    : undefined
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** One call to a worker route; every failure is a coded `unavailable`, never a throw. */
async function callWorker<T>(
  post: ExtractionWorkerTransport | undefined,
  route: ExtractionWorkerRoute,
  body: string,
  replySchema: z.ZodType<T | Unavailable>,
): Promise<T | Unavailable> {
  if (post === undefined) return unavailable('NOT_CONFIGURED')
  // The transport never throws: a network error is a `transport` result.
  const res = await post(route, { body, timeoutMs: WORKER_ADAPTER_TIMEOUT_MS })
  if (res.kind === 'timeout') return unavailable('TIMEOUT')
  if (res.kind !== 'ok') return unavailable('PROVIDER_ERROR')
  const reply = replySchema.safeParse(parseJson(res.text))
  return reply.success ? reply.data : unavailable('INVALID_OUTPUT')
}

const unavailableReplySchema = z
  .object({ kind: z.literal('unavailable'), reason: reasonSchema })
  .strict()

const summaryWireSchema = z.union([
  z.object({ kind: z.literal('ok'), summary: summaryReplySchema.shape.summary }).strict(),
  unavailableReplySchema,
])
const bulletsWireSchema = z.union([
  z.object({ kind: z.literal('ok'), items: bulletsReplySchema.shape.items }).strict(),
  unavailableReplySchema,
])

/**
 * The AI writer over the worker's `/resume-write`.
 *
 * Precondition (R19): the caller has redacted contacts from every field of `payload` and `feedback`;
 * this client does not. It never logs the payload, the feedback or the reply text.
 */
@Injectable()
export class ResumeWriterClient {
  private readonly post = workerTransport()

  async write(task: WriterTask, payload: string, feedback: string[]): Promise<WriterReply> {
    const body = resumeWriteBodySchema.safeParse({ task, payload, feedback })
    if (!body.success) return unavailable('INVALID_INPUT')
    const schema = task === 'summary' ? summaryWireSchema : bulletsWireSchema
    return callWorker<WriterReply>(this.post, '/resume-write', JSON.stringify(body.data), schema)
  }
}

/**
 * The vision check over the worker's `/visual-check`: at most 2 PNG pages of at most 1 500 000 bytes
 * each, checked here before anything is sent.
 *
 * Precondition (R19): the pages are rendered from the contact-redacted (placeholder) copy; this
 * client does not redact. It never logs the pages or the findings text.
 */
@Injectable()
export class VisualCheckClient {
  private readonly post = workerTransport()

  async check(pngPages: Buffer[]): Promise<VisualReply> {
    const body = visualCheckBodySchema.safeParse({
      pages: pngPages.map((p) => p.toString('base64')),
    })
    if (!body.success) return unavailable('INVALID_INPUT')
    const pages = body.data.pages.length
    const schema = z.union([
      z
        .object({
          kind: z.literal('ok'),
          findings: findingsReplySchema.shape.findings.refine((fs) =>
            fs.every((f) => f.page < pages),
          ),
        })
        .strict(),
      unavailableReplySchema,
    ])
    return callWorker<VisualReply>(this.post, '/visual-check', JSON.stringify(body.data), schema)
  }
}

export const ENTAILMENT_QUESTION =
  'Is this statement fully supported by these source statements? Inflated ownership verbs count as unsupported.'
/** A claim is supported only when its score reaches this. */
export const ENTAILMENT_THRESHOLD = 0.8

/**
 * A noul answer as a support score. `value ? probability : 1 - probability`, except that a `false`
 * answer is capped at its lower reading: the adapter reports `probability` as P(true), so `1 - p` of
 * a confident `false` would read as supported. A `false` answer never reaches the threshold.
 */
function supportScore(value: boolean, probability: number): number {
  return value ? probability : Math.min(probability, 1 - probability)
}

/**
 * Scores every claim with Jev, ⌈n/50⌉ requests. Fails closed: a duplicate or unacceptable id (no
 * request sent), a failed chunk, a thrown port, a non-noul answer, or a reply with a missing or extra
 * id makes the whole call `'unavailable'`, so a missing score never reads as supported.
 */
export async function scoreEntailment(
  port: DecisionPort,
  claims: readonly EntailmentClaim[],
): Promise<Map<string, number> | 'unavailable'> {
  if (new Set(claims.map((c) => c.id)).size !== claims.length) return 'unavailable'
  const requests: DecisionRequest[] = []
  for (let i = 0; i < claims.length; i += MAX_DECISION_QUESTIONS) {
    const chunk = claims.slice(i, i + MAX_DECISION_QUESTIONS)
    const req = decisionRequestSchema.safeParse({
      state: Object.fromEntries(
        chunk.map((c) => [c.id, { statement: c.text, sources: c.sources }]),
      ),
      questions: chunk.map((c) => ({
        id: c.id,
        kind: 'noul',
        instructions: `${ENTAILMENT_QUESTION} The statement and its source statements are under the key ${JSON.stringify(c.id)} of the state.`,
      })),
    })
    if (!req.success) return 'unavailable'
    requests.push(req.data)
  }
  const scores = new Map<string, number>()
  for (const req of requests) {
    let r
    try {
      r = await port.decide(req)
    } catch {
      return 'unavailable'
    }
    if (!r.ok || r.answers.length !== req.questions.length) return 'unavailable'
    const asked = new Set(req.questions.map((q) => q.id))
    for (const a of r.answers) {
      if (a.kind !== 'noul' || !asked.delete(a.id)) return 'unavailable'
      scores.set(a.id, supportScore(a.value, a.probability))
    }
  }
  return scores
}

/**
 * Jev entailment of the written claims against their source statements.
 *
 * Precondition (R19): the caller has redacted contacts from every claim text and source; this client
 * does not. It never logs claims, sources or Jev text.
 */
@Injectable()
export class ResumeEntailmentClient {
  private readonly port: DecisionPort | undefined

  constructor(config: ConfigService<Env, true>) {
    const apiKey = config.get('JEV_API_KEY', { infer: true })
    this.port = apiKey ? createJevDecisionAdapter({ apiKey }) : undefined
  }

  score(claims: EntailmentClaim[]): Promise<Map<string, number> | 'unavailable'> {
    if (this.port === undefined) return Promise.resolve('unavailable')
    return scoreEntailment(this.port, claims)
  }
}
