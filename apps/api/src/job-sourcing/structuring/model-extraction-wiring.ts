import {
  createExtractionWorkerAdapter,
  MAX_FLOOR_BUDGET_MS,
  MAX_HOSTED_BUDGET_MS,
  routerCallCeilingMs,
  routerInputCeilingChars,
  type ExtractionWorkerAdapter,
  type ExtractionWorkerAdapterConfig,
} from '@crm/inference'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import {
  EXTRACTION_TABLE_VERSION,
  isUsableWorkerSecret,
} from '../../extraction-worker/link-contract'
import { HTML_MODEL_CALLS_PER_CYCLE, InMemoryModelBudget } from './model-budget.port'
import { createModelHealth, type ModelHealthLog, type ModelHealthStore } from './model-health'
import { ModelStructurer } from './model-structurer'
import { EXTRACTION_SYSTEM_PROMPT } from './prompt-envelope'
import { smallDoseFor } from './small-dose-table'

/**
 * The collection side never sees the worker's router config, so it takes the package maxima: no
 * configured router call outlasts this (ADR §5.5 item 2).
 */
const CALL_CEILING_MS = routerCallCeilingMs({
  hostedBudgetMs: MAX_HOSTED_BUDGET_MS,
  floorBudgetMs: MAX_FLOOR_BUDGET_MS,
})
const MARGIN_MS = 10_000
/** The ceiling plus a margin, so the router's coded `TIMEOUT` arrives first (§5.5 item 4). */
export const WORKER_STRUCTURER_TIMEOUT_MS = CALL_CEILING_MS + MARGIN_MS
/** The transport outlives the structurer, whose abort is what ends a call. */
export const WORKER_ADAPTER_TIMEOUT_MS = WORKER_STRUCTURER_TIMEOUT_MS + MARGIN_MS
/** The timeout plus a grace: every request has ended by then. */
export const WORKER_HOLD_MS = WORKER_ADAPTER_TIMEOUT_MS + MARGIN_MS

/** The gaps between the 4 preflight attempts: MP-04's cold load must fit inside them (§5.3). */
export const PREFLIGHT_BACKOFF_MS = [10_000, 30_000, 60_000] as const

/** The only env the collection side reads for the model. No hosted key, no router URL (§2.4). */
export const MODEL_EXTRACTION_ENV_KEYS = [
  'EXTRACTION_WORKER_URL',
  'EXTRACTION_WORKER_SECRET',
  'EXTRACTION_LOCAL_CONTEXT_TOKENS',
  'EXTRACTION_LOCAL_MAX_ANSWER_TOKENS',
  'EXTRACTION_CYCLE_LOCAL_MS_LIMIT',
] as const

const positiveInt = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().positive())

const workerEnvSchema = z.object({
  EXTRACTION_WORKER_URL: z
    .url({ protocol: /^https?$/ })
    .refine((u) => {
      const url = new URL(u)
      return url.username === '' && url.password === ''
    })
    // The adapter appends `/extract` and `/preflight` to it.
    .transform((u) => u.replace(/\/+$/, '')),
  EXTRACTION_WORKER_SECRET: z.string().refine(isUsableWorkerSecret),
})

const envSchema = z.object({
  // The worker's local route window: the page is cut to it before it leaves (§2.1).
  EXTRACTION_LOCAL_CONTEXT_TOKENS: positiveInt,
  EXTRACTION_LOCAL_MAX_ANSWER_TOKENS: positiveInt,
  // Frozen from MP-04 (§5.5 item 6); unset is no local-time limit.
  EXTRACTION_CYCLE_LOCAL_MS_LIMIT: positiveInt.optional(),
})

export type ExtractionWorkerEnv =
  | { kind: 'unset' }
  | { kind: 'invalid'; keys: string[] }
  | { kind: 'ok'; url: string; secret: string }

const issueKeys = (e: z.ZodError) => e.issues.map((i) => String(i.path[0]))

/**
 * The extraction worker's address and secret, read from the two named keys only. Neither set is no
 * worker; the empty value `.env.example` ships counts as unset. A refusal names keys, never values.
 */
export function readExtractionWorkerEnv(
  rawEnv: Readonly<Record<string, string | undefined>>,
): ExtractionWorkerEnv {
  const env = {
    EXTRACTION_WORKER_URL: rawEnv.EXTRACTION_WORKER_URL || undefined,
    EXTRACTION_WORKER_SECRET: rawEnv.EXTRACTION_WORKER_SECRET || undefined,
  }
  if (env.EXTRACTION_WORKER_URL === undefined && env.EXTRACTION_WORKER_SECRET === undefined) {
    return { kind: 'unset' }
  }
  const parsed = workerEnvSchema.safeParse(env)
  if (!parsed.success) return { kind: 'invalid', keys: [...new Set(issueKeys(parsed.error))] }
  return {
    kind: 'ok',
    url: parsed.data.EXTRACTION_WORKER_URL,
    secret: parsed.data.EXTRACTION_WORKER_SECRET,
  }
}

export type ModelCycle =
  | {
      kind: 'READY'
      structurer: ModelStructurer
      budget: InMemoryModelBudget
      /** Writes the cycle's counters and flags. Never throws, and never changes a result. */
      finish(): Promise<void>
    }
  | { kind: 'MODEL_UNREACHABLE' }

export type ModelExtractionWiring = {
  readonly inputCeilingChars: number
  /**
   * The only way to a structurer: one cycle's budget and the structurer over it, behind the §5.3
   * preflight; HTML providers of that cycle share both. An unreachable model is a value, not a throw,
   * so the deterministic stages run, and with no structurer no record can be marked by the model.
   */
  prepareCycle(cycleId: string): Promise<ModelCycle>
}

export type ModelExtractionResult =
  { ok: true; wiring: ModelExtractionWiring | undefined } | { ok: false; keys: string[] }

/**
 * The collection side's model (ADR §2.4): a `ModelStructurer` over the extraction worker. No worker
 * URL and no secret is no model, the current behaviour; the empty value `.env.example` ships counts
 * as no value. A refusal names keys, never values. `store` and `log` are mandatory: the router has
 * no "no events" mode, so neither does its consumer (§5.3).
 */
export function buildModelExtraction(
  rawEnv: Readonly<Record<string, string | undefined>>,
  opts: {
    store: ModelHealthStore
    log: ModelHealthLog
    sleep?: (ms: number) => Promise<unknown>
  } & Pick<ExtractionWorkerAdapterConfig, 'fetchImpl'>,
): ModelExtractionResult {
  const worker = readExtractionWorkerEnv(rawEnv)
  if (worker.kind === 'unset') return { ok: true, wiring: undefined }
  // Read the named keys only, so nothing else in the process env is touched.
  const parsed = envSchema.safeParse(
    Object.fromEntries(Object.keys(envSchema.shape).map((k) => [k, rawEnv[k]])),
  )
  const keys = [
    ...(worker.kind === 'invalid' ? worker.keys : []),
    ...(parsed.success ? [] : issueKeys(parsed.error)),
  ]
  if (worker.kind === 'invalid' || !parsed.success) return { ok: false, keys: [...new Set(keys)] }
  const e = {
    ...parsed.data,
    EXTRACTION_WORKER_URL: worker.url,
    EXTRACTION_WORKER_SECRET: worker.secret,
  }
  const adapter = (onReply: ExtractionWorkerAdapterConfig['onReply']) =>
    createExtractionWorkerAdapter({
      baseUrl: e.EXTRACTION_WORKER_URL,
      secret: e.EXTRACTION_WORKER_SECRET,
      tableVersion: EXTRACTION_TABLE_VERSION,
      timeoutMs: WORKER_ADAPTER_TIMEOUT_MS,
      onReply,
      ...(opts.fetchImpl && { fetchImpl: opts.fetchImpl }),
    })
  const sleep = opts.sleep ?? delay
  const health = createModelHealth({ store: opts.store, log: opts.log })
  const inputCeilingChars = routerInputCeilingChars(
    {
      contextTokens: e.EXTRACTION_LOCAL_CONTEXT_TOKENS,
      maxAnswerTokens: e.EXTRACTION_LOCAL_MAX_ANSWER_TOKENS,
    },
    EXTRACTION_SYSTEM_PROMPT,
    // The whole table: a page cut for it fits any dose of it.
    smallDoseFor().groups,
  )
  return {
    ok: true,
    wiring: {
      inputCeilingChars,
      prepareCycle: async (cycleId) => {
        const cycle = health.beginCycle(cycleId)
        const reached = await reachModel(adapter(cycle.onPreflightReply), sleep, opts.log)
        await cycle.preflightDone(reached)
        if (!reached) return { kind: 'MODEL_UNREACHABLE' }
        const budget = new InMemoryModelBudget(
          HTML_MODEL_CALLS_PER_CYCLE,
          e.EXTRACTION_CYCLE_LOCAL_MS_LIMIT ?? Number.POSITIVE_INFINITY,
        )
        const structurer = new ModelStructurer({
          port: adapter(cycle.onReply),
          budget,
          timeoutMs: WORKER_STRUCTURER_TIMEOUT_MS,
          abandonedHoldMs: WORKER_HOLD_MS,
          inputCeilingChars,
        })
        return { kind: 'READY', structurer, budget, finish: cycle.finish }
      },
    },
  }
}

async function reachModel(
  port: ExtractionWorkerAdapter,
  sleep: (ms: number) => Promise<unknown>,
  log: ModelHealthLog,
): Promise<boolean> {
  const attempt = async (n: number) => {
    const { reached, status } = await port.preflight()
    if (!reached) log.error(`MODEL_PREFLIGHT_FAILED attempt=${n} status=${status ?? 'none'}`)
    return reached
  }
  if (await attempt(1)) return true
  for (const [i, gap] of PREFLIGHT_BACKOFF_MS.entries()) {
    await sleep(gap)
    if (await attempt(i + 2)) return true
  }
  return false
}
