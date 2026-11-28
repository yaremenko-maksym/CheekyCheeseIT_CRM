import {
  HOSTED_PROVIDERS,
  MAX_EXTRACTION_INPUT_CHARS,
  routerConfigSchema,
  type RouteStatePort,
} from '@crm/inference'
import { z } from 'zod'
import {
  buildRouterConfig,
  extractionWorkerEnvSchema,
  routerEnvWarnings,
  type RouterEnvWarning,
} from '../inference/build-inference-config'
import {
  feedbackLinesSchema,
  isUsableWorkerSecret,
  MAX_PAGE_BYTES,
  MAX_PAGE_CHARS,
  MAX_PAGES,
  PAYLOAD_REFUSALS,
  parseJson,
  visualCheckBodySchema,
  writingPayloadStringSchema,
  type PayloadRefusal,
} from './link-contract'

export { MAX_PAGE_BYTES, MAX_PAGES, PAYLOAD_REFUSALS, visualCheckBodySchema }
export type { PayloadRefusal }

/** The delimited user message from `buildExtractionPrompt`, bounded by the port's own input cap. */
export const MAX_WORKER_INPUT_CHARS = MAX_EXTRACTION_INPUT_CHARS
const DEFAULT_PORT = 3100

/** Data only (ADR §2.4): the input and the table version. Nothing else crosses. */
export const extractBodySchema = z
  .object({
    input: z.string().min(1).max(MAX_WORKER_INPUT_CHARS),
    tableVersion: z.string().min(1).max(64),
  })
  .strict()

/**
 * The payload's own refusal category for a failed body parse, read back from the issue
 * `payloadRefusal` added, or `body` for any other defect (another field, a missing, empty or
 * oversize payload). Reading the issue rather than the body means the oversize `abort` below still
 * holds: the payload is parsed once, never again for the log line — and nothing
 * attacker-controlled can reach the log, because only a member of `PAYLOAD_REFUSALS` is ever
 * returned.
 */
export function refusalCategory(error: z.ZodError): PayloadRefusal {
  // The categories are a closed set of our own wording, so a Zod message never collides with one.
  return PAYLOAD_REFUSALS.find((r) => error.issues.some((i) => i.message === r)) ?? 'body'
}

/**
 * `resume-write` data only: the task, the caller-redacted facts (spec §5.2) and the gate feedback on
 * the previous draft. The instruction is the worker's own; nothing here can replace it.
 */
export const resumeWriteBodySchema = z
  .object({
    task: z.enum(['summary', 'bullets']),
    payload: writingPayloadStringSchema,
    feedback: feedbackLinesSchema,
  })
  .strict()
export type ResumeWriteBody = z.infer<typeof resumeWriteBodySchema>

/** The route's body limit: the pages at their cap plus the JSON around them. */
export const VISUAL_CHECK_BODY_LIMIT = MAX_PAGES * MAX_PAGE_CHARS + 1024

/** `preflight` takes nothing: no body, or an empty JSON object. */
export const preflightBodySchema = z.union([z.undefined(), z.object({}).strict()])

export type WorkerHealth = { modelListStale: boolean; failedJobs: ('daily' | 'chain')[] }

/** The §5.3 flags that have no answer to ride on, read from the router state. */
export function healthFlags(s: ReturnType<RouteStatePort['snapshot']>): WorkerHealth {
  return {
    modelListStale: (s.modelListStale ?? []).length > 0,
    failedJobs: [...(s.failedJobs ?? [])],
  }
}

export type WorkerEnv = {
  secret: string
  routerConfig: unknown
  /** Routes dropped for a malformed env value; logged by name and reason at start. */
  routeWarnings: RouterEnvWarning[]
  stateFile: string
  host: string
  port: number
}

export type WorkerEnvResult =
  | { ok: true; env: WorkerEnv }
  | {
      ok: false
      reason: 'SECRET' | 'PROVIDER' | 'ROUTER_ENV' | 'ROUTER_CONFIG' | 'STATE_FILE' | 'PORT'
    }

/**
 * The worker's own env (its owner-created `0600` file, never `.env.production`). A refusal names
 * the key, never its value. `EXTRACTION_ROUTER_CONFIG` holds the non-secret route parameters; the
 * keys come from env (`buildRouterConfig`). A config the router refuses builds a
 * router that answers `NOT_CONFIGURED` and sends nothing (§3.3).
 */
export function parseWorkerEnv(env: Readonly<Record<string, string | undefined>>): WorkerEnvResult {
  const secret = env.EXTRACTION_WORKER_SECRET
  if (secret === undefined || !isUsableWorkerSecret(secret)) {
    return { ok: false, reason: 'SECRET' }
  }
  // The worker runs the router and nothing else; another selector is an operator error.
  if (env.INFERENCE_EXTRACTION_PROVIDER !== 'router') return { ok: false, reason: 'PROVIDER' }
  const routerEnv = extractionWorkerEnvSchema.safeParse(env)
  if (!routerEnv.success) return { ok: false, reason: 'ROUTER_ENV' }
  const rawConfig = env.EXTRACTION_ROUTER_CONFIG
  // Stryker disable next-line ConditionalExpression: equivalent — JSON.parse(undefined) throws, so parseJson answers null too
  const config = rawConfig === undefined ? null : parseJson(rawConfig)
  if (config === null) return { ok: false, reason: 'ROUTER_CONFIG' }
  const stateFile = env.EXTRACTION_ROUTER_STATE_FILE ?? ''
  if (stateFile === '') return { ok: false, reason: 'STATE_FILE' }
  const rawPort = env.EXTRACTION_WORKER_PORT ?? String(DEFAULT_PORT)
  const port = Number(rawPort)
  if (!/^\d+$/.test(rawPort) || port < 1 || port > 65_535) return { ok: false, reason: 'PORT' }
  return {
    ok: true,
    env: {
      secret,
      routerConfig: buildRouterConfig(config.value, routerEnv.data),
      routeWarnings: routerEnvWarnings(config.value, routerEnv.data),
      stateFile,
      host: env.EXTRACTION_WORKER_HOST ?? '0.0.0.0',
      port,
    },
  }
}

/**
 * The hosted routes this config ended up with, names only: `routeFromEnv` drops a route whose key is
 * missing without a word, so a key-name typo shows here. A config the router refuses has none.
 */
export function hostedRoutesOf(raw: unknown): { present: string[]; absent: string[] } {
  const parsed = routerConfigSchema.safeParse(raw)
  const present = HOSTED_PROVIDERS.filter(
    (p) => parsed.success && parsed.data.routes.some((r) => r.provider === p),
  )
  return { present, absent: HOSTED_PROVIDERS.filter((p) => !present.includes(p)) }
}
