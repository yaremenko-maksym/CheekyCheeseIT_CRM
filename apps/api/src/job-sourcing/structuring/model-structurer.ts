import type { ExtractionPort, ExtractionResult, InferenceErrorCode } from '@crm/inference'
import { z } from 'zod'
import { assertModelAllowed, type GateAllowed } from './ai-input-gate'
import { guardExtractionResult } from './extraction-result-guard'
import type {
  DiscoveredRecord,
  ExtractorStopCode,
  HtmlStructurer,
  HtmlStructurerRequest,
  RecordFailureCode,
  RecordIssue,
  StructuredRecord,
  StructurerOutcome,
  StructurerStop,
  UntrustedUrl,
} from './html-structurer.port'
import type { ModelBudgetPort, ModelUsage } from './model-budget.port'
import { buildExtractionPrompt } from './prompt-envelope'

/** One call may take this long before it is abandoned and its budget slot released. */
export const DEFAULT_STRUCTURER_TIMEOUT_MS = 120_000

/** The port only parses JSON; the shape is validated locally by the result guard. */
const ANY_JSON = z.unknown()

type Attempt =
  | { records: StructuredRecord[]; issue: RecordIssue | null }
  | { failed: RecordFailureCode }
  | { stop: StructurerStop }

const stopWith = (code: ExtractorStopCode): Attempt => ({
  stop: { kind: 'EXTRACTOR_FAILED', code },
})

/**
 * The port's documented error code is the ONLY input to classification: page text, model text and
 * error messages never are, so a page saying "quota" cannot look like exhaustion.
 */
const BY_INFERENCE_CODE: Readonly<Record<InferenceErrorCode, Attempt>> = {
  RATE_LIMITED: { stop: { kind: 'BUDGET_EXHAUSTED', cause: 'RATE_LIMITED' } },
  NOT_CONFIGURED: { stop: { kind: 'MODEL_UNAVAILABLE', code: 'NOT_CONFIGURED' } },
  PROVIDER_ERROR: { stop: { kind: 'MODEL_UNAVAILABLE', code: 'PROVIDER_ERROR' } },
  TIMEOUT: stopWith('TIMEOUT'),
  INVALID_OUTPUT: { failed: 'INVALID_OUTPUT' },
}

function classify(code: InferenceErrorCode): Attempt {
  // hasOwn: an untyped code such as `toString` must not resolve through the prototype.
  return Object.hasOwn(BY_INFERENCE_CODE, code) ? BY_INFERENCE_CODE[code] : stopWith('UNKNOWN_CODE')
}

type Settled<T> = { value: T } | { stopped: 'TIMEOUT' | 'PORT_THREW' | 'CANCELLED' }

/**
 * Waits for `work` at most `timeoutMs`, or until `signal` aborts. The port takes no signal, so an
 * abandoned call cannot be cancelled at the provider: its late result is ignored.
 */
function settle<T>(
  work: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<Settled<T>> {
  return new Promise((resolve) => {
    const finish = (settled: Settled<T>): void => {
      resolve(settled)
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = (): void => finish({ stopped: 'CANCELLED' })
    const timer = setTimeout(() => finish({ stopped: 'TIMEOUT' }), timeoutMs)
    signal?.addEventListener('abort', onAbort)
    work.then(
      (value) => finish({ value }),
      () => finish({ stopped: 'PORT_THREW' }),
    )
  })
}

/**
 * Started with the call: resolves when the call settles, or `capMs` after it STARTED at the latest.
 * Follow-up: the port takes no AbortSignal and the OpenRouter `onModelUnavailable` refresh hook is
 * unbounded, so only a signal threaded through the port can truly stop a call; this cap is a bound.
 */
function holdUntilSettled(call: Promise<unknown>, capMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, capMs)
    // A hold nobody waits on must not delay shutdown.
    timer.unref()
    const done = (): void => {
      clearTimeout(timer)
      resolve()
    }
    call.then(done, done)
  })
}

/** The inference adapters' own HTTP timeout per request (`DEFAULT_TIMEOUT_MS` there, pinned by a spec). */
export const PORT_HTTP_TIMEOUT_MS = 60_000
/**
 * HTTP requests one port call can send: the first and one parse retry, both repeated once after a
 * model swap on MODEL_UNAVAILABLE (OpenRouter adapter; pinned by a spec).
 */
export const MAX_REQUESTS_PER_PORT_CALL = 4
/** How long a call keeps its route busy at most, from its start: every request has timed out by then. */
export const DEFAULT_ABANDONED_HOLD_MS = PORT_HTTP_TIMEOUT_MS * MAX_REQUESTS_PER_PORT_CALL + 10_000
/** Node clamps a larger timer delay to 1 ms. */
export const MAX_TIMER_MS = 2 ** 31 - 1

function timerMs(name: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_TIMER_MS) {
    throw new Error(`${name} must be an integer in 1..${MAX_TIMER_MS}, got ${String(value)}`)
  }
  return value
}

export interface ModelStructurerOptions {
  readonly port: ExtractionPort
  /** Shared by every HTML provider of the cycle. */
  readonly budget: ModelBudgetPort
  readonly timeoutMs?: number
  /** After a timeout or an abort, the route stays busy until the call settles or this elapses. */
  readonly abandonedHoldMs?: number
}

/**
 * `HtmlStructurer` over an `ExtractionPort`. One instance per model route: its runs are queued, and
 * an abandoned call keeps the queue held, so a route has one call in flight. Per record: gate →
 * contact strip + envelope (input cap) → budget reserve → extract with timeout → result guard
 * (output cap). Persists nothing.
 */
export class ModelStructurer implements HtmlStructurer {
  private readonly timeoutMs: number
  private readonly abandonedHoldMs: number
  private queue: Promise<unknown> = Promise.resolve()
  /** The last abandoned call's hold; already resolved when nothing was abandoned. */
  private held: Promise<void> = Promise.resolve()

  constructor(private readonly options: ModelStructurerOptions) {
    this.timeoutMs = timerMs('timeoutMs', options.timeoutMs ?? DEFAULT_STRUCTURER_TIMEOUT_MS)
    this.abandonedHoldMs = timerMs(
      'abandonedHoldMs',
      options.abandonedHoldMs ?? DEFAULT_ABANDONED_HOLD_MS,
    )
  }

  structure(request: HtmlStructurerRequest): Promise<StructurerOutcome> {
    const run = this.queue.then(() => this.run(request))
    // A failed run must not block the route's queue; an abandoned call holds it.
    this.queue = run.catch(() => undefined).then(() => this.held)
    return run
  }

  private async run(request: HtmlStructurerRequest): Promise<StructurerOutcome> {
    const gate = assertModelAllowed(request.aiInput, request.policy)
    if (gate === 'BLOCKED_AI_INPUT_NO') return { kind: 'SKIPPED_AI_INPUT_NO' }
    if (gate === 'BLOCKED_AI_INPUT_UNSPECIFIED') return { kind: 'SKIPPED_AI_INPUT_UNSPECIFIED' }

    const { extractionVersion } = request
    const records: StructuredRecord[] = []
    const perRecordIssues: RecordIssue[] = []
    let anySucceeded = false
    let firstFailure: RecordFailureCode | null = null
    for (const [index, record] of request.records.entries()) {
      const attempt = await this.attempt(gate, record, request.signal)
      if ('stop' in attempt) {
        const remainingIds = request.records.slice(index).map(({ id }) => id)
        if (index === 0) return { ...attempt.stop, remainingIds, perRecordIssues }
        return {
          kind: 'PARTIAL',
          extractionVersion,
          records,
          perRecordIssues,
          remainingIds,
          stoppedBy: attempt.stop,
        }
      }
      if ('failed' in attempt) {
        firstFailure ??= attempt.failed
        perRecordIssues.push({
          id: record.id,
          failure: attempt.failed,
          droppedRecords: 0,
          nulledUrls: 0,
          droppedEvidence: 0,
        })
      } else {
        anySucceeded = true
        records.push(...attempt.records)
        if (attempt.issue !== null) perRecordIssues.push(attempt.issue)
      }
    }
    // Every record's reply was unusable: the extractor, not the page, failed. The issues name them.
    if (firstFailure !== null && !anySucceeded) {
      return { kind: 'EXTRACTOR_FAILED', code: firstFailure, remainingIds: [], perRecordIssues }
    }
    return { kind: 'EXTRACTED', extractionVersion, records, perRecordIssues }
  }

  private async attempt(
    gate: GateAllowed,
    record: DiscoveredRecord,
    signal: AbortSignal | undefined,
  ): Promise<Attempt> {
    if (signal?.aborted === true) return stopWith('CANCELLED')
    const prompt = buildExtractionPrompt(gate, record.text)
    const { port, budget } = this.options
    const reservation = budget.reserve()
    if (reservation === null) {
      return { stop: { kind: 'BUDGET_EXHAUSTED', cause: 'CYCLE_LIMIT' } }
    }
    let call: Promise<ExtractionResult<unknown>>
    try {
      call = Promise.resolve(
        port.extract({ input: prompt.user, instruction: prompt.system, schema: ANY_JSON }),
      )
    } catch {
      // Thrown before any promise existed: no request was sent, the slot goes back.
      budget.release(reservation)
      return stopWith('PORT_THREW')
    }
    // A request may have reached the provider and be billed: the slot is consumed unless proven
    // otherwise. A timeout or an abort is uncertain, so it is consumed too.
    let sent = true
    let usage: ModelUsage | undefined
    // Measured from the call's start: the timeout path must not shorten it.
    const hold = holdUntilSettled(call, this.abandonedHoldMs)
    try {
      const settled = await settle(call, this.timeoutMs, signal)
      if ('stopped' in settled) {
        this.held = hold
        return stopWith(settled.stopped)
      }
      const result = settled.value
      if (!result.ok) {
        // NOT_CONFIGURED: the adapter had no route or key, so nothing was sent.
        sent = result.code !== 'NOT_CONFIGURED'
        return classify(result.code)
      }
      usage = result.usage

      let raw: string | undefined
      try {
        raw = JSON.stringify(result.data)
      } catch {
        // A BigInt or a cycle: not JSON, handled below.
      }
      if (raw === undefined) return { failed: 'NOT_JSON' }
      const guarded = guardExtractionResult(raw, {
        evidenceText: prompt.user,
        verifiedUrls: [record.url],
      })
      if (!guarded.ok) return { failed: guarded.reason }

      const { droppedRecords, nulledUrls, droppedEvidence } = guarded
      return {
        records: guarded.records.map((extracted) => ({
          ...extracted,
          sourceId: record.id,
          postingUrl: extracted.postingUrl as UntrustedUrl | null,
          applyUrl: extracted.applyUrl as UntrustedUrl | null,
        })),
        issue:
          droppedRecords + nulledUrls + droppedEvidence > 0
            ? { id: record.id, failure: null, droppedRecords, nulledUrls, droppedEvidence }
            : null,
      }
    } finally {
      // Exactly one settlement per reservation.
      if (sent) budget.commit(reservation, usage)
      else budget.release(reservation)
    }
  }
}
