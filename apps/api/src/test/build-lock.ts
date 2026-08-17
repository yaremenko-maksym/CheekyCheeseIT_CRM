/**
 * Cross-process exclusive lock for `app.module.container.spec.ts`'s build
 * cache (backlog #42, review round MED-2 on PR #550).
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
 * RECLAIM STRATEGY: PID LIVENESS (FAST PATH) + AGE (SAFETY NET), NOT EITHER ALONE
 * ============================================================================
 * Every lock directory carries a `holder.json` (`{ pid, startedAt }`),
 * written the instant the directory is created. A waiter that hits `EEXIST`
 * decides whether the existing holder is stale via TWO independent checks,
 * either one being enough:
 *
 *   - PID liveness (`process.kill(pid, 0)`, throws ESRCH iff no such process)
 *     — precise and immediate: a crashed/killed holder is reclaimed on the
 *     very next poll, not after waiting out an age threshold. Does not
 *     survive a reboot and is meaningless across hosts/containers, and a
 *     reused PID (astronomically unlikely at this build's ~5-8 s timescale,
 *     but not impossible over a long-lived shared worktree) would report a
 *     dead holder as "alive".
 *   - Age (`Date.now() - startedAt > staleAgeMs`, default 60 s — roughly
 *     8-12x this build's real ~5-8 s cost, deliberately generous) — coarser,
 *     but immune to both of PID liveness's blind spots: it does not care
 *     whether the number is a live PID, a reused one, or meaningless because
 *     the check is running on a different host.
 *
 * Combined, not either alone, because they cover each other's failure mode:
 * PID liveness is the fast, common-case path (dead holder reclaimed in one
 * poll interval, ~200 ms); age is the safety net for exactly the cases PID
 * liveness cannot see. A lock is stale if PID liveness says dead OR age
 * exceeds the threshold — evicting on the FIRST true condition, not waiting
 * for both.
 *
 * An unreadable/missing `holder.json` (the brief window between `mkdirSync`
 * creating the directory and the very next line writing the file) is treated
 * as "unknown, not stale" — a waiter simply retries rather than guessing.
 * Evicting a lock whose ownership cannot be determined would reintroduce
 * exactly the kind of unsafe guess this mechanism exists to avoid.
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

export interface BuildLockOptions {
  /** Fixed path this lock lives at — the mutex IS this directory's existence. */
  lockDir: string
  /** A holder is stale on age alone past this many ms. Default: 60_000. */
  staleAgeMs?: number
  /** Total time a waiter tolerates a LIVE, recent holder before giving up loudly. Default: 90_000. */
  deadlineMs?: number
  /** Poll interval while waiting on a live holder. Default: 200. */
  pollMs?: number
}

// ~8-15x this build's real ~5-8s cost — generous margin, not a guess: a
// waiter reaching the age threshold (worst case, PID liveness somehow missed
// it) still has DEFAULT_DEADLINE_MS - DEFAULT_STALE_AGE_MS = 30s of headroom
// left to reclaim AND run the real build before giving up itself.
const DEFAULT_STALE_AGE_MS = 60_000
const DEFAULT_DEADLINE_MS = 90_000
const DEFAULT_POLL_MS = 200

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** `kill(pid, 0)` sends no signal — only checks whether the pid is reachable. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = (err as { code?: string }).code
    // ESRCH = no such process -> definitely dead. Anything else (e.g. EPERM,
    // meaning the process exists but this user cannot signal it) is treated
    // as alive: we cannot prove it is dead, so we do not evict it.
    return code !== 'ESRCH'
  }
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
    // either way, unknown ownership. Never treated as stale (see file doc).
    return null
  }
}

/** Exported for its own direct unit coverage — see build-lock.spec.ts. */
export function isStaleHolder(holder: LockHolder | null, staleAgeMs: number): boolean {
  if (holder === null) return false
  if (!isProcessAlive(holder.pid)) return true
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
 * it automatically if the previous holder is stale (dead PID or too old —
 * see file doc). Throws a descriptive error naming the lock path and the
 * reason if a LIVE, recent holder never releases it before `deadlineMs`.
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
            `appears alive and recent (younger than ${staleAgeMs}ms). If that is wrong (a crashed/killed process ` +
            `this check could not detect), remove it manually: rm -rf ${lockDir}`,
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
