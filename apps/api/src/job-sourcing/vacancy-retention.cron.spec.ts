import { Logger } from '@nestjs/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseService } from '../database/database.service'

const sweep = vi.fn()
vi.mock('./store/opportunity-purge', () => ({
  VACANCY_RETENTION_FAILURE_MARKER: 'vacancy_retention_purge_failed',
  purgeRetiredOpportunities: (...a: unknown[]) => sweep(...a),
}))

import {
  VACANCY_RETENTION_CRON,
  VACANCY_RETENTION_FAILURE_MARKER,
  VacancyRetentionCronService,
} from './vacancy-retention.cron'

/** The caller of the sweep: which db it hands over, what it logs, that a failure never escapes. */
const inner = { execute: vi.fn(), transaction: vi.fn() }
const service = () => new VacancyRetentionCronService({ db: inner } as unknown as DatabaseService)

let log: ReturnType<typeof vi.spyOn>
let error: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  sweep.mockReset()
  log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
  error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('VacancyRetentionCronService', () => {
  it('runs daily at 04:43, a minute no other cron uses (CR-M-6)', () => {
    expect(VACANCY_RETENTION_CRON).toBe('43 4 * * *')
  })

  it('VACANCY_RETENTION_ENABLED=false: the sweep does not run (SR-M-3)', async () => {
    vi.stubEnv('VACANCY_RETENTION_ENABLED', 'false')
    await service().handleRetention()
    expect(sweep).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(
      'Vacancy retention: VACANCY_RETENTION_ENABLED is false; nothing removed',
    )
  })

  it('VACANCY_RETENTION_ENABLED=true keeps the sweep on', async () => {
    vi.stubEnv('VACANCY_RETENTION_ENABLED', 'true')
    sweep.mockResolvedValue({
      deleted: 0,
      tombstoned: 0,
      skipped: 0,
      failed: 0,
      records: 0,
      blobs: 0,
    })
    await service().handleRetention()
    expect(sweep).toHaveBeenCalledTimes(1)
  })

  it('sweeps with the application database and logs every count', async () => {
    sweep.mockResolvedValue({
      deleted: 3,
      tombstoned: 2,
      skipped: 4,
      failed: 1,
      records: 5,
      blobs: 6,
    })
    await service().handleRetention()
    expect(sweep).toHaveBeenCalledWith(
      inner,
      expect.objectContaining({ onError: expect.any(Function) }),
    )
    expect(log).toHaveBeenCalledWith(
      'Vacancy retention: deleted 3, tombstoned 2, skipped 4, failed 1 opportunity(ies); 5 unlinked record(s), 6 text blob(s)',
    )
    expect(error).not.toHaveBeenCalled()
  })

  it('logs a zero run too', async () => {
    sweep.mockResolvedValue({
      deleted: 0,
      tombstoned: 0,
      skipped: 0,
      failed: 0,
      records: 0,
      blobs: 0,
    })
    await service().handleRetention()
    expect(log).toHaveBeenCalledWith(
      'Vacancy retention: deleted 0, tombstoned 0, skipped 0, failed 0 opportunity(ies); 0 unlinked record(s), 0 text blob(s)',
    )
  })

  it('reports one failed row with the marker and its id, and the sweep result still logs', async () => {
    sweep.mockImplementation(
      async (_db: unknown, opts: { onError: (k: string, id: string, e: unknown) => void }) => {
        opts.onError('OPPORTUNITY', 'opp-1', new Error('boom'))
        return { deleted: 0, tombstoned: 0, skipped: 0, failed: 1, records: 0, blobs: 0 }
      },
    )
    await service().handleRetention()
    expect(error).toHaveBeenCalledTimes(1)
    const message = String(error.mock.calls[0]?.[0])
    expect(
      message.startsWith(
        `${VACANCY_RETENTION_FAILURE_MARKER} Vacancy retention skipped OPPORTUNITY opp-1;`,
      ),
    ).toBe(true)
    expect(log).toHaveBeenCalledWith(
      'Vacancy retention: deleted 0, tombstoned 0, skipped 0, failed 1 opportunity(ies); 0 unlinked record(s), 0 text blob(s)',
    )
  })

  it('never rethrows: a failure is logged with the marker and the next night retries', async () => {
    sweep.mockRejectedValue(new Error('boom'))
    await expect(service().handleRetention()).resolves.toBeUndefined()
    expect(log).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledTimes(1)
    const message = String(error.mock.calls[0]?.[0])
    expect(message.startsWith(`${VACANCY_RETENTION_FAILURE_MARKER} `)).toBe(true)
    expect(message).toContain('will retry next cycle')
    expect(VACANCY_RETENTION_FAILURE_MARKER).toBe('vacancy_retention_purge_failed')
  })
})
