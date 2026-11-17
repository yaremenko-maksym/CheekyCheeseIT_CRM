import { ForbiddenException, Logger } from '@nestjs/common'
import type { SessionUser } from '@crm/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseService } from '../../database/database.service'
import type { JobRunLedger, SwitchOutcome } from '../ownership/job-run-ledger'
import type { JobRunWorker } from '../runtime/job-run-worker'
import { JobSourceAdminService } from './job-source-admin.service'

/** Owner request: enabling a stale source fetches it at once, fire-and-forget, through the manual path. */

const ADMIN = {
  id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  role: 'ADMIN',
} as unknown as SessionUser
const SOURCE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const CHANGED: SwitchOutcome = { kind: 'SWITCHED', changed: true, cancelledRuns: 0 }
const NOW_MS = 1_800_000_000_000
const MIN = 60_000
const HOURLY = { intervalMinutes: 60, offIntervalMinutes: null, window: null }
const TAG = `source_id=${SOURCE} source_type=REMOTIVE_API`

type Entry = { fetchProfile: typeof HOURLY | null; floorHours: number } | undefined

function harness(opts: {
  outcome?: SwitchOutcome
  /** How long ago the last attempt was; null = never attempted. */
  attemptAgoMs?: number | null
  /** Override the DB values' wire form (e.g. numeric strings). */
  row?: Record<string, unknown> | null
  manifestId?: string | null
  entry?: Entry
  withWorker?: boolean
  execute?: () => Promise<unknown>
  runSource?: () => Promise<unknown>
  closeCycle?: () => Promise<boolean>
}) {
  const ago = opts.attemptAgoMs === undefined ? null : opts.attemptAgoMs
  const defaultRow = {
    type: 'REMOTIVE_API',
    manifest_id: opts.manifestId === undefined ? 'm' : opts.manifestId,
    last_attempt_ms: ago === null ? null : NOW_MS - ago,
    now_ms: NOW_MS,
  }
  const execute = vi.fn(
    opts.execute ??
      (async () => ({ rows: opts.row === null ? [] : [{ ...defaultRow, ...opts.row }] })),
  )
  const openCycle = vi.fn(async () => ({ cycleId: 'cycle-1' }))
  const closeCycle = vi.fn(opts.closeCycle ?? (async () => true))
  const runSource = vi.fn(opts.runSource ?? (async () => ({ kind: 'RAN' })))
  const entry = vi.fn((): Entry =>
    opts.entry === undefined ? { fetchProfile: HOURLY, floorHours: 0 } : opts.entry,
  )
  const setEnabled = vi.fn(async () => opts.outcome ?? CHANGED)
  const isReportingType = vi.fn((type: string) => type !== 'DOU_RSS')
  const ledger = {
    setEnabled,
    openCycle,
    closeCycle,
    isReportingType,
    catalog: { entry },
  } as unknown as JobRunLedger
  const service = new JobSourceAdminService(
    { db: { execute } } as unknown as DatabaseService,
    ledger,
    opts.withWorker === false ? undefined : ({ runSource } as unknown as JobRunWorker),
  )
  // The fire-and-forget promise, awaited by the test instead of a timer.
  const fetchSpy = vi.spyOn(
    service as unknown as { fetchIfStale: () => Promise<void> },
    'fetchIfStale',
  )
  const settle = async () => {
    for (const r of fetchSpy.mock.results) await (r.value as Promise<void>).catch(() => undefined)
  }
  return {
    service,
    runSource,
    openCycle,
    closeCycle,
    execute,
    entry,
    setEnabled,
    isReportingType,
    settle,
  }
}

let warn: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.restoreAllMocks()
})

async function enable(h: ReturnType<typeof harness>) {
  const result = await h.service.setEnabled(SOURCE, { enabled: true }, ADMIN)
  await h.settle()
  return result
}

describe('JobSourceAdminService.setEnabled — immediate fetch on enable', () => {
  it('never attempted: one MANUAL cycle for the actor with a unique enable key, one run, cycle closed', async () => {
    const h = harness({ attemptAgoMs: null })
    await enable(h)
    expect(h.openCycle).toHaveBeenCalledTimes(1)
    expect(h.openCycle).toHaveBeenCalledWith({
      trigger: 'MANUAL',
      triggerKey: expect.stringMatching(
        new RegExp(
          `^enable-fetch:${SOURCE}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`,
        ),
      ),
      actor: ADMIN.id,
    })
    expect(h.runSource).toHaveBeenCalledTimes(1)
    // The catch-up purpose: the claim drops ONLY its trigger-mode term (a SCHEDULED source fetches).
    expect(h.runSource).toHaveBeenCalledWith({
      cycleId: 'cycle-1',
      sourceId: SOURCE,
      actor: ADMIN.id,
      purpose: 'ENABLE_CATCH_UP',
    })
    expect(h.closeCycle).toHaveBeenCalledWith('cycle-1')
    expect(warn).not.toHaveBeenCalled()
  })

  it('reads the catalog entry of the stored manifest id', async () => {
    const h = harness({ attemptAgoMs: 30 * MIN })
    await enable(h)
    expect(h.entry).toHaveBeenCalledWith('m')
  })

  it('attempt inside the profile interval: no cycle, no run', async () => {
    const h = harness({ attemptAgoMs: 30 * MIN })
    await enable(h)
    expect(h.openCycle).not.toHaveBeenCalled()
    expect(h.runSource).not.toHaveBeenCalled()
  })

  it('attempt 2 h ago on an hourly profile runs (a 24 h fallback would not)', async () => {
    const h = harness({ attemptAgoMs: 2 * 60 * MIN })
    await enable(h)
    expect(h.runSource).toHaveBeenCalledTimes(1)
  })

  it('a 3 h host floor keeps a 2 h-old attempt fresh on an hourly profile', async () => {
    const h = harness({
      attemptAgoMs: 2 * 60 * MIN,
      entry: { fetchProfile: HOURLY, floorHours: 3 },
    })
    await enable(h)
    expect(h.runSource).not.toHaveBeenCalled()
  })

  it('no manifest id: no catalog lookup, the 24 h fallback keeps a 2 h-old attempt fresh', async () => {
    const h = harness({ attemptAgoMs: 2 * 60 * MIN, manifestId: null })
    await enable(h)
    expect(h.entry).not.toHaveBeenCalled()
    expect(h.runSource).not.toHaveBeenCalled()
  })

  it('a null profile uses the 24 h window', async () => {
    const fresh = harness({
      attemptAgoMs: 2 * 60 * MIN,
      entry: { fetchProfile: null, floorHours: 0 },
    })
    await enable(fresh)
    expect(fresh.runSource).not.toHaveBeenCalled()
    const stale = harness({
      attemptAgoMs: 25 * 60 * MIN,
      entry: { fetchProfile: null, floorHours: 0 },
    })
    await enable(stale)
    expect(stale.runSource).toHaveBeenCalledTimes(1)
  })

  it('numeric strings from the driver read as numbers: a recent attempt stays fresh', async () => {
    const h = harness({
      row: { last_attempt_ms: String(NOW_MS - 10 * MIN), now_ms: String(NOW_MS) },
    })
    await enable(h)
    expect(h.runSource).not.toHaveBeenCalled()
  })

  it('a LEGACY source (never claimable by claimSource): no cycle, no run', async () => {
    const h = harness({ row: { type: 'DOU_RSS' } })
    await enable(h)
    expect(h.isReportingType).toHaveBeenCalledWith('DOU_RSS')
    expect(h.openCycle).not.toHaveBeenCalled()
    expect(h.runSource).not.toHaveBeenCalled()
  })

  it('the source row is gone: no cycle, no run', async () => {
    const h = harness({ row: null })
    await enable(h)
    await new Promise((r) => setTimeout(r, 0))
    expect(h.openCycle).not.toHaveBeenCalled()
    // A clean return, not a TypeError swallowed by the last-resort log.
    expect(h.isReportingType).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('does not await the fetch: the response returns while runSource is pending', async () => {
    const h = harness({ runSource: () => new Promise(() => undefined) })
    const result = await h.service.setEnabled(SOURCE, { enabled: true }, ADMIN)
    expect(result.changed).toBe(true)
    await new Promise((r) => setTimeout(r, 0))
    expect(h.runSource).toHaveBeenCalledTimes(1)
  })

  it('already enabled (changed:false): no read, no run', async () => {
    const h = harness({ outcome: { kind: 'SWITCHED', changed: false, cancelledRuns: 0 } })
    await enable(h)
    expect(h.execute).not.toHaveBeenCalled()
    expect(h.runSource).not.toHaveBeenCalled()
  })

  it('disable: no read, no run', async () => {
    const h = harness({})
    await h.service.setEnabled(SOURCE, { enabled: false }, ADMIN)
    await h.settle()
    expect(h.execute).not.toHaveBeenCalled()
    expect(h.runSource).not.toHaveBeenCalled()
  })

  it('no worker wired: the enable does not even read freshness', async () => {
    const h = harness({ withWorker: false })
    await expect(enable(h)).resolves.toMatchObject({ enabled: true, changed: true })
    expect(h.execute).not.toHaveBeenCalled()
    expect(h.openCycle).not.toHaveBeenCalled()
  })

  it('non-ADMIN: Forbidden, and no ledger write, cycle or run', async () => {
    const h = harness({})
    const hr = { id: ADMIN.id, role: 'HR' } as unknown as SessionUser
    await expect(h.service.setEnabled(SOURCE, { enabled: true }, hr)).rejects.toBeInstanceOf(
      ForbiddenException,
    )
    await h.settle()
    expect(h.setEnabled).not.toHaveBeenCalled()
    expect(h.openCycle).not.toHaveBeenCalled()
    expect(h.runSource).not.toHaveBeenCalled()
  })

  it('runSource rejects: the enable succeeds, the failure is logged with type + reason, cycle closed', async () => {
    const h = harness({
      runSource: async () => {
        throw new Error('boom')
      },
    })
    await expect(enable(h)).resolves.toMatchObject({ enabled: true, changed: true })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(`enable fetch failed: ${TAG} reason=Error: boom`)
    expect(h.closeCycle).toHaveBeenCalledWith('cycle-1')
  })

  it('a REFUSED run: the enable succeeds, the refusal is logged with type + reason, cycle closed', async () => {
    const h = harness({ runSource: async () => ({ kind: 'REFUSED', reason: 'POOL_FULL' }) })
    await expect(enable(h)).resolves.toBeDefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(`enable fetch refused: ${TAG} reason=POOL_FULL`)
    expect(h.closeCycle).toHaveBeenCalledWith('cycle-1')
  })

  it('closeCycle rejects: logged, nothing unhandled', async () => {
    const h = harness({
      closeCycle: async () => {
        throw new Error('db down')
      },
    })
    await expect(enable(h)).resolves.toBeDefined()
    expect(warn).toHaveBeenCalledWith(
      `enable fetch cycle close failed: ${TAG} reason=Error: db down`,
    )
  })

  it('the freshness read rejects: last-resort log with the id, the enable still succeeds', async () => {
    const h = harness({
      execute: async () => {
        throw new Error('read failed')
      },
    })
    await expect(enable(h)).resolves.toMatchObject({ changed: true })
    // settle() swallowed the rejection of the spied promise; the service's own .catch logged it.
    await new Promise((r) => setTimeout(r, 0))
    expect(warn).toHaveBeenCalledWith(
      `enable fetch failed: source_id=${SOURCE} source_type=unknown reason=Error: read failed`,
    )
    expect(h.openCycle).not.toHaveBeenCalled()
  })
})
