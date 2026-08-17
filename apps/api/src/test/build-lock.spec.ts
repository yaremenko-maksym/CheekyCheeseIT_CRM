/**
 * Backlog #42, review rounds MED-2/MED-3 on PR #550.
 *
 * MED-2 — a lock holder that dies mid-build (a real, observed failure mode:
 * four agents hit their session limit mid-work the day this was written, one
 * of them mid-`beforeAll`) must not permanently wedge every future run of
 * `app.module.container.spec.ts` in the same worktree.
 *
 * MED-3 — the original reclaim condition was "PID dead OR age > threshold",
 * treating both as equally authoritative. Measured contention (2 concurrent
 * `tsc` builds: 12-15 s; 3: 17-25 s) showed that in THIS lock's real
 * deployment (one checkout, one machine — `process.kill` is always
 * authoritative there) the age branch would not fire on its documented case
 * (a reused PID) but on "the build is alive and just slow under load with
 * several agents" — evicting exactly the live holder the mechanism must
 * protect, handing two concurrent `tsc` runs the same output directory (the
 * precise regression MED-1/MED-2 exist to prevent). Fixed: a confirmed-alive
 * PID is now respected UNCONDITIONALLY, no matter its age; age is consulted
 * ONLY when PID liveness cannot be determined at all (`pidLiveness` returns
 * `'unknown'` — see `build-lock.ts`'s own file doc for exactly when that is
 * and why it is effectively unreachable in single-host use today).
 *
 * Both directions matter, and "never evict a live holder" is the more
 * important one to get right — reclaiming a live one is exactly as dangerous
 * as never reclaiming a dead one; it tears down a genuinely in-progress build
 * out from under a live process. Every case here is exercised with short,
 * injected `staleAgeMs`/`deadlineMs` (see `BuildLockOptions`) so this whole
 * spec runs in well under a second rather than needing to wait out the real
 * 300 s / 180 s production defaults.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isProcessAlive, isStaleHolder, pidLiveness, withBuildLock } from './build-lock'

let scratchDir: string
let lockDir: string

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'build-lock-spec-'))
  lockDir = join(scratchDir, '.lock')
})

afterEach(() => {
  rmSync(scratchDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function writeHolder(pid: number, startedAt: number) {
  mkdirSync(lockDir)
  writeFileSync(join(lockDir, 'holder.json'), JSON.stringify({ pid, startedAt }))
}

/** A PID guaranteed dead by the time this returns: spawn, let it exit, use its number. */
function aDeadPid(): number {
  const result = spawnSync(process.execPath, ['-e', 'process.exit(0)'])
  const pid = result.pid
  if (typeof pid !== 'number') throw new Error('spawnSync did not report a pid')
  return pid
}

/** Forces `process.kill` to fail with an errno that is neither ESRCH nor EPERM. */
function mockUndeterminableKill() {
  vi.spyOn(process, 'kill').mockImplementation(() => {
    const err = new Error('simulated indeterminate kill(2) failure') as NodeJS.ErrnoException
    err.code = 'EPLATFORMQUIRK'
    throw err
  })
}

describe('pidLiveness', () => {
  it('reports the current process as alive', () => {
    expect(pidLiveness(process.pid)).toBe('alive')
  })

  it('reports an already-exited process as dead (ESRCH)', () => {
    expect(pidLiveness(aDeadPid())).toBe('dead')
  })

  it('reports a process kill(2) cannot classify as unknown (neither ESRCH nor EPERM)', () => {
    mockUndeterminableKill()
    expect(pidLiveness(process.pid)).toBe('unknown')
  })
})

describe('isProcessAlive', () => {
  it('reports the current process as alive', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
  })

  it('reports an already-exited process as dead', () => {
    expect(isProcessAlive(aDeadPid())).toBe(false)
  })
})

describe('isStaleHolder', () => {
  it('is not stale when there is no holder at all (unknown ownership is never stale)', () => {
    expect(isStaleHolder(null, 90_000)).toBe(false)
  })

  it('is stale immediately when the holder pid is dead, regardless of age', () => {
    expect(isStaleHolder({ pid: aDeadPid(), startedAt: Date.now() }, 90_000)).toBe(true)
  })

  it('is NOT stale when the holder pid is alive and within the age threshold', () => {
    expect(isStaleHolder({ pid: process.pid, startedAt: Date.now() }, 90_000)).toBe(false)
  })

  // ── MED-3 priority case ──────────────────────────────────────────────
  it('is NOT stale when the holder pid is alive, EVEN when age exceeds the threshold — a live build is just slow, not stale', () => {
    // Old original design ("PID dead OR age > threshold") would have called
    // this stale — see the manual mutation verification in the PR body /
    // commit for the reverted-logic RED run this exact assertion produces.
    expect(isStaleHolder({ pid: process.pid, startedAt: Date.now() - 10_000 }, 50)).toBe(false)
  })

  // ── MED-3 inversion of a previously-passing case (intentional — NOT a
  //    regression slipping through unnoticed; see file doc "MED-3" above) ──
  it('[CHANGED BY MED-3, was "is stale on age alone"] an alive holder is never evicted by age alone anymore', () => {
    // Pre-MED-3 this spec asserted `toBe(true)` for this EXACT input (age
    // alone, live self pid) — that was the "OR" bug this round fixes. The
    // input is unchanged; only the expectation is inverted, deliberately.
    expect(isStaleHolder({ pid: process.pid, startedAt: Date.now() - 1_000 }, 50)).toBe(false)
  })

  it('DOES fall back to age when PID liveness is unknown (neither confirmed alive nor dead)', () => {
    mockUndeterminableKill()
    expect(isStaleHolder({ pid: process.pid, startedAt: Date.now() - 1_000 }, 50)).toBe(true)
  })

  it('does NOT evict on age when PID liveness is unknown but still within the threshold', () => {
    mockUndeterminableKill()
    expect(isStaleHolder({ pid: process.pid, startedAt: Date.now() }, 90_000)).toBe(false)
  })
})

describe('withBuildLock', () => {
  it('reclaims a lock left by a dead PID and runs fn immediately (does not wait out the deadline)', async () => {
    writeHolder(aDeadPid(), Date.now())

    const start = Date.now()
    let ran = false
    const result = await withBuildLock(
      () => {
        ran = true
        return 'ok'
      },
      { lockDir, staleAgeMs: 90_000, deadlineMs: 5_000, pollMs: 20 },
    )
    const elapsed = Date.now() - start

    expect(ran).toBe(true)
    expect(result).toBe('ok')
    // Reclaimed on (at most) the first poll — nowhere near the 5s deadline.
    expect(elapsed).toBeLessThan(1_000)
    // Lock released after fn() completes.
    expect(existsSync(lockDir)).toBe(false)
  })

  // ── MED-3: was "reclaims a lock older than staleAgeMs even though the
  //    holder pid is alive" (asserted immediate reclaim). Inverted on
  //    purpose — that WAS the bug. Now proves the opposite: an alive-but-old
  //    holder is waited on, not torn down, exactly like a fresh live lock. ──
  it('[CHANGED BY MED-3] does NOT reclaim a lock older than staleAgeMs when the holder pid is alive — waits for real release instead', async () => {
    writeHolder(process.pid, Date.now() - 10_000) // already "old" by the short threshold below
    const releaseAfterMs = 300

    const releaseTimer = setTimeout(() => {
      rmSync(lockDir, { recursive: true, force: true })
    }, releaseAfterMs)

    const start = Date.now()
    let ran = false
    await withBuildLock(
      () => {
        ran = true
      },
      // staleAgeMs deliberately far shorter than the holder's recorded age —
      // the pre-MED-3 "OR" logic would have reclaimed this on the very first
      // poll. It must not: the holder is alive (self), full stop.
      { lockDir, staleAgeMs: 50, deadlineMs: 5_000, pollMs: 20 },
    )
    const elapsed = Date.now() - start
    clearTimeout(releaseTimer)

    expect(ran).toBe(true)
    // The assertion that would fail if age were still allowed to override a
    // confirmed-alive PID — proves it waited for the real release.
    expect(elapsed).toBeGreaterThanOrEqual(releaseAfterMs - 50)
    expect(existsSync(lockDir)).toBe(false)
  })

  it('does NOT evict a live, recent lock — waits for it to be released, never tears it down', async () => {
    // Simulate a genuinely in-progress holder: alive pid (self), fresh
    // timestamp, staleAgeMs generous enough that age never kicks in either.
    writeHolder(process.pid, Date.now())
    const releaseAfterMs = 300

    const releaseTimer = setTimeout(() => {
      // The "original holder" finishing its own build and releasing normally
      // — NOT this test reaching in and deleting a lock it doesn't own via
      // any staleness path; withBuildLock below must be waiting, not evicting.
      rmSync(lockDir, { recursive: true, force: true })
    }, releaseAfterMs)

    const start = Date.now()
    let ran = false
    await withBuildLock(
      () => {
        ran = true
      },
      { lockDir, staleAgeMs: 90_000, deadlineMs: 5_000, pollMs: 20 },
    )
    const elapsed = Date.now() - start
    clearTimeout(releaseTimer)

    expect(ran).toBe(true)
    // Proves it WAITED for the release rather than evicting immediately —
    // the one assertion that would fail if eviction were too eager.
    expect(elapsed).toBeGreaterThanOrEqual(releaseAfterMs - 50)
    expect(existsSync(lockDir)).toBe(false)
  })

  it('gives up loudly, naming the lock path and reason, if a live holder never releases before the deadline', async () => {
    writeHolder(process.pid, Date.now())
    // Deliberately never released within this test.

    await expect(
      withBuildLock(() => 'should not run', {
        lockDir,
        staleAgeMs: 90_000,
        deadlineMs: 300,
        pollMs: 20,
      }),
    ).rejects.toThrow(
      new RegExp(
        `gave up waiting for ${lockDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*rm -rf`,
        's',
      ),
    )

    // The still-live lock is untouched — this failure mode must not corrupt
    // or remove state it does not own.
    expect(existsSync(lockDir)).toBe(true)
    const holder = JSON.parse(readFileSync(join(lockDir, 'holder.json'), 'utf8')) as { pid: number }
    expect(holder.pid).toBe(process.pid)
  })

  it('two concurrent waiters on a dead lock both succeed exactly once, without a double-eviction crash', async () => {
    writeHolder(aDeadPid(), Date.now())

    const calls: number[] = []
    const [a, b] = await Promise.all([
      withBuildLock(
        () => {
          calls.push(1)
        },
        { lockDir, staleAgeMs: 90_000, deadlineMs: 5_000, pollMs: 10 },
      ),
      withBuildLock(
        () => {
          calls.push(2)
        },
        { lockDir, staleAgeMs: 90_000, deadlineMs: 5_000, pollMs: 10 },
      ),
    ])

    void a
    void b
    // Both resolved without throwing (the exact race MED-2's own repro hit:
    // one process's rmdir racing another's) and fn ran exactly once each,
    // serialized, never concurrently inside the lock.
    expect(calls.sort()).toEqual([1, 2])
    expect(existsSync(lockDir)).toBe(false)
  })
})
