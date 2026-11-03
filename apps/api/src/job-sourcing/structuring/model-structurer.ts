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
  | { kind: 'done'; records: StructuredRecord[]; issue: RecordIssue | null }
  | { kind: 'failed'; code: RecordFailureCode }
  | { kind: 'stop'; stop: StructurerStop }

const stopWith = (code: ExtractorStopCode): Attempt => ({
  kind: 'stop',
  stop: { kind: 'EXTRACTOR_FAILED', code },
})

/**
 * The port's documented error code is the ONLY input to classification: page text, model text and
 * error messages never are, so a page saying "quota" cannot look like exhaustion.
 */
const BY_INFERENCE_CODE: Readonly<Record<InferenceErrorCode, Attempt>> = {
  RATE_LIMITED: { kind: 'stop', stop: { kind: 'BUDGET_EXHAUSTED', cause: 'RATE_LIMITED' } },
  NOT_CONFIGURED: { kind: 'stop', stop: { kind: 'MODEL_UNAVAILABLE', code: 'NOT_CONFIGURED' } },
  PROVIDER_ERROR: { kind: 'stop', stop: { kind: 'MODEL_UNAVAILABLE', code: 'PROVIDER_ERROR' } },
  TIMEOUT: stopWith('TIMEOUT'),
  INVALID_OUTPUT: { kind: 'failed', code: 'INVALID_OUTPUT' },
}

function classify(code: InferenceErrorCode): Attempt {
  // hasOwn: an untyped code such as `toString` must not resolve through the prototype.
  return Object.hasOwn(BY_INFERENCE_CODE, code) ? BY_INFERENCE_CODE[code] : stopWith('UNKNOWN_CODE')
}

type Settled<T> =
  { kind: 'done'; value: T } | { kind: 'stopped'; code: 'TIMEOUT' | 'PORT_THREW' | 'CANCELLED' }

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
    const onAbort = (): void => finish({ kind: 'stopped', code: 'CANCELLED' })
    const timer = setTimeout(() => finish({ kind: 'stopped', code: 'TIMEOUT' }), timeoutMs)
    signal?.addEventListener('abort', onAbort)
    work.then(
      (value) => finish({ kind: 'done', value }),
      () => finish({ kind: 'stopped', code: 'PORT_THREW' }),
    )
  })
}

export interface ModelStructurerOptions {
  readonly port: ExtractionPort
  /** Shared by every HTML provider of the cycle. */
  readonly budget: ModelBudgetPort
  readonly timeoutMs?: number
}

/**
 * `HtmlStructurer` over an `ExtractionPort`. One instance per model route: its runs are queued, so a
 * route has one call in flight. Per record: gate → contact strip + envelope (input cap) → budget
 * reserve → extract with timeout → result guard (output cap). Persists nothing.
 */
export class ModelStructurer implements HtmlStructurer {
  private readonly timeoutMs: number
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: ModelStructurerOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_STRUCTURER_TIMEOUT_MS
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error(`timeoutMs must be a positive integer, got ${String(this.timeoutMs)}`)
    }
  }

  structure(request: HtmlStructurerRequest): Promise<StructurerOutcome> {
    const run = this.queue.then(() => this.run(request))
    // A failed run must not block the route's queue.
    this.queue = run.catch(() => undefined)
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
      if (attempt.kind === 'stop') {
        const remainingIds = request.records.slice(index).map(({ id }) => id)
        if (index === 0) return { ...attempt.stop, remainingIds }
        return {
          kind: 'PARTIAL',
          extractionVersion,
          records,
          perRecordIssues,
          remainingIds,
          stoppedBy: attempt.stop,
        }
      }
      if (attempt.kind === 'failed') {
        firstFailure ??= attempt.code
        perRecordIssues.push({
          id: record.id,
          failure: attempt.code,
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
    // Every record's reply was unusable: the extractor, not the page, failed.
    if (firstFailure !== null && !anySucceeded) {
      return { kind: 'EXTRACTOR_FAILED', code: firstFailure, remainingIds: [] }
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
      return { kind: 'stop', stop: { kind: 'BUDGET_EXHAUSTED', cause: 'CYCLE_LIMIT' } }
    }
    let usable: { usage?: ModelUsage } | null = null
    try {
      // The executor turns a synchronous throw from the port into a rejection.
      const call = new Promise<ExtractionResult<unknown>>((resolve) => {
        resolve(port.extract({ input: prompt.user, instruction: prompt.system, schema: ANY_JSON }))
      })
      const settled = await settle(call, this.timeoutMs, signal)
      if (settled.kind === 'stopped') return stopWith(settled.code)
      const result = settled.value
      if (!result.ok) return classify(result.code)

      let raw: string | undefined
      try {
        raw = JSON.stringify(result.data)
      } catch {
        // A BigInt or a cycle: not JSON, handled below.
      }
      if (raw === undefined) return { kind: 'failed', code: 'NOT_JSON' }
      const guarded = guardExtractionResult(raw, {
        evidenceText: prompt.user,
        verifiedUrls: [record.url],
      })
      if (!guarded.ok) return { kind: 'failed', code: guarded.reason }

      usable = result
      const { droppedRecords, nulledUrls, droppedEvidence } = guarded
      return {
        kind: 'done',
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
      // Exactly one settlement per reservation: only a usable reply consumes the slot.
      if (usable === null) budget.release(reservation)
      else budget.commit(reservation, usable.usage)
    }
  }
}
