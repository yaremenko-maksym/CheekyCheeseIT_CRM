import {
  createExtractionWorkerAdapter,
  MAX_FLOOR_BUDGET_MS,
  MAX_HOSTED_BUDGET_MS,
  routerCallCeilingMs,
  routerInputCeilingChars,
  type ExtractionWorkerAdapterConfig,
} from '@crm/inference'
import { z } from 'zod'
import { EXTRACTION_TABLE_VERSION, isUsableWorkerSecret } from '../../extraction-worker/schema'
import { HTML_MODEL_CALLS_PER_CYCLE, InMemoryModelBudget } from './model-budget.port'
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

/** The only env the collection side reads for the model. No hosted key, no router URL (§2.4). */
export const MODEL_EXTRACTION_ENV_KEYS = [
  'EXTRACTION_WORKER_URL',
  'EXTRACTION_WORKER_SECRET',
  'EXTRACTION_LOCAL_CONTEXT_TOKENS',
  'EXTRACTION_LOCAL_MAX_ANSWER_TOKENS',
  'EXTRACTION_CYCLE_LOCAL_MS_LIMIT',
] as const

const positiveInt = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().positive())

const envSchema = z.object({
  EXTRACTION_WORKER_URL: z.url({ protocol: /^https?$/ }).refine((u) => {
    const url = new URL(u)
    return url.username === '' && url.password === ''
  }),
  EXTRACTION_WORKER_SECRET: z.string().refine(isUsableWorkerSecret),
  // The worker's local route window: the page is cut to it before it leaves (§2.1).
  EXTRACTION_LOCAL_CONTEXT_TOKENS: positiveInt,
  EXTRACTION_LOCAL_MAX_ANSWER_TOKENS: positiveInt,
  // Frozen from MP-04 (§5.5 item 6); unset is no local-time limit.
  EXTRACTION_CYCLE_LOCAL_MS_LIMIT: positiveInt.optional(),
})

export type ModelExtractionWiring = {
  readonly inputCeilingChars: number
  /** One cycle's budget and the structurer over it; HTML providers of that cycle share both. */
  forCycle(): { structurer: ModelStructurer; budget: InMemoryModelBudget }
}

export type ModelExtractionResult =
  { ok: true; wiring: ModelExtractionWiring | undefined } | { ok: false; keys: string[] }

/**
 * The collection side's model (ADR §2.4): a `ModelStructurer` over the extraction worker. No worker
 * URL and no secret is no model, the current behaviour. A refusal names keys, never values.
 */
export function buildModelExtraction(
  rawEnv: Readonly<Record<string, string | undefined>>,
  opts: Pick<ExtractionWorkerAdapterConfig, 'onReply' | 'fetchImpl'>,
): ModelExtractionResult {
  // Read the named keys only, so nothing else in the process env is touched.
  const env = Object.fromEntries(MODEL_EXTRACTION_ENV_KEYS.map((k) => [k, rawEnv[k]]))
  if (env.EXTRACTION_WORKER_URL === undefined && env.EXTRACTION_WORKER_SECRET === undefined) {
    return { ok: true, wiring: undefined }
  }
  const parsed = envSchema.safeParse(env)
  if (!parsed.success) {
    return { ok: false, keys: [...new Set(parsed.error.issues.map((i) => String(i.path[0])))] }
  }
  const e = parsed.data
  const port = createExtractionWorkerAdapter({
    baseUrl: e.EXTRACTION_WORKER_URL,
    secret: e.EXTRACTION_WORKER_SECRET,
    tableVersion: EXTRACTION_TABLE_VERSION,
    timeoutMs: WORKER_ADAPTER_TIMEOUT_MS,
    onReply: opts.onReply,
    ...(opts.fetchImpl && { fetchImpl: opts.fetchImpl }),
  })
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
      forCycle: () => {
        const budget = new InMemoryModelBudget(
          HTML_MODEL_CALLS_PER_CYCLE,
          e.EXTRACTION_CYCLE_LOCAL_MS_LIMIT ?? Number.POSITIVE_INFINITY,
        )
        const structurer = new ModelStructurer({
          port,
          budget,
          timeoutMs: WORKER_STRUCTURER_TIMEOUT_MS,
          abandonedHoldMs: WORKER_HOLD_MS,
          inputCeilingChars,
        })
        return { structurer, budget }
      },
    },
  }
}
