import type { SessionUser } from '@crm/shared'
import { describe, expect, it, vi } from 'vitest'
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

function harness(opts: {
  outcome?: SwitchOutcome
  lastSuccessMs?: number | null
  runSource?: () => Promise<unknown>
}) {
  const execute = vi.fn(async () => ({
    rows: [
      {
        type: 'REMOTIVE_API',
        manifest_id: 'm',
        last_success_ms: opts.lastSuccessMs ?? null,
        now_ms: NOW_MS,
      },
    ],
  }))
  const openCycle = vi.fn(async () => ({ cycleId: 'cycle-1' }))
  const runSource = vi.fn(opts.runSource ?? (async () => ({ kind: 'RAN' })))
  const ledger = {
    setEnabled: vi.fn(async () => opts.outcome ?? CHANGED),
    openCycle,
    catalog: {
      entry: () => ({
        fetchProfile: { intervalMinutes: 60, offIntervalMinutes: null, window: null },
      }),
    },
  } as unknown as JobRunLedger
  const service = new JobSourceAdminService(
    { db: { execute } } as unknown as DatabaseService,
    ledger,
    { runSource } as unknown as JobRunWorker,
  )
  return { service, runSource, openCycle }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('JobSourceAdminService.setEnabled — immediate fetch on enable', () => {
  it('stale source: opens a MANUAL cycle for the actor and runs the source once', async () => {
    const h = harness({ lastSuccessMs: null })
    await h.service.setEnabled(SOURCE, { enabled: true }, ADMIN)
    await flush()
    expect(h.openCycle).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: 'MANUAL', actor: ADMIN.id }),
    )
    expect(h.runSource).toHaveBeenCalledTimes(1)
    expect(h.runSource).toHaveBeenCalledWith({
      cycleId: 'cycle-1',
      sourceId: SOURCE,
      actor: ADMIN.id,
    })
  })

  it('fresh source: no run', async () => {
    const h = harness({ lastSuccessMs: NOW_MS - 30 * 60_000 })
    await h.service.setEnabled(SOURCE, { enabled: true }, ADMIN)
    await flush()
    expect(h.runSource).not.toHaveBeenCalled()
  })

  it('does not await the fetch: the response returns while runSource is pending', async () => {
    const h = harness({ runSource: () => new Promise(() => undefined) })
    const result = await h.service.setEnabled(SOURCE, { enabled: true }, ADMIN)
    expect(result.changed).toBe(true)
    await flush()
    expect(h.runSource).toHaveBeenCalledTimes(1)
  })

  it('already enabled (changed:false): no run', async () => {
    const h = harness({ outcome: { kind: 'SWITCHED', changed: false, cancelledRuns: 0 } })
    await h.service.setEnabled(SOURCE, { enabled: true }, ADMIN)
    await flush()
    expect(h.runSource).not.toHaveBeenCalled()
  })

  it('disable: no run', async () => {
    const h = harness({})
    await h.service.setEnabled(SOURCE, { enabled: false }, ADMIN)
    await flush()
    expect(h.runSource).not.toHaveBeenCalled()
  })

  it('runSource rejects: the enable still succeeds and nothing is unhandled', async () => {
    const h = harness({
      runSource: async () => {
        throw new Error('boom')
      },
    })
    await expect(h.service.setEnabled(SOURCE, { enabled: true }, ADMIN)).resolves.toMatchObject({
      enabled: true,
      changed: true,
    })
    await flush()
    expect(h.runSource).toHaveBeenCalledTimes(1)
  })

  it('a REFUSED run does not fail the enable', async () => {
    const h = harness({ runSource: async () => ({ kind: 'REFUSED', reason: 'POOL_FULL' }) })
    await expect(h.service.setEnabled(SOURCE, { enabled: true }, ADMIN)).resolves.toBeDefined()
    await flush()
    expect(h.runSource).toHaveBeenCalledTimes(1)
  })
})
