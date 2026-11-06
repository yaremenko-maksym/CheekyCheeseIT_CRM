import { createHash } from 'node:crypto'
import {
  MAX_EXTRACTION_INPUT_CHARS,
  routerConfigSchema,
  type RouteStatePort,
  type SmallDoseGroup,
} from '@crm/inference'
import { z } from 'zod'
import { extractionWorkerEnvSchema } from '../config/env'
import { buildRouterConfig } from '../inference/build-inference-config'
import { modelReplySchema } from '../job-sourcing/structuring/extraction-result-guard'
import { EXTRACTION_SYSTEM_PROMPT } from '../job-sourcing/structuring/prompt-envelope'
import { smallDoseFor } from '../job-sourcing/structuring/small-dose-table'

/** The worker refuses to start with a shorter `EXTRACTION_WORKER_SECRET` (ADR §2.4). */
export const MIN_WORKER_SECRET_CHARS = 32
/** Fewer distinct characters than this is a placeholder, whatever its length. */
export const MIN_WORKER_SECRET_DISTINCT_CHARS = 8
/** One rule for both ends of the worker link: the worker and the collection side. */
export const isUsableWorkerSecret = (secret: string): boolean =>
  secret.length >= MIN_WORKER_SECRET_CHARS &&
  new Set(secret).size >= MIN_WORKER_SECRET_DISTINCT_CHARS
/** The delimited user message from `buildExtractionPrompt`, bounded by the port's own input cap. */
export const MAX_WORKER_INPUT_CHARS = MAX_EXTRACTION_INPUT_CHARS
const DEFAULT_PORT = 3100

/**
 * A digest of the checked-in extraction module both workers import: the prompt, the field-group
 * table and the reply schema. Two images mid-deploy differ here without anyone bumping a constant.
 * `merge` is code and is not hashed; a change to it alone ships with a prompt or table change or
 * not at all.
 */
export function tableVersionOf(m: {
  prompt: string
  groups: readonly SmallDoseGroup[]
  reply: z.ZodType
}): string {
  const groups = m.groups.map((g) => ({
    name: g.name,
    instruction: g.instruction,
    maxAnswerTokens: g.maxAnswerTokens,
    // Stryker disable next-line StringLiteral: equivalent — zod merges a string result into the node, so '' leaves `{}` exactly as 'any' does; dropping the option is caught
    schema: z.toJSONSchema(g.schema, { unrepresentable: 'any' }),
  }))
  // Stryker disable next-line StringLiteral: equivalent — see the line above; 'io' is pinned by its own test
  const reply = z.toJSONSchema(m.reply, { unrepresentable: 'any', io: 'input' })
  const doc = JSON.stringify({ prompt: m.prompt, groups, reply })
  // Stryker disable next-line StringLiteral: false survivor — '' throws "Digest method not supported" at module load, the spec file fails to collect, which the runner does not count as a kill
  const hash = createHash('sha256')
  return hash.update(doc).digest('hex').slice(0, 16)
}

// Stryker disable next-line ObjectLiteral: false survivor — {} throws at module load (m.groups is undefined), the spec file fails to collect, which the runner does not count as a kill
export const EXTRACTION_TABLE_VERSION = tableVersionOf({
  prompt: EXTRACTION_SYSTEM_PROMPT,
  groups: smallDoseFor().groups,
  reply: modelReplySchema,
})

/** Data only (ADR §2.4): the input and the table version. Nothing else crosses. */
export const extractBodySchema = z
  .object({
    input: z.string().min(1).max(MAX_WORKER_INPUT_CHARS),
    tableVersion: z.string().min(1).max(64),
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
