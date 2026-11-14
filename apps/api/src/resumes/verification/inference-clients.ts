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
  type InferenceErrorCode,
} from '@crm/inference'
import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { z } from 'zod'
import type { Env } from '../../config/env'
import type { RunOrigin } from './run-columns'
import {
  bulletsReplySchema,
  findingsReplySchema,
  resumeWriteInput,
  summaryReplySchema,
  visualCheckBodySchema,
} from '../../extraction-worker/link-contract'
import {
  readExtractionWorkerEnv,
  WORKER_ADAPTER_TIMEOUT_MS,
} from '../../job-sourcing/structuring/model-extraction-wiring'

/** The worker's user message, for sizing a payload against its cap (P9). */
export { resumeWriteInput }

export type WriterTask = 'summary' | 'bullets'
export type EntailmentClaim = { id: string; text: string; sources: string[] }

/**
 * `INVALID_INPUT`: the client refused the request before sending it. `status`: the HTTP status of a
 * non-2xx worker answer, for the log only (FR-A-2).
 */
export type Unavailable = {
  kind: 'unavailable'
  reason: InferenceErrorCode | 'INVALID_INPUT'
  status?: number
}
const unavailable = (reason: Unavailable['reason']): Unavailable => ({
  kind: 'unavailable',
  reason,
})
const reasonSchema = z.enum(INFERENCE_ERROR_CODES)

/** The provider ids a failed run logs (FR-A-2): the worker route, or the entailment service. */
export const WRITER_PROVIDER = 'extraction-worker:/resume-write'
export const VISUAL_PROVIDER = 'extraction-worker:/visual-check'
export const ENTAILMENT_PROVIDER = 'jev'

/** A coded `unavailable` as a run-failure origin: provider, reason, and the HTTP status if any. */
export const unavailableOrigin = (provider: string, reply: Unavailable): RunOrigin =>
  reply.status === undefined
    ? { provider, reason: reply.reason }
    : { provider, reason: reply.reason, status: reply.status }

/** The worker transport, or undefined when its env is unset or invalid. */
function workerTransport(): ExtractionWorkerTransport | undefined {
  const env = readExtractionWorkerEnv(process.env)
  return env.kind === 'ok'
    ? createExtractionWorkerTransport({ baseUrl: env.url, secret: env.secret })
    : undefined
}

/** Undefined for a non-JSON reply: it fails every reply schema. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    // not JSON
  }
  return undefined
}

/** One call to a worker route; every failure is a coded `unavailable`, never a throw. */
async function callWorker<T>(
  post: ExtractionWorkerTransport | undefined,
  route: ExtractionWorkerRoute,
  body: string,
  replySchema: z.ZodType<T>,
): Promise<T | Unavailable> {
  if (post === undefined) return unavailable('NOT_CONFIGURED')
  // The transport never throws: a network error is a `transport` result.
  const res = await post(route, { body, timeoutMs: WORKER_ADAPTER_TIMEOUT_MS })
  if (res.kind === 'timeout') return unavailable('TIMEOUT')
  if (res.kind !== 'ok') {
    return res.status === undefined
      ? unavailable('PROVIDER_ERROR')
      : { ...unavailable('PROVIDER_ERROR'), status: res.status }
  }
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
export type WriterReply =
  | Exclude<z.infer<typeof summaryWireSchema> | z.infer<typeof bulletsWireSchema>, Unavailable>
  | Unavailable

const visualWireSchema = (pages: number) =>
  z.union([
    z
      .object({
        kind: z.literal('ok'),
        // A finding on a page that was not sent makes the whole reply invalid.
        findings: findingsReplySchema.shape.findings.refine((fs) =>
          fs.every((f) => f.page < pages),
        ),
      })
      .strict(),
    unavailableReplySchema,
  ])
export type VisualReply =
  Exclude<z.infer<ReturnType<typeof visualWireSchema>>, Unavailable> | Unavailable

/**
 * The AI writer over the worker's `/resume-write`.
 *
 * Precondition (R19): the caller has redacted contacts from every field of `payload` and `feedback`;
 * this client does not. It never logs the payload, the feedback or the reply text.
 *
 * Input precondition (the caller validates upstream; this client does not check, and the worker's
 * 400 on a bad body surfaces here as `PROVIDER_ERROR`), per the worker's `resumeWriteBodySchema`:
 * - `payload` is a JSON object string of 1..`MAX_WORKER_INPUT_CHARS` (50 000) chars;
 * - `feedback` has at most 20 items, each 1..1000 chars on one line (no CR or LF);
 * - the user message built from both (`resumeWriteInput`) is at most `MAX_WORKER_INPUT_CHARS`.
 */
@Injectable()
export class ResumeWriterClient {
  private readonly post = workerTransport()

  async write(task: WriterTask, payload: string, feedback: string[]): Promise<WriterReply> {
    // The worker checks the body (a JSON-object payload, one line per feedback item): a 400 is unavailable.
    const body = JSON.stringify({ task, payload, feedback })
    const schema: z.ZodType<WriterReply> =
      task === 'summary' ? summaryWireSchema : bulletsWireSchema
    return callWorker(this.post, '/resume-write', body, schema)
  }
}

/**
 * The vision check over the worker's `/visual-check`: at most 2 PNG pages of at most 1 500 000 bytes
 * each, checked here before anything is sent (`INVALID_INPUT`).
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
    const schema = visualWireSchema(body.data.pages.length)
    return callWorker(this.post, '/visual-check', JSON.stringify(body.data), schema)
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
    // Stryker disable next-line ObjectLiteral,BooleanLiteral: equivalent — `infer` only types the return
    const apiKey = config.get('JEV_API_KEY', { infer: true })
    this.port = apiKey ? createJevDecisionAdapter({ apiKey }) : undefined
  }

  score(claims: EntailmentClaim[]): Promise<Map<string, number> | 'unavailable'> {
    if (this.port === undefined) return Promise.resolve('unavailable')
    return scoreEntailment(this.port, claims)
  }
}
