import {
  createExtractionWorkerAdapter,
  createExtractionWorkerTransport,
  INFERENCE_ERROR_CODES,
  MAX_HOSTED_BUDGET_MS,
  routerCallCeilingMs,
  routerInputCeilingChars,
  type ExtractionWorkerAdapter,
  type ExtractionWorkerAdapterConfig,
  type WorkerReadiness,
} from '@crm/inference'
import { z } from 'zod'
import {
  blockPickReplySchema,
  EXTRACTION_TABLE_VERSION,
  isUsableWorkerSecret,
  type BlockPickReply,
  type PickBlocksBody,
} from '../../extraction-worker/link-contract'
import { HTML_MODEL_CALLS_PER_CYCLE, InMemoryModelBudget } from './model-budget.port'
import { createModelHealth, type ModelHealthLog, type ModelHealthStore } from './model-health'
import { ModelStructurer } from './model-structurer'
import { EXTRACTION_SYSTEM_PROMPT } from './prompt-envelope'

/**
 * The collection side never sees the worker's router config, so it takes the package maxima: no
 * configured router call outlasts this (ADR §5.5 item 2).
 */
const CALL_CEILING_MS = routerCallCeilingMs({ hostedBudgetMs: MAX_HOSTED_BUDGET_MS })
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
  'EXTRACTION_INPUT_CONTEXT_TOKENS',
  'EXTRACTION_INPUT_MAX_ANSWER_TOKENS',
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
  // The input window the page is cut to before it leaves (§2.1, H.4): the smallest hosted window.
  EXTRACTION_INPUT_CONTEXT_TOKENS: positiveInt,
  EXTRACTION_INPUT_MAX_ANSWER_TOKENS: positiveInt,
})

/** The smallest hosted input window as deploy writes it; null when unset or malformed. */
export function readExtractionInputWindow(
  rawEnv: Readonly<Record<string, string | undefined>>,
): { contextTokens: number; maxAnswerTokens: number } | null {
  const w = envSchema.safeParse({
    EXTRACTION_INPUT_CONTEXT_TOKENS: rawEnv['EXTRACTION_INPUT_CONTEXT_TOKENS'],
    EXTRACTION_INPUT_MAX_ANSWER_TOKENS: rawEnv['EXTRACTION_INPUT_MAX_ANSWER_TOKENS'],
  })
  return w.success
    ? {
        contextTokens: w.data.EXTRACTION_INPUT_CONTEXT_TOKENS,
        maxAnswerTokens: w.data.EXTRACTION_INPUT_MAX_ANSWER_TOKENS,
      }
    : null
}

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
      /**
       * `READY` runs the model stage. `LIMITS_EXHAUSTED` (H.3): every route is limit-blocked, so the
       * structurer stops each record with the H.2 stop and calls the worker zero times.
       */
      kind: 'READY' | 'LIMITS_EXHAUSTED'
      structurer: ModelStructurer
      budget: InMemoryModelBudget
      /** Writes the cycle's counters and flags. Never throws, and never changes a result. */
      finish(): Promise<void>
    }
  | { kind: 'MODEL_UNREACHABLE' }

export type ModelExtractionWiring = {
  readonly inputCeilingChars: number
  /**
   * The only way to a structurer: one cycle's budget and the structurer over it, behind the H.3
   * readiness preflight; HTML providers of that cycle share both. An unreachable model is a value, not a throw,
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
  const health = createModelHealth({ store: opts.store, log: opts.log })
  const inputCeilingChars = routerInputCeilingChars(
    {
      contextTokens: e.EXTRACTION_INPUT_CONTEXT_TOKENS,
      maxAnswerTokens: e.EXTRACTION_INPUT_MAX_ANSWER_TOKENS,
    },
    EXTRACTION_SYSTEM_PROMPT,
  )
  return {
    ok: true,
    wiring: {
      inputCeilingChars,
      prepareCycle: async (cycleId) => {
        const cycle = health.beginCycle(cycleId)
        const readiness = await readModel(adapter(cycle.onPreflightReply), opts.log)
        await cycle.preflightDone(readiness)
        if (readiness !== 'READY' && readiness !== 'LIMITS_EXHAUSTED') {
          return { kind: 'MODEL_UNREACHABLE' }
        }
        const budget = new InMemoryModelBudget(HTML_MODEL_CALLS_PER_CYCLE)
        const structurer = new ModelStructurer({
          port: adapter(cycle.onReply),
          onResult: cycle.onResult,
          budget,
          timeoutMs: WORKER_STRUCTURER_TIMEOUT_MS,
          abandonedHoldMs: WORKER_HOLD_MS,
          inputCeilingChars,
          limitsExhausted: readiness === 'LIMITS_EXHAUSTED',
        })
        return { kind: readiness, structurer, budget, finish: cycle.finish }
      },
    },
  }
}

/**
 * External vacancy intake (spec §D): a fresh structurer per manual parse, over the same worker
 * adapter the collection side uses. Each one has its own one-call budget, never a cycle's, and the
 * caller's short timeout; the transport outlives it by a margin, as above. There is no preflight
 * and no health record: a manual parse stores nothing, so the reply's events are dropped.
 * `undefined` when the worker env is unset or invalid (the caller answers its outage). The input
 * window is optional here: unset, the text is cut by the caller's own cap only.
 */
export function buildManualStructurer(
  rawEnv: Readonly<Record<string, string | undefined>>,
  opts: { timeoutMs: number } & Pick<ExtractionWorkerAdapterConfig, 'fetchImpl'>,
): (() => ModelStructurer) | undefined {
  const worker = readExtractionWorkerEnv(rawEnv)
  if (worker.kind !== 'ok') return undefined
  const window = readExtractionInputWindow(rawEnv)
  const inputCeilingChars = window && routerInputCeilingChars(window, EXTRACTION_SYSTEM_PROMPT)
  const port = createExtractionWorkerAdapter({
    baseUrl: worker.url,
    secret: worker.secret,
    tableVersion: EXTRACTION_TABLE_VERSION,
    timeoutMs: opts.timeoutMs + MARGIN_MS,
    // Stryker disable next-line BlockStatement: equivalent — the sink is a no-op on purpose
    onReply: () => {},
    ...(opts.fetchImpl && { fetchImpl: opts.fetchImpl }),
  })
  return () =>
    new ModelStructurer({
      port,
      budget: new InMemoryModelBudget(1),
      timeoutMs: opts.timeoutMs,
      ...(inputCeilingChars && { inputCeilingChars }),
    })
}

/** A pick's block ids, or a value-free reason it failed (a transport kind, a worker code, `INVALID_REPLY`). */
export type BlockPickOutcome = { ok: true; reply: BlockPickReply } | { ok: false; reason: string }
/** One `/pick-blocks` call; the table version is the picker's own. Never throws. */
export type BlockPicker = (body: Omit<PickBlocksBody, 'tableVersion'>) => Promise<BlockPickOutcome>

/** The worker's reply envelope; the events and health it also carries are not recorded here. */
const pickEnvelopeSchema = z.object({
  result: z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), data: blockPickReplySchema }),
    z.object({ ok: z.literal(false), code: z.enum(INFERENCE_ERROR_CODES) }),
  ]),
})

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    // not JSON: it fails the envelope schema
  }
  return undefined
}

/**
 * Bookmarklet block map: the worker's `/pick-blocks` over its private transport, in the caller's
 * timeout. Like a manual parse it stores nothing, so there is no preflight and no health record.
 * `undefined` when the worker env is unset or invalid (the caller answers its outage).
 */
export function buildBlockPicker(
  rawEnv: Readonly<Record<string, string | undefined>>,
  opts: { timeoutMs: number } & Pick<ExtractionWorkerAdapterConfig, 'fetchImpl'>,
): BlockPicker | undefined {
  const worker = readExtractionWorkerEnv(rawEnv)
  if (worker.kind !== 'ok') return undefined
  const post = createExtractionWorkerTransport({
    baseUrl: worker.url,
    secret: worker.secret,
    ...(opts.fetchImpl && { fetchImpl: opts.fetchImpl }),
  })
  return async (body) => {
    const res = await post('/pick-blocks', {
      body: JSON.stringify({ ...body, tableVersion: EXTRACTION_TABLE_VERSION }),
      timeoutMs: opts.timeoutMs,
    })
    if (res.kind !== 'ok') return { ok: false, reason: res.kind }
    const parsed = pickEnvelopeSchema.safeParse(parseJson(res.text))
    if (!parsed.success) return { ok: false, reason: 'INVALID_REPLY' }
    const { result } = parsed.data
    return result.ok ? { ok: true, reply: result.data } : { ok: false, reason: result.code }
  }
}

/** One attempt, no backoff (H.3): a worker that is down is retried by the next cycle. */
async function readModel(
  port: ExtractionWorkerAdapter,
  log: ModelHealthLog,
): Promise<WorkerReadiness['readiness']> {
  const answer = await port.preflight()
  if (answer.readiness === 'UNREACHABLE') {
    log.error(`MODEL_PREFLIGHT_FAILED readiness=UNREACHABLE status=${answer.status ?? 'none'}`)
  } else if (answer.readiness === 'NO_ROUTE') {
    log.error('MODEL_PREFLIGHT_FAILED readiness=NO_ROUTE')
  }
  return answer.readiness
}
