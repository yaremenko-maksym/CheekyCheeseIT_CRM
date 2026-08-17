/**
 * Cross-process exclusive lock for `app.module.container.spec.ts`'s build
 * cache (backlog #42, review rounds MED-2/MED-3 on PR #550).
 *
 * Extracted from the spec into its own module (mirrors `integration-run-mode.ts`
 * next to it) so the locking logic has its own dedicated, fast unit spec
 * (`build-lock.spec.ts`) instead of only being exercised indirectly, at full
 * `tsc` build cost, through the container spec.
 *
 * ============================================================================
 * WHY THIS EXISTS: A DEAD LOCK HOLDER MUST NOT PERMANENTLY WEDGE THE NEXT RUN
 * ============================================================================
 * The lock itself (an earlier revision of this mechanism) was already safe
 * against silent corruption — a holder that dies mid-build leaves the lock
 * directory behind, and any waiter times out loudly after its deadline rather
 * than proceeding against a possibly-incomplete cache. But "loud failure with
 * no automatic recovery" is still a real cost: this repo runs multiple agents,
 * each in their own worktree, and a session-limit cutoff mid-`beforeAll` (a
 * real, observed failure mode — four agents died on session limits the day
 * this was written) leaves EXACTLY this shape of orphaned lock behind. The
 * next process in that same worktree would wait out the full deadline for
 * nothing and then fail with an error that gives no hint that the fix is a
 * one-line `rm -rf` of a directory it has no way to know about on its own.
 *
 * ============================================================================
 * RECLAIM STRATEGY: PID LIVENESS IS AUTHORITATIVE; AGE IS SUBORDINATE, NOT AN OR
 * ============================================================================
 * (Revised in review round MED-3 — the original design evicted on "PID dead
 * OR age > threshold", treating the two as independent, either-is-enough
 * signals. That was wrong FOR THIS LOCK'S ACTUAL DEPLOYMENT: its only real
 * use is one checkout, one machine, one process table — and in that world
 * `process.kill(pid, 0)` is ALWAYS authoritative. Under real measured
 * contention — 12-15 s for two concurrent `tsc` builds, 17-25 s for three,
 * extrapolating toward the old 60 s age threshold as concurrent agents grow
 * (this repo has run five in one session) — "age > threshold" stopped
 * meaning "the recorded PID is probably stale" and started meaning "the
 * build is alive and just slow", which is exactly the case this mechanism
 * must NOT evict: doing so hands two live `tsc` invocations the same output
 * directory at once, the precise class of bug MED-1/MED-2 exist to prevent.)
 *
 * Every lock directory carries a `holder.json` (`{ pid, startedAt }`),
 * written the instant the directory is created. A waiter that hits `EEXIST`
 * classifies the existing holder's PID into exactly one of three states via
 * `pidLiveness`:
 *
 *   - `'alive'` — `process.kill(pid, 0)` succeeded, or failed with `EPERM`
 *     (the process exists; this user simply cannot signal it — `EPERM` is
 *     only raised for a PID that IS present). Respected UNCONDITIONALLY,
 *     no matter how old `startedAt` is. This is the fix: age can no longer
 *     override a PID the OS confirms is running.
 *   - `'dead'` — `process.kill(pid, 0)` failed with `ESRCH` (no such
 *     process). Reclaimed immediately, regardless of age — the fast path,
 *     unchanged from MED-2.
 *   - `'unknown'` — `process.kill` failed with anything else, or the
 *     `holder.json` itself could not be parsed into a well-formed `{ pid,
 *     startedAt }`. The ONLY state where age is still consulted: this
 *     lock's real domain (one checkout, one machine) makes this
 *     essentially unreachable today (see above), but the code does not
 *     assume that will always hold — a future cross-host/cross-container
 *     use, or a genuinely corrupt-but-parseable record, lands here, and
 *     for THAT case a coarse "probably abandoned" signal is still better
 *     than either "wait forever" or "evict a possibly-live unknown". The
 *     age threshold for this branch is deliberately generous (see
 *     `DEFAULT_STALE_AGE_MS` below) — for an owner that cannot be
 *     confirmed either way, the cost of waiting longer is lower than the
 *     cost of a wrongful eviction.
 *
 * A missing/unreadable `holder.json` (the brief window between `mkdirSync`
 * creating the directory and the very next line writing the file, or a
 * corrupt file) is treated as "unknown ownership, no data to age against" —
 * `isStaleHolder` returns `false` immediately, never falling through to the
 * age check (there is no `startedAt` to measure). A waiter just retries.
 *
 * ============================================================================
 * THE TWO DEFAULT TIMEOUTS MUST AGREE WITH EACH OTHER (review round MED-4)
 * ============================================================================
 * `DEFAULT_STALE_AGE_MS` and `DEFAULT_DEADLINE_MS` are two independently
 * "reasonable-looking" numbers that are only actually correct in relation to
 * EACH OTHER: the `'unknown'`-liveness auto-reclaim branch above can only
 * ever fire for a lock that is still being waited on, i.e. before the
 * waiter's own `deadlineMs` gives up. A prior revision set
 * `DEFAULT_STALE_AGE_MS` (5 min) LARGER than `DEFAULT_DEADLINE_MS` (3 min) —
 * both individually defensible in isolation, but together the age branch was
 * arithmetically unreachable for a fresh lock: the deadline always fired
 * first. Harmless today only because the `'unknown'` branch is *already*
 * unreachable in this lock's real single-host deployment (see above) — but
 * this is exactly the backlog class "limits nobody compared against each
 * other" (opened after a document the size limit itself allowed took longer
 * than the time limit itself allowed, silently telling the user their file
 * was unreadable). `build-lock.spec.ts`'s "default timing constants"
 * `describe` block asserts the relationship directly (`DEFAULT_STALE_AGE_MS
 * < DEFAULT_DEADLINE_MS`, with a minimum margin) rather than pinning either
 * number to a literal, so it keeps holding under any future retuning of
 * either constant on its own.
 *
 * Values: `DEFAULT_STALE_AGE_MS` = 2 min — how long an unclassifiable owner
 * is given the benefit of the doubt before being treated as abandoned,
 * comfortably above this build's worst measured contention (~17-25 s for 3
 * concurrent agents) so a merely-unclassifiable-but-alive owner is not
 * evicted on a technicality. `DEFAULT_DEADLINE_MS` = 4 min — how long a
 * waiter tolerates ANY holder (live, or unknown-and-not-yet-past-its-own
 * threshold) before giving up loudly; set so that even in the worst case
 * (waiting the full stale-age threshold, THEN reclaiming, THEN running a
 * real build under heavy contention) there is still real headroom left, not
 * a photo finish.
 *
 * ============================================================================
 * ATOMIC RECLAIM (NOT "CHECK, THEN DELETE, THEN CREATE")
 * ============================================================================
 * A naive reclaim — `existsSync` staleness check, then `rmSync`, then
 * `mkdirSync` as three separate steps — is itself a race: two waiters could
 * both observe staleness, both delete, and both create, defeating the whole
 * point of a mutex (replacing one race with a subtler one, exactly what this
 * mechanism must not do). Reclaim instead does ONE atomic filesystem
 * operation — `renameSync(lockDir, <unique discard path>)` — and only the
 * caller whose rename call actually succeeds is considered to have evicted
 * the stale lock; every other concurrent caller's rename fails with `ENOENT`
 * (the path is already gone) and simply loops back to retry `mkdirSync`,
 * which is itself atomic-exclusive. Exactly one process ever "wins" a given
 * eviction, by construction of `rename(2)`'s own atomicity — not by this
 * code's own bookkeeping.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface LockHolder {
  pid: number
  startedAt: number
}

export type PidLiveness = 'alive' | 'dead' | 'unknown'

export interface BuildLockOptions {
  /** Fixed path this lock lives at — the mutex IS this directory's existence. */
  lockDir: string
  /**
   * Age threshold used ONLY for a holder whose PID liveness is `'unknown'`
   * (see file doc) — a confirmed-alive holder is never evicted on age, no
   * matter how large this is. Default: `DEFAULT_STALE_AGE_MS` (2 min).
   * MUST stay strictly less than `deadlineMs` with real margin, or the
   * `'unknown'`-branch auto-reclaim becomes arithmetically unreachable (see
   * file doc, "THE TWO DEFAULT TIMEOUTS MUST AGREE WITH EACH OTHER") —
   * `build-lock.spec.ts`'s "default timing constants" tests guard the
   * DEFAULT pairing directly; an override passed here is the caller's own
   * responsibility to keep consistent.
   */
  staleAgeMs?: number
  /** Total time a waiter tolerates a live/unknown-but-recent holder before giving up loudly. Default: `DEFAULT_DEADLINE_MS` (4 min). */
  deadlineMs?: number
  /** Poll interval while waiting on a live holder. Default: 200. */
  pollMs?: number
}

/** Exported so build-lock.spec.ts can assert the relationship to `DEFAULT_DEADLINE_MS` directly, not pin either to a literal. */
export const DEFAULT_STALE_AGE_MS = 120_000
/** Exported so build-lock.spec.ts can assert the relationship to `DEFAULT_STALE_AGE_MS` directly, not pin either to a literal. */
export const DEFAULT_DEADLINE_MS = 240_000
const DEFAULT_POLL_MS = 200

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * `kill(pid, 0)` sends no signal — only checks whether the pid is reachable.
 * `ESRCH` (no such process) is the only outcome that is authoritatively
 * "dead"; `EPERM` (process exists, this user cannot signal it) is
 * authoritatively "alive"; anything else this platform might throw is
 * genuinely indeterminate. Exported for its own direct unit coverage.
 */
export function pidLiveness(pid: number): PidLiveness {
  try {
    process.kill(pid, 0)
    return 'alive'
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === 'ESRCH') return 'dead'
    if (code === 'EPERM') return 'alive'
    return 'unknown'
  }
}

/** Convenience boolean form of `pidLiveness` — `false` only for a confirmed-dead PID. */
export function isProcessAlive(pid: number): boolean {
  return pidLiveness(pid) !== 'dead'
}

function readHolder(lockDir: string): LockHolder | null {
  try {
    const raw = readFileSync(join(lockDir, 'holder.json'), 'utf8')
    const parsed = JSON.parse(raw) as Partial<LockHolder>
    if (typeof parsed.pid === 'number' && typeof parsed.startedAt === 'number') {
      return { pid: parsed.pid, startedAt: parsed.startedAt }
    }
    return null
  } catch {
    // Missing (brand-new lock, holder.json not written yet) or corrupt —
    // either way, unknown ownership AND no startedAt to age against. Never
    // treated as stale (see file doc).
    return null
  }
}

/**
 * Exported for its own direct unit coverage — see build-lock.spec.ts.
 *
 * PID liveness is authoritative when it can be determined: `'alive'` is
 * NEVER overridden by age (the MED-3 fix); `'dead'` is stale immediately,
 * unaffected by age (unchanged from MED-2). Age is consulted ONLY for
 * `'unknown'` — see file doc for why that state exists and why it is
 * effectively unreachable in this lock's actual (single-host) deployment
 * today without being assumed away.
 */
export function isStaleHolder(holder: LockHolder | null, staleAgeMs: number): boolean {
  if (holder === null) return false
  const liveness = pidLiveness(holder.pid)
  if (liveness === 'alive') return false
  if (liveness === 'dead') return true
  return Date.now() - holder.startedAt > staleAgeMs
}

/**
 * Atomically evict whatever currently sits at `lockDir`, if anything still
 * does by the time this call's own `renameSync` runs (see file doc, "ATOMIC
 * RECLAIM"). Always safe to call — a lost race is a silent no-op, not an
 * error, because by definition someone else already handled it.
 */
function tryEvict(lockDir: string): void {
  const discard = `${lockDir}.stale-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  try {
    renameSync(lockDir, discard)
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return
    throw err
  }
  try {
    rmSync(discard, { recursive: true, force: true })
  } catch {
    // Best-effort cleanup only. `discard` is unique per (pid, timestamp,
    // random suffix) — a leftover here is inert clutter, never a correctness
    // issue for any other process (nothing else ever looks at this path).
  }
}

/**
 * Run `fn` while holding an exclusive lock at `options.lockDir`, reclaiming
 * it automatically if the previous holder is stale (confirmed-dead PID, or
 * — only when PID liveness cannot be determined at all — too old; see file
 * doc). Throws a descriptive error naming the lock path and the reason if a
 * live (or unknown-but-recent) holder never releases it before `deadlineMs`.
 */
export async function withBuildLock<T>(fn: () => T, options: BuildLockOptions): Promise<T> {
  const { lockDir } = options
  const staleAgeMs = options.staleAgeMs ?? DEFAULT_STALE_AGE_MS
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS

  mkdirSync(join(lockDir, '..'), { recursive: true })
  const deadline = Date.now() + deadlineMs
  for (;;) {
    try {
      mkdirSync(lockDir)
      writeFileSync(
        join(lockDir, 'holder.json'),
        JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
      )
      break
    } catch (err) {
      if ((err as { code?: string }).code !== 'EEXIST') throw err
      if (isStaleHolder(readHolder(lockDir), staleAgeMs)) {
        tryEvict(lockDir)
        continue
      }
      if (Date.now() > deadline) {
        throw new Error(
          `[build-lock] gave up waiting for ${lockDir} after ${deadlineMs}ms — another process holds it and ` +
            `the OS reports it as alive (or its liveness could not be determined and it is recent). If that is ` +
            `wrong (a crashed/killed process this check could not detect), remove it manually: rm -rf ${lockDir}`,
        )
      }
      await sleep(pollMs)
    }
  }
  try {
    return fn()
  } finally {
    rmSync(lockDir, { recursive: true, force: true })
  }
}
