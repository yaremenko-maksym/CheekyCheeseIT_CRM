/**
 * One retry for a failed model call of a resume run: the `/resume-write` and `/resume-tailor`
 * writer calls (spaced and retried through a per-run `WriterPace`) and every Jev decision request
 * (entailment, tailored decisions). The second failure is returned as the first one is today.
 */
import { Logger } from '@nestjs/common'
import { DEFAULT_TIMEOUT_MS, type DecisionPort, type DecisionRequest } from '@crm/inference'

/** A writer retry waits this long, so a provider's per-minute limit can pass (Groq: 1 min windows). */
export const WRITER_RETRY_DELAY_MS = 20_000
/** Writer calls of one run start at least this far apart: at most 30 a minute (Groq free RPM). */
export const WRITER_CALL_GAP_MS = 2_000
/** A Jev retry waits this long before its one retry. */
export const JEV_RETRY_DELAY_MS = 5_000
/**
 * What a Jev retry can add to a run: the delay plus one call at the adapter's default timeout. One
 * budget check can be followed by several Jev requests in a row (`decideAll` and `scoreEntailment`
 * send one request per 50 questions), so a retry is taken only while the run's deadline still holds
 * this much (`decideRetrying`'s `budgetLeftMs`).
 */
export const JEV_RETRY_COST_MS = JEV_RETRY_DELAY_MS + DEFAULT_TIMEOUT_MS

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** The per-run spacing and retry delay of writer calls. */
export interface WriterPace {
  /** Waits until `WRITER_CALL_GAP_MS` after the start of the run's previous writer call. */
  gap(): Promise<void>
  /** Sleeps `WRITER_RETRY_DELAY_MS` and is true; false at once when the delay would end past the run budget. */
  retryDelay(): Promise<boolean>
}

/** No spacing, no retry: a caller without a run budget (tests, one-off calls). */
export const NO_WRITER_PACE: WriterPace = {
  gap: () => Promise.resolve(),
  retryDelay: () => Promise.resolve(false),
}

/** `budgetLeftMs`: what is left of the run budget now; a retry delay must end inside it. */
export function writerPace(budgetLeftMs: () => number): WriterPace {
  // -Infinity: the first call of a run never waits.
  let lastStart = Number.NEGATIVE_INFINITY
  return {
    async gap() {
      const wait = lastStart + WRITER_CALL_GAP_MS - Date.now()
      if (wait > 0) await sleep(wait)
      lastStart = Date.now()
    },
    async retryDelay() {
      if (budgetLeftMs() < WRITER_RETRY_DELAY_MS) return false
      await sleep(WRITER_RETRY_DELAY_MS)
      return true
    },
  }
}

/** Reasons a minute's wait cannot fix: the provider day, a missing route, a request refused before sending. */
const FINAL_WRITER_REASONS: ReadonlySet<string> = new Set([
  'LIMITS_EXHAUSTED',
  'NOT_CONFIGURED',
  'INVALID_INPUT',
])

/**
 * One writer call: the gap, the run check (budget, ownership), the call; an `unavailable` reply is
 * retried once after `retryDelay`, checked again. The second reply is returned whatever it is.
 */
export async function callWriter<R extends { kind: string }>(
  deps: { pace: WriterPace; beforeModelCall(): Promise<void> },
  call: () => Promise<R>,
): Promise<R> {
  for (let attempt = 1; ; attempt++) {
    await deps.pace.gap()
    await deps.beforeModelCall()
    const reply = await call()
    const retryable =
      reply.kind === 'unavailable' &&
      !FINAL_WRITER_REASONS.has((reply as { reason?: unknown }).reason as string)
    if (attempt === 2 || !retryable || !(await deps.pace.retryDelay())) return reply
  }
}

type DecisionResult = Awaited<ReturnType<DecisionPort['decide']>>
/** A failed decision: the adapter's code, or the class name of a thrown port (never its message). */
export type DecisionFailure = { ok: false; code: string }

/** Codes a short wait can fix: the adapter codes a transport failure (and a bad body) PROVIDER_ERROR. */
const RETRY_DECISION_CODES: ReadonlySet<string> = new Set([
  'RATE_LIMITED',
  'TIMEOUT',
  'PROVIDER_ERROR',
])

const logger = new Logger('JevDecision')

/** One decision request; a thrown port becomes a failure that is always worth a retry. */
async function decideOnce(
  port: DecisionPort,
  req: DecisionRequest,
): Promise<
  | { result: DecisionResult | DecisionFailure; retry: false }
  | { result: DecisionFailure; retry: true }
> {
  try {
    const result = await port.decide(req)
    if (result.ok || !RETRY_DECISION_CODES.has(result.code)) return { result, retry: false }
    return { result, retry: true }
  } catch (err) {
    return { result: { ok: false, code: err instanceof Error ? err.name : 'unknown' }, retry: true }
  }
}

/**
 * One Jev decision request, retried once after `JEV_RETRY_DELAY_MS` on `RATE_LIMITED`, `TIMEOUT`,
 * `PROVIDER_ERROR` or a thrown port. Never throws. A second failure, or a first one the deadline has
 * no room to retry, logs one line (codes only).
 */
export async function decideRetrying(
  port: DecisionPort,
  req: DecisionRequest,
  /** What is left before the run's deadline; the retry is skipped below `JEV_RETRY_COST_MS`. */
  budgetLeftMs: () => number = () => Number.POSITIVE_INFINITY,
): Promise<DecisionResult | DecisionFailure> {
  const first = await decideOnce(port, req)
  if (!first.retry) return first.result
  if (budgetLeftMs() < JEV_RETRY_COST_MS) return unavailable(first.result, 1)
  await sleep(JEV_RETRY_DELAY_MS)
  const { result } = await decideOnce(port, req)
  return result.ok ? result : unavailable(result, 2)
}

/** Logs the failure that ends a Jev request (codes only) and returns it. */
function unavailable(result: DecisionFailure, attempts: number): DecisionFailure {
  logger.warn(
    JSON.stringify({
      event: 'jev_decision_unavailable',
      provider: 'jev',
      cause: result.code,
      attempts,
    }),
  )
  return result
}
