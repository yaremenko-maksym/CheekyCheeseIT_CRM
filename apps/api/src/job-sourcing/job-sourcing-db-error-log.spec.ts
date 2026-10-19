import { Logger } from '@nestjs/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JobSourcingService } from './job-sourcing.service'

/**
 * The two swallow-and-log paths INSIDE `JobSourcingService` — the ones the cron's own
 * catch never sees, because the service swallows first:
 *
 *  - `persistPostings`: a database refusal on ONE row costs that row and is logged as
 *    "unstorable posting". A privilege error on `job_postings` is refused on EVERY row,
 *    so it is exactly the case this log line has to make visible.
 *  - `collectAll`: a source that throws is recorded as a failure and the loop goes on.
 *
 * Both used to log `err.message` / `err.stack` of a drizzle error: no SQLSTATE, but the
 * bound parameter values (here a posting's title and URL) in full.
 */

const SECRET = 'SECRET-VALUE-123'

function deniedQueryError(): Error {
  const driver = Object.assign(new Error('permission denied for table job_postings'), {
    severity: 'ERROR',
    code: '42501',
  })
  const wrapper = Object.assign(
    new Error(`Failed query: insert into "job_postings" ("title") values ($1)\nparams: ${SECRET}`),
    { query: 'insert into "job_postings" ("title") values ($1)', params: [SECRET], cause: driver },
  )
  wrapper.name = 'DrizzleQueryError'
  wrapper.stack = `DrizzleQueryError: ${wrapper.message}\n    at Svc.run (/x/svc.ts:1:1)`
  return wrapper
}

interface Internals {
  persistPostings(sourceId: string, postings: unknown[]): Promise<{ invalid: number }>
  collectSource(source: unknown): Promise<unknown>
}

describe('JobSourcingService swallow-and-log paths record a database error’s SQLSTATE', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('persistPostings: the unstorable-row warning carries db_state and no value, and the row is still skipped', async () => {
    const insertChain = {
      values: () => ({
        onConflictDoNothing: () => ({
          returning: () => Promise.reject(deniedQueryError()),
        }),
      }),
    }
    const svc = new JobSourcingService(
      { db: { insert: () => insertChain } } as never,
      {} as never,
      { type: 'DOU' } as never,
    )

    const result = await (svc as unknown as Internals).persistPostings('source-1', [
      { sourceType: 'DOU', url: 'https://jobs.example/1', title: SECRET },
    ])

    expect(result.invalid).toBe(1) // still skipped, not thrown
    const said = String(warnSpy.mock.calls[0]?.[0])
    expect(said.startsWith('Skipping unstorable posting https://jobs.example/1: db_error ')).toBe(
      true,
    )
    expect(said).toContain('db_state=42501')
    expect(said).not.toContain('permission denied')
    expect(said).not.toContain(SECRET)
  })

  it('persistPostings: a non-database error is logged by its message, as before', async () => {
    const insertChain = {
      values: () => ({
        onConflictDoNothing: () => ({
          returning: () => Promise.reject(new Error('NUL byte in title')),
        }),
      }),
    }
    const svc = new JobSourcingService(
      { db: { insert: () => insertChain } } as never,
      {} as never,
      { type: 'DOU' } as never,
    )

    await (svc as unknown as Internals).persistPostings('source-1', [
      { sourceType: 'DOU', url: 'https://jobs.example/2' },
    ])

    expect(warnSpy).toHaveBeenCalledWith(
      'Skipping unstorable posting https://jobs.example/2: NUL byte in title',
    )
  })

  it('collectAll: a failing source is logged with db_state and a value-free stack, and recorded as a failure', async () => {
    const source = { id: 'src-1', type: 'DOU', enabled: true, triggerMode: 'BOTH' }
    const svc = new JobSourcingService(
      {
        db: { select: () => ({ from: () => ({ where: () => Promise.resolve([source]) }) }) },
      } as never,
      {} as never,
      { type: 'DOU' } as never,
    )
    vi.spyOn(svc as unknown as Internals, 'collectSource').mockRejectedValue(deniedQueryError())

    const run = await svc.collectAll('SCHEDULED')

    expect(run.failures).toHaveLength(1) // still swallowed and reported
    const args = errorSpy.mock.calls[0] as unknown[]
    expect(String(args[0])).toContain('Job collection failed for source DOU (src-1) db_error ')
    expect(String(args[0])).toContain('db_state=42501')
    expect(JSON.stringify(args)).not.toContain(SECRET)
    expect(String(args[1])).toContain('at Svc.run (/x/svc.ts:1:1)')
  })
})
