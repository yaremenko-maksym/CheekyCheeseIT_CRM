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
  isUsableWorkerSecret,
  MAX_PAGE_BYTES,
  MAX_PAGE_CHARS,
  MAX_PAGES,
  visualCheckBodySchema,
  writingPayloadSchema,
} from './link-contract'

export { MAX_PAGE_BYTES, MAX_PAGES, visualCheckBodySchema }

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
 * Why a `resume-write` payload was refused, as one of a closed set: the refusal log line carries
 * the category and nothing else — never a key or a value out of the payload (R16, item 460).
 */
export const PAYLOAD_REFUSALS = ['not json', 'unknown key', 'bad value', 'not canonical'] as const
export type PayloadRefusal = (typeof PAYLOAD_REFUSALS)[number]

/**
 * The facts arrive as one JSON object of the `WritingPayload` shape: an array, a primitive, a
 * non-JSON string and an object carrying a key the API's producer never builds are all refused
 * (item 460).
 *
 * The worker forwards the string, not the parsed value, and `JSON.parse` keeps only the LAST of two
 * duplicate keys — so a check of the parsed value alone leaves the earlier copy unchecked and on its
 * way to the provider (SR-M-1). A payload whose own re-serialisation is not byte-identical is
 * therefore refused rather than re-serialised: the producer builds its string with
 * `JSON.stringify` of the payload object (`content-gates.ts`), so its bytes travel on unchanged.
 */
function payloadRefusal(text: string): PayloadRefusal | null {
  const parsed = parseJson(text)
  if (parsed === null) return 'not json'
  const checked = writingPayloadSchema.safeParse(parsed.value)
  if (!checked.success) {
    return checked.error.issues.some((i) => i.code === 'unrecognized_keys')
      ? 'unknown key'
      : 'bad value'
  }
  // Whitespace and a re-encoded escape reach this too, hence the category's name, not 'duplicate'.
  return JSON.stringify(parsed.value) === text ? null : 'not canonical'
}

/**
 * The payload's own refusal category for a failed body parse, read back from the issue
 * `payloadRefusal` added, or `body` when something other than the payload is what failed. Reading
 * the issue rather than the body means the oversize `abort` below still holds: the payload is
 * parsed once, never again for the log line.
 */
export function refusalCategory(error: z.ZodError): PayloadRefusal | 'body' {
  const message = error.issues.find(
    (i) => i.code === 'custom' && i.path.length === 1 && i.path[0] === 'payload',
  )?.message
  return PAYLOAD_REFUSALS.find((r) => r === message) ?? 'body'
}

/**
 * `resume-write` data only: the task, the caller-redacted facts (spec §5.2) and the gate feedback on
 * the previous draft. The instruction is the worker's own; nothing here can replace it.
 */
export const resumeWriteBodySchema = z
  .object({
    task: z.enum(['summary', 'bullets']),
    // `abort`: an oversize payload stops here, before the JSON parse of the refine.
    payload: z
      .string()
      .min(1)
      .max(MAX_WORKER_INPUT_CHARS, { abort: true })
      .superRefine((text, ctx) => {
        const reason = payloadRefusal(text)
        // The category is the issue's whole message, so the log line can carry it as it stands.
        if (reason !== null) ctx.addIssue({ code: 'custom', message: reason })
      }),
    // One line each: a line break could fake a `FACTS` or `FEEDBACK` heading in the user message.
    feedback: z
      .array(
        z
          .string()
          .min(1)
          .max(1000, { abort: true })
          .regex(/^[^\r\n]*$/),
      )
      .max(20),
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
