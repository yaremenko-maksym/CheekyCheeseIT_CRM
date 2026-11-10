import {
  HOSTED_PROVIDERS,
  MAX_EXTRACTION_INPUT_CHARS,
  routerConfigSchema,
  type RouteStatePort,
} from '@crm/inference'
import { z } from 'zod'
import { buildRouterConfig, extractionWorkerEnvSchema } from '../inference/build-inference-config'
import { isUsableWorkerSecret } from './link-contract'

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

/** The facts arrive as one JSON object; an array, a primitive or a non-JSON string is refused. */
function isJsonObject(text: string): boolean {
  const parsed = parseJson(text)
  return typeof parsed?.value === 'object' && parsed.value !== null && !Array.isArray(parsed.value)
}

/**
 * `resume-write` data only: the task, the caller-redacted facts (spec §5.2) and the gate feedback on
 * the previous draft. The instruction is the worker's own; nothing here can replace it.
 */
export const resumeWriteBodySchema = z
  .object({
    task: z.enum(['summary', 'bullets']),
    payload: z.string().min(1).max(MAX_WORKER_INPUT_CHARS).refine(isJsonObject),
    // One line each: a line break could fake a `FACTS` or `FEEDBACK` heading in the user message.
    feedback: z
      .array(
        z
          .string()
          .min(1)
          .max(1000)
          .regex(/^[^\r\n]*$/),
      )
      .max(20),
  })
  .strict()
export type ResumeWriteBody = z.infer<typeof resumeWriteBodySchema>

/** The most pages one visual check takes, and the decoded size cap of each (1.5 MB). */
export const MAX_PAGES = 2
export const MAX_PAGE_BYTES = 1_500_000
/** The base64 length of a page at the cap. */
const MAX_PAGE_CHARS = Math.ceil(MAX_PAGE_BYTES / 3) * 4
/** The route's body limit: the pages at their cap plus the JSON around them. */
export const VISUAL_CHECK_BODY_LIMIT = MAX_PAGES * (MAX_PAGE_CHARS + 8) + 1024
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Canonical padded base64 whose bytes fit the cap and start with the PNG signature. */
function isPngPage(b64: string): boolean {
  if (b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return false
  const bytes = Buffer.from(b64, 'base64')
  return bytes.length <= MAX_PAGE_BYTES && bytes.subarray(0, 8).equals(PNG_SIGNATURE)
}

/** `visual-check` data only: the rendered pages. The checklist is the worker's own. */
export const visualCheckBodySchema = z
  .object({
    pages: z.array(z.string().max(MAX_PAGE_CHARS).refine(isPngPage)).min(1).max(MAX_PAGES),
  })
  .strict()

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

function parseJson(text: string): { value: unknown } | null {
  try {
    return { value: JSON.parse(text) as unknown }
  } catch {
    return null
  }
}

/**
 * The worker's own env (its owner-created `0600` file, never `.env.production`). A refusal names
 * the key, never its value. `EXTRACTION_ROUTER_CONFIG` holds the non-secret route parameters; the
 * keys and the local URL come from env (`buildRouterConfig`). A config the router refuses builds a
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
      stateFile,
      host: env.EXTRACTION_WORKER_HOST ?? '0.0.0.0',
      port,
    },
  }
}

/**
 * The preflight's router (ADR §5.3): one trivial call to the local route, never a hosted one. A
 * config the router refuses is handed on unchanged, so the preflight router refuses it too.
 */
export function localOnlyRouterConfig(raw: unknown): unknown {
  const parsed = routerConfigSchema.safeParse(raw)
  if (!parsed.success) return raw
  const routes = parsed.data.routes.filter((r) => r.provider === 'local')
  return { ...parsed.data, hostedBudgetMs: 0, routes }
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
