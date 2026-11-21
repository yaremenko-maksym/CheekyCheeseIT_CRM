import { Logger } from '@nestjs/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeRunDb } from '../test/fake-run-db'
import { MAX_ORPHAN_DELETES_PER_RUN } from '../resumes/resume-orphan-sweep.cron'
import { TAILORED_ORPHAN_GRACE_MS, TailoredSweepCron } from './tailored-sweep.cron'

const NOW = new Date('2026-11-21T12:00:00.000Z')
const MIN = 60_000
const ago = (ms: number) => new Date(NOW.getTime() - ms)
const key = (row: string, name: string) => `tailored-resumes/${row}/${name}.pdf`

/** An in-memory bucket: key -> LastModified, listed in pages of `pageSize`. */
class FakeBucket {
  readonly objects = new Map<string, Date>()
  pageSize = 1000
  failDeleteOf: string | null = null
  failList = false

  readonly delete = vi.fn(async (k: string) => {
    this.objects.delete(k)
  })
  readonly deleteOrThrow = vi.fn(async (k: string) => {
    if (k === this.failDeleteOf) throw new Error('R2 unavailable')
    this.objects.delete(k)
  })
  /** The HEAD sees what is in the bucket now; `heads` overrides it per key. */
  readonly heads = new Map<string, Date | null>()
  readonly headLastModified = vi.fn(async (k: string) =>
    this.heads.has(k) ? (this.heads.get(k) ?? null) : (this.objects.get(k) ?? null),
  )
  readonly listObjects = vi.fn(async (token: string | undefined, prefix: string) => {
    if (this.failList) throw new Error('list failed')
    // The token is the last key listed, so a delete between pages does not shift the next page.
    const all = [...this.objects]
      .filter(([k]) => k.startsWith(prefix) && (token === undefined || k > token))
      .sort(([x], [y]) => x.localeCompare(y))
    const page = all.slice(0, this.pageSize)
    return {
      objects: page.map(([k, lastModified]) => ({ key: k, sizeBytes: 1, lastModified })),
      nextContinuationToken: all.length > this.pageSize ? page.at(-1)?.[0] : undefined,
    }
  })
}

let warn: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
})
afterEach(() => vi.restoreAllMocks())

const sweep = (rows: unknown[][], bucket = new FakeBucket()) => {
  const { log, service } = fakeRunDb(rows)
  return { log, bucket, cron: new TailoredSweepCron(service, bucket as never), service }
}

describe('deleteOrphans', () => {
  it('the grace is 1 h', () => {
    expect(TAILORED_ORPHAN_GRACE_MS).toBe(3_600_000)
  })

  it('deletes an unreferenced object older than 1 h, keeps a referenced one and a 59-min one', async () => {
    const bucket = new FakeBucket()
    bucket.objects.set(key('a', 'run-1'), ago(2 * 60 * MIN))
    bucket.objects.set(key('b', 'run-2'), ago(2 * 60 * MIN))
    bucket.objects.set(key('c', 'edit-3'), ago(59 * MIN))
    const { cron, log } = sweep([[{ key: key('b', 'run-2') }]], bucket)

    const r = await cron.deleteOrphans(NOW)

    expect(r).toEqual({ deleted: 1, failed: 0, referenced: 1, young: 1, gone: 0, complete: true })
    expect(bucket.deleteOrThrow).toHaveBeenCalledExactlyOnceWith(key('a', 'run-1'))
    expect([...bucket.objects.keys()].sort()).toEqual([key('b', 'run-2'), key('c', 'edit-3')])
    expect(bucket.listObjects).toHaveBeenCalledWith(undefined, 'tailored-resumes/')
    // The referenced set is the non-null published PDF keys.
    expect(log[0]?.where?.sql).toBe('"tailored_resumes"."pdf_s3_key" is not null')
  })

  it('an object exactly 1 h old is young; 1 h + 1 ms is an orphan', async () => {
    const bucket = new FakeBucket()
    bucket.objects.set(key('a', 'run-1'), ago(60 * MIN))
    bucket.objects.set(key('b', 'run-2'), ago(60 * MIN + 1))
    const { cron } = sweep([[]], bucket)

    const r = await cron.deleteOrphans(NOW)

    expect(r).toMatchObject({ deleted: 1, young: 1 })
    expect([...bucket.objects.keys()]).toEqual([key('a', 'run-1')])
  })

  it('an object listed without LastModified is decided by the HEAD: null → kept, young → kept, old → deleted', async () => {
    const bucket = new FakeBucket()
    for (const name of ['run-gone', 'run-young', 'run-old'])
      bucket.objects.set(key('a', name), new Date(0))
    bucket.heads.set(key('a', 'run-gone'), null)
    bucket.heads.set(key('a', 'run-young'), ago(MIN))
    bucket.heads.set(key('a', 'run-old'), ago(2 * 60 * MIN))
    const { cron } = sweep([[]], bucket)

    const r = await cron.deleteOrphans(NOW)

    expect(bucket.headLastModified).toHaveBeenCalledTimes(3)
    expect(r).toEqual({ deleted: 1, failed: 0, referenced: 0, young: 1, gone: 1, complete: true })
    expect(bucket.deleteOrThrow).toHaveBeenCalledExactlyOnceWith(key('a', 'run-old'))
  })

  it('a key not shaped like a run or edit PDF is never touched, however old', async () => {
    const bucket = new FakeBucket()
    bucket.objects.set('tailored-resumes/a/notes.txt', ago(48 * 60 * MIN))
    const { cron, log } = sweep([], bucket)

    const r = await cron.deleteOrphans(NOW)

    expect(r).toEqual({ deleted: 0, failed: 0, referenced: 0, young: 0, gone: 0, complete: true })
    expect(bucket.headLastModified).not.toHaveBeenCalled()
    expect(log).toHaveLength(0) // nothing to decide, so the table is not read
  })

  it('reloads the referenced set for every page', async () => {
    const bucket = new FakeBucket()
    bucket.pageSize = 1
    bucket.objects.set(key('a', 'run-1'), ago(2 * 60 * MIN))
    bucket.objects.set(key('b', 'run-2'), ago(2 * 60 * MIN))
    // Page 2's key turned live after page 1 was decided.
    const { cron, log } = sweep([[], [{ key: key('b', 'run-2') }]], bucket)

    const r = await cron.deleteOrphans(NOW)

    expect(log).toHaveLength(2)
    expect(r).toMatchObject({ deleted: 1, referenced: 1, complete: true })
    expect([...bucket.objects.keys()]).toEqual([key('b', 'run-2')])
  })

  it('a failed delete is counted and logged; the rest go on', async () => {
    const bucket = new FakeBucket()
    bucket.objects.set(key('a', 'run-1'), ago(2 * 60 * MIN))
    bucket.objects.set(key('b', 'run-2'), ago(2 * 60 * MIN))
    bucket.failDeleteOf = key('a', 'run-1')
    const { cron } = sweep([[]], bucket)

    const r = await cron.deleteOrphans(NOW)

    expect(r).toMatchObject({ deleted: 1, failed: 1, complete: true })
    expect(warn).toHaveBeenCalledWith(
      `Tailored orphan not deleted: key=${key('a', 'run-1')} reason="R2 unavailable"`,
    )
  })

  it('a listing failure stops the run without throwing', async () => {
    const bucket = new FakeBucket()
    bucket.failList = true
    const { cron } = sweep([], bucket)

    const r = await cron.deleteOrphans(NOW)

    expect(r.complete).toBe(false)
    expect(warn).toHaveBeenCalledWith('Tailored orphan sweep stopped: reason="list failed"')
  })

  it(`stops at ${MAX_ORPHAN_DELETES_PER_RUN} delete attempts and reports the run incomplete`, async () => {
    const bucket = new FakeBucket()
    for (let i = 0; i <= MAX_ORPHAN_DELETES_PER_RUN; i++) {
      bucket.objects.set(key(`r${i}`, 'run-x'), ago(2 * 60 * MIN))
    }
    const { cron } = sweep([[]], bucket)

    const r = await cron.deleteOrphans(NOW)

    expect(r).toMatchObject({ deleted: MAX_ORPHAN_DELETES_PER_RUN, complete: false })
    expect(bucket.objects.size).toBe(1)
  })

  it('the scheduler entry takes no argument and sweeps as of now', async () => {
    const { cron } = sweep([])
    const spy = vi.spyOn(cron, 'deleteOrphans')
    await cron.sweepOrphans()
    expect(spy).toHaveBeenCalledOnce()
    expect((spy.mock.calls[0]?.[0] as Date).getTime()).toBeGreaterThan(NOW.getTime())
  })
})

describe('reapRuns', () => {
  const row = (over: Record<string, unknown>) => ({
    id: 'row-1',
    runStatus: null,
    runId: null,
    runQueuedAt: null,
    runStartedAt: null,
    pdfStatus: 'READY',
    pdfRenderId: null,
    pdfRenderStartedAt: null,
    ...over,
  })

  it('reads only rows with an active run or a RUNNING render', async () => {
    const { cron, log } = sweep([[]])
    expect(await cron.reapRuns(NOW, new Set())).toEqual({ runs: 0, renders: 0 })
    expect(log[0]?.where?.sql).toBe(
      '("tailored_resumes"."run_status" in ($1, $2) or "tailored_resumes"."pdf_status" = $3)',
    )
    expect(log[0]?.where?.params).toEqual(['QUEUED', 'RUNNING', 'RUNNING'])
  })

  it('fails a run past its deadline with STALLED; one alive or waiting for a slot is left', async () => {
    const stalled = row({
      id: 'row-1',
      runStatus: 'RUNNING',
      runId: 'run-1',
      runStartedAt: ago(11 * MIN),
    })
    const alive = row({ id: 'row-2', runStatus: 'RUNNING', runId: 'run-2', runStartedAt: ago(MIN) })
    const waiting = row({
      id: 'row-3',
      runStatus: 'QUEUED',
      runId: 'run-3',
      runQueuedAt: ago(30 * MIN),
    })
    const { cron, log, bucket } = sweep([[stalled, alive, waiting], [{ id: 'row-1' }]])

    expect(await cron.reapRuns(NOW, new Set(['run-3']))).toEqual({ runs: 1, renders: 0 })

    expect(log).toHaveLength(2)
    expect(log[1]?.set).toMatchObject({ runStatus: 'FAILED', runErrorCode: 'STALLED' })
    expect(log[1]?.where?.params).toEqual(['row-1', 'run-1', 'QUEUED', 'RUNNING'])
    expect(bucket.delete).toHaveBeenCalledExactlyOnceWith('tailored-resumes/row-1/run-run-1.pdf')
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({
      event: 'tailored_resume_run_failed',
      code: 'STALLED',
      provider: null,
      cause: 'SWEPT',
    })
  })

  it('a run another writer took first is not counted', async () => {
    const stalled = row({ runStatus: 'RUNNING', runId: 'run-1', runStartedAt: ago(11 * MIN) })
    const { cron } = sweep([[stalled], []])
    expect(await cron.reapRuns(NOW, new Set())).toEqual({ runs: 0, renders: 0 })
  })

  it('fails a render RUNNING past 2 min under a CAS on its render id; the PDF key is kept', async () => {
    const render = row({
      pdfStatus: 'RUNNING',
      pdfRenderId: 'rnd-1',
      pdfRenderStartedAt: ago(3 * MIN),
    })
    const fresh = row({
      id: 'row-2',
      pdfStatus: 'RUNNING',
      pdfRenderId: 'rnd-2',
      pdfRenderStartedAt: ago(MIN),
    })
    const { cron, log } = sweep([[render, fresh], [{ id: 'row-1' }]])

    expect(await cron.reapRuns(NOW, new Set())).toEqual({ runs: 0, renders: 1 })

    expect(log).toHaveLength(2)
    expect(log[1]?.set).toMatchObject({
      pdfStatus: 'FAILED',
      pdfRenderError: 'STALLED',
      pdfRenderId: null,
    })
    expect(log[1]?.set).not.toHaveProperty('pdfS3Key')
    expect(log[1]?.where?.sql).toBe(
      '("tailored_resumes"."id" = $1 and "tailored_resumes"."pdf_status" = $2 and "tailored_resumes"."pdf_render_id" = $3)',
    )
    expect(log[1]?.where?.params).toEqual(['row-1', 'RUNNING', 'rnd-1'])
  })

  it('a stalled render without a render id is matched by its null id; a lost CAS is not counted', async () => {
    const render = row({ pdfStatus: 'RUNNING', pdfRenderId: null, pdfRenderStartedAt: null })
    const { cron, log } = sweep([[render], []])

    expect(await cron.reapRuns(NOW, new Set())).toEqual({ runs: 0, renders: 0 })
    expect(log[1]?.where?.sql).toContain('"tailored_resumes"."pdf_render_id" is null')
  })

  it('a failing row is logged and skipped; the next row is still swept', async () => {
    const a = row({
      id: 'row-1',
      pdfStatus: 'RUNNING',
      pdfRenderId: 'rnd-1',
      pdfRenderStartedAt: ago(3 * MIN),
    })
    const b = row({
      id: 'row-2',
      pdfStatus: 'RUNNING',
      pdfRenderId: 'rnd-2',
      pdfRenderStartedAt: ago(3 * MIN),
    })
    const { cron, service } = sweep([[a, b], [{ id: 'row-2' }]])
    const db = (service as { db: { update: (t: unknown) => unknown } }).db
    const update = db.update
    db.update = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('deadlock')
      })
      .mockImplementation(update)

    expect(await cron.reapRuns(NOW, new Set())).toEqual({ runs: 0, renders: 1 })
    expect(warn).toHaveBeenCalledWith('Tailored run sweep skipped row=row-1 reason="deadlock"')
  })

  it('a failed read stops the sweep without throwing', async () => {
    const db = {
      db: {
        select: () => {
          throw new Error('db down')
        },
      },
    }
    const cron = new TailoredSweepCron(db as never, new FakeBucket() as never)
    expect(await cron.reapRuns(NOW, new Set())).toEqual({ runs: 0, renders: 0 })
    expect(warn).toHaveBeenCalledWith('Tailored run sweep stopped: reason="db down"')
  })

  it('a database error is logged by its SQLSTATE, never with the query values', async () => {
    const driver = Object.assign(new Error('permission denied for table tailored_resumes'), {
      severity: 'ERROR',
      code: '42501',
    })
    const failure = Object.assign(new Error('Failed query: select … params: SECRET-1'), {
      query: 'select "id" from "tailored_resumes"',
      params: ['SECRET-1'],
      cause: driver,
    })
    failure.name = 'DrizzleQueryError'
    const db = {
      db: {
        select: () => {
          throw failure
        },
      },
    }
    const cron = new TailoredSweepCron(db as never, new FakeBucket() as never)
    await cron.reapRuns(NOW, new Set())
    const line = String(warn.mock.calls[0]?.[0])
    expect(line).toContain('db_state=42501')
    expect(line).not.toContain('SECRET-1')
  })

  it('the scheduler entry takes no argument and passes an empty waiting set', async () => {
    const { cron } = sweep([[]])
    const spy = vi.spyOn(cron, 'reapRuns')
    await cron.sweepRuns()
    expect(spy).toHaveBeenCalledOnce()
    expect((spy.mock.calls[0]?.[0] as Date).getTime()).toBeGreaterThan(NOW.getTime())
    expect([...(spy.mock.calls[0]?.[1] as Set<string>)]).toEqual([])
  })
})
