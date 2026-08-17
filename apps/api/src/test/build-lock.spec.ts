/**
 * Backlog #42, review round MED-2 on PR #550 — a lock holder that dies
 * mid-build (a real, observed failure mode: four agents hit their session
 * limit mid-work the day this was written, one of them mid-`beforeAll`) must
 * not permanently wedge every future run of `app.module.container.spec.ts`
 * in the same worktree. See `build-lock.ts`'s own file doc for the full
 * design rationale (PID + age, why both, why atomic reclaim).
 *
 * Both directions matter, and the second is the more important one to get
 * right: reclaiming a dead/stale lock too eagerly is exactly as dangerous as
 * never reclaiming one — it would tear down a genuinely in-progress build out
 * from under a live process. Both are covered here, deliberately using
 * short, injected `staleAgeMs`/`deadlineMs` (see `BuildLockOptions`) so this
 * spec runs in well under a second rather than needing to wait out the real
 * 60 s / 90 s production defaults.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isProcessAlive, isStaleHolder, withBuildLock } from './build-lock'

let scratchDir: string
let lockDir: string

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'build-lock-spec-'))
  lockDir = join(scratchDir, '.lock')
})

afterEach(() => {
  rmSync(scratchDir, { recursive: true, force: true })
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

  it('is stale on age alone, even when the holder pid is alive (self)', () => {
    expect(isStaleHolder({ pid: process.pid, startedAt: Date.now() - 1_000 }, 50)).toBe(true)
  })

  it('is NOT stale when the holder pid is alive and within the age threshold', () => {
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

  it('reclaims a lock older than staleAgeMs even though the holder pid is alive (self)', async () => {
    writeHolder(process.pid, Date.now() - 1_000)

    const start = Date.now()
    let ran = false
    await withBuildLock(
      () => {
        ran = true
      },
      { lockDir, staleAgeMs: 50, deadlineMs: 5_000, pollMs: 20 },
    )
    const elapsed = Date.now() - start

    expect(ran).toBe(true)
    expect(elapsed).toBeLessThan(1_000)
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
