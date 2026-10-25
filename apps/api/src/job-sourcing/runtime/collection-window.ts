import type { JobSourceType } from '@crm/shared'
import type { Logger } from '@nestjs/common'
import type { JobRunLedger } from '../ownership/job-run-ledger'
import type { JobRunWorker, RunReport } from './job-run-worker'

/**
 * The bounded collection window of one daily handler (r5 Task 2.5 T5; ADR
 * 2026-10-24-job-source-run-ownership.md, T5, SR-M-19, SR-L-19).
 *
 * Each pass: `recoverExpired` (EVERY iteration, so a run killed mid-window is recovered inside it),
 * then one claim for the free slots, for this handler's type set only, then a bounded wait that
 * ends early when a run finishes. The window ends when nothing was claimed, nothing runs and nothing
 * of the set is still due (`DRAINED`), or `windowMs` after `startedAt` (`WINDOW`), whichever comes first, and then closes
 * the cycle. Runs still in flight at the end keep their own deadline; the window does not wait for
 * them, so no slow run, hung ban store or hung database call can stretch it past `windowMs`.
 *
 * Every step is in its own try/catch and the function never rejects. The monotonic clock here is
 * the handler's own: the ledger takes no clock.
 */

export interface WindowDeps {
  readonly ledger: Pick<JobRunLedger, 'recoverExpired' | 'closeCycle' | 'countDue'>
  readonly worker: Pick<JobRunWorker, 'startDue' | 'activeRuns'>
  readonly logger: Pick<Logger, 'log' | 'warn' | 'error'>
  /** Monotonic milliseconds. Default `performance.now`. */
  readonly monotonicNow?: () => number
}

export interface CollectionWindowInput {
  readonly cycleId: string
  readonly types: readonly JobSourceType[]
  /** Measured from `startedAt`. */
  readonly windowMs: number
  /** The longest wait between two claims. */
  readonly intervalMs: number
  /** Spec seam only (the ledger's `onlyIds`): a spec on a shared database claims its own rows. */
  readonly onlyIds?: readonly string[] | undefined
  /** The handler's start, on the same clock as `monotonicNow`. Default: now. */
  readonly startedAt?: number
}

export interface WindowSummary {
  readonly ended: 'DRAINED' | 'WINDOW'
  readonly iterations: number
  readonly claimed: number
  readonly cycleClosed: boolean
}

const TIMED_OUT = Symbol('timed out')

/** `promise`, or `TIMED_OUT` after `ms` (unref-ed, always cleared). The promise itself is not cancelled. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, ms))
    timer.unref()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

const nameOf = (e: unknown): string => (e instanceof Error ? e.name : typeof e)

export async function runCollectionWindow(
  deps: WindowDeps,
  input: CollectionWindowInput,
): Promise<WindowSummary> {
  const now = deps.monotonicNow ?? (() => performance.now())
  const startedAt = input.startedAt ?? now()
  const remaining = (): number => input.windowMs - (now() - startedAt)
  const pending = new Set<Promise<unknown>>()
  let iterations = 0
  let claimed = 0
  let ended: WindowSummary['ended'] = 'WINDOW'

  // A step that throws or hangs is logged and skipped; it never stops the next step.
  const step = async <T>(label: string, work: () => Promise<T>): Promise<T | undefined> => {
    try {
      const out = await within(work(), remaining())
      if (out === TIMED_OUT) {
        deps.logger.warn(`collection window: ${label} did not settle within the window`)
        return undefined
      }
      return out
    } catch (error) {
      deps.logger.error(`collection window: ${label} failed (${nameOf(error)})`)
      return undefined
    }
  }

  while (remaining() > 0) {
    iterations += 1
    await step('recoverExpired', () => deps.ledger.recoverExpired())
    let claimedNow = 0
    const started = await step('claim', () =>
      deps.worker.startDue({
        cycleId: input.cycleId,
        onlyTypes: input.types,
        ...(input.onlyIds === undefined ? {} : { onlyIds: input.onlyIds }),
      }),
    )
    if (started !== undefined) {
      claimedNow = started.claimed
      claimed += claimedNow
      // Only a claim that started runs is waited on: a pass that claimed nothing hands back an
      // already-settled promise, and racing on it would wake the loop at once, every pass.
      if (claimedNow > 0) {
        const settled: Promise<RunReport[]> = started.settled.finally(() => pending.delete(settled))
        pending.add(settled)
        settled.catch(() => undefined)
      }
    }
    if (claimedNow === 0 && deps.worker.activeRuns === 0) {
      // Nothing of ours runs. Sources still due but not claimable (behind another replica's run on
      // their host) are waited for; a failed count counts as none, so a sick database ends the window.
      const due = await step('countDue', () =>
        deps.ledger.countDue({
          onlyTypes: input.types,
          ...(input.onlyIds === undefined ? {} : { onlyIds: input.onlyIds }),
        }),
      )
      if (due === undefined || due === 0) {
        ended = 'DRAINED'
        break
      }
    }
    const wait = Math.min(input.intervalMs, remaining())
    // Early wake-up: the next claim can use the slot (and the host) a finished run frees.
    await within(Promise.race([...pending]), wait)
  }

  let cycleClosed = false
  try {
    cycleClosed = await deps.ledger.closeCycle(input.cycleId)
  } catch (error) {
    deps.logger.error(`collection window: closing the cycle failed (${nameOf(error)})`)
  }
  deps.logger.log(
    `collection window ${ended}: iterations=${iterations}, claimed=${claimed}, running=${deps.worker.activeRuns}`,
  )
  return { ended, iterations, claimed, cycleClosed }
}
