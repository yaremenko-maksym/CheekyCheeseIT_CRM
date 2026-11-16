/**
 * ResumeOrphanSweepCron — unit spec (backlog item 441).
 *
 * Offline: the bucket is an in-memory map and the DB is a fake that answers
 * `select(shape).from(table)` by projecting rows through the column names in
 * `shape`, so a select that drops a column really loses that column here too.
 */
import { Logger } from '@nestjs/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_ORPHAN_DELETES_PER_RUN,
  ORPHAN_GRACE_MS,
  ResumeOrphanSweepCron,
  SENIOR_RESUMES_PREFIX,
  STAGED_RESUMES_PREFIX,
} from './resume-orphan-sweep.cron'

const NOW = new Date('2026-11-15T05:00:00.000Z')
const HOUR = 60 * 60 * 1000
const OLD = new Date(NOW.getTime() - 48 * HOUR)

/** A row as Postgres would return it, keyed by column name. */
type Row = Record<string, unknown>

class FakeBucket {
  /** key -> LastModified; `undefined` = the backend sent none. */
  readonly objects = new Map<string, Date | undefined>()
  pageSize = 1000
  failListAtPage: number | null = null
  readonly failDelete = new Set<string>()
  /** Keys the fake listing returns even though they are outside the asked prefix. */
  readonly foreign: string[] = []

  readonly listObjects = vi.fn(async (token: string | undefined, prefix: string) => {
    // Like S3, the token resumes AFTER the last key returned, so deletes do not shift pages.
    const [pageText, after] = token ? token.split('|') : ['0', '']
    const page = Number(pageText)
    if (this.failListAtPage === page) throw new Error('ListObjectsV2 timed out')
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix) && k > after!).sort()
    const slice = keys.slice(0, this.pageSize)
    const objects = [...slice, ...(page === 0 ? this.foreign : [])].map((key) => ({
      key,
      sizeBytes: 1,
      // Mirrors S3Service.listObjects: a missing LastModified arrives as epoch 0.
      lastModified: this.objects.get(key) ?? new Date(0),
    }))
    const more = keys.length > this.pageSize
    return { objects, nextContinuationToken: more ? `${page + 1}|${slice.at(-1)}` : undefined }
  })

  readonly deleteOrThrow = vi.fn(async (key: string) => {
    if (this.failDelete.has(key)) throw new Error(`DeleteObject failed for ${key}`)
    this.objects.delete(key)
  })

  /** The age re-check right before a delete: the current date, or null once the object is gone. */
  readonly headLastModified = vi.fn(async (key: string) => this.objects.get(key) ?? null)

  /** The swallowing delete must never be the one the sweep uses. */
  readonly delete = vi.fn()
}

function fakeDb(rows: Row[], fail?: () => boolean) {
  return {
    db: {
      select: (shape: Record<string, { name: string }>) => ({
        from: async () => {
          if (fail?.()) throw new Error('connection terminated')
          return rows.map((row) =>
            Object.fromEntries(Object.entries(shape).map(([alias, col]) => [alias, row[col.name]])),
          )
        },
      }),
    },
  }
}

describe('ResumeOrphanSweepCron', () => {
  let bucket: FakeBucket
  let rows: Row[]
  let warn: ReturnType<typeof vi.spyOn>
  let log: ReturnType<typeof vi.spyOn>

  const make = (fail?: () => boolean) =>
    new ResumeOrphanSweepCron(fakeDb(rows, fail) as never, bucket as never)

  beforeEach(() => {
    bucket = new FakeBucket()
    rows = []
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
  })
  afterEach(() => vi.restoreAllMocks())

  it('constants: daily sweep of senior-resumes/ with a 24 h grace and a 500 cap', () => {
    expect(SENIOR_RESUMES_PREFIX).toBe('senior-resumes/')
    expect(STAGED_RESUMES_PREFIX).toBe('resumes/')
    expect(ORPHAN_GRACE_MS).toBe(24 * HOUR)
    expect(MAX_ORPHAN_DELETES_PER_RUN).toBe(500)
  })

  it('AC5: deletes the superseded source a failed delete left behind; every referenced key stays', async () => {
    const u = 'senior-resumes/u1'
    const orphan = `${u}/r1-1000` // the source the failed superseded-source delete left
    const source = `${u}/r1-2000`
    const pdf = `${u}/pdf/r1-abcdef0123456789.pdf`
    const staged = `${u}/staged-in-prefix.pdf`
    const previous = `${u}/previous-staged.pdf`
    for (const k of [orphan, source, pdf, staged, previous]) bucket.objects.set(k, OLD)
    rows = [
      {
        source_s3_key: source,
        pdf_s3_key: pdf,
        staged_pdf_s3_key: staged,
        staged_previous: { pdfKey: previous, content: { name: 'never read' } },
      },
      { source_s3_key: null, pdf_s3_key: null, staged_pdf_s3_key: null, staged_previous: null },
    ]

    const result = await make().sweep(NOW)

    expect(bucket.listObjects).toHaveBeenCalledWith(undefined, 'senior-resumes/')
    expect(bucket.deleteOrThrow.mock.calls).toEqual([[orphan]])
    expect(bucket.delete).not.toHaveBeenCalled()
    expect([...bucket.objects.keys()].sort()).toEqual([source, pdf, staged, previous].sort())
    expect(result).toEqual({
      listed: 5,
      deleted: 1,
      failed: 0,
      referenced: 4,
      young: 0,
      undated: 0,
      gone: 0,
      complete: true,
    })
    expect(log).toHaveBeenCalledWith(
      'Resume orphan sweep: listed=5 deleted=1 failed=0 referenced=4 young=0 undated=0 gone=0 complete=true',
    )
  })

  it('a staged_previous without a string pdfKey references nothing', async () => {
    bucket.objects.set('senior-resumes/u1/a', OLD)
    bucket.objects.set('senior-resumes/u1/b', OLD)
    rows = [
      { staged_previous: { pdfKey: 42 } },
      { staged_previous: 'senior-resumes/u1/a' },
      { staged_previous: { pdfKey: 'senior-resumes/u1/b' } },
    ]
    await make().sweep(NOW)
    expect(bucket.deleteOrThrow.mock.calls).toEqual([['senior-resumes/u1/a']])
  })

  it('keeps an orphan younger than 24 h and one exactly 24 h old; deletes one a millisecond older', async () => {
    const edge = NOW.getTime() - ORPHAN_GRACE_MS
    bucket.objects.set('senior-resumes/u/young', new Date(NOW.getTime() - 23 * HOUR))
    bucket.objects.set('senior-resumes/u/edge', new Date(edge))
    bucket.objects.set('senior-resumes/u/past', new Date(edge - 1))

    const result = await make().sweep(NOW)

    expect(bucket.deleteOrThrow.mock.calls).toEqual([['senior-resumes/u/past']])
    // The listing alone decides young: neither young key reaches the HEAD re-check.
    expect(bucket.headLastModified.mock.calls).toEqual([['senior-resumes/u/past']])
    expect(result).toMatchObject({ deleted: 1, young: 2 })
  })

  it('keeps an object the backend listed without a LastModified', async () => {
    bucket.objects.set('senior-resumes/u/undated', undefined)
    const result = await make().sweep(NOW)
    expect(bucket.deleteOrThrow).not.toHaveBeenCalled()
    expect(result).toMatchObject({ deleted: 0, undated: 1, complete: true })
  })

  it('never deletes a listed key outside the senior-resumes/ prefix', async () => {
    // Aged, so only the prefix check can keep them.
    for (const k of ['documents/someone-else.pdf', 'senior-resumesX/u/a']) {
      bucket.foreign.push(k)
      bucket.objects.set(k, OLD)
    }
    const result = await make().sweep(NOW)
    expect(bucket.deleteOrThrow).not.toHaveBeenCalled()
    // The fake returns the foreign keys on the first page of each of the two prefixes.
    expect(result).toMatchObject({ listed: 4, deleted: 0 })
  })

  it('walks every page with the continuation token', async () => {
    bucket.pageSize = 2
    for (const n of [1, 2, 3, 4, 5]) bucket.objects.set(`senior-resumes/u/${n}`, OLD)
    const result = await make().sweep(NOW)
    expect(bucket.listObjects.mock.calls).toEqual([
      [undefined, 'senior-resumes/'],
      ['1|senior-resumes/u/2', 'senior-resumes/'],
      ['2|senior-resumes/u/4', 'senior-resumes/'],
      [undefined, 'resumes/'],
    ])
    expect(result).toMatchObject({ listed: 5, deleted: 5, complete: true })
  })

  it('reloads the referenced set for every page, so a key referenced mid-run is not taken', async () => {
    bucket.pageSize = 1
    bucket.objects.set('senior-resumes/u/a', OLD)
    bucket.objects.set('senior-resumes/u/b', OLD)
    // After page 1 is listed, a render points the row at the key on page 2.
    const cron = make()
    bucket.listObjects.mockImplementationOnce(async () => {
      rows.push({ pdf_s3_key: 'senior-resumes/u/b' })
      return {
        objects: [{ key: 'senior-resumes/u/a', sizeBytes: 1, lastModified: OLD }],
        nextContinuationToken: '1|senior-resumes/u/a',
      }
    })
    await cron.sweep(NOW)
    expect(bucket.deleteOrThrow.mock.calls).toEqual([['senior-resumes/u/a']])
  })

  it('a listing failure on the first page deletes nothing and logs one warning', async () => {
    bucket.objects.set('senior-resumes/u/orphan', OLD)
    bucket.failListAtPage = 0
    const result = await make().sweep(NOW)
    expect(bucket.deleteOrThrow).not.toHaveBeenCalled()
    expect(result).toMatchObject({ deleted: 0, complete: false })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      'Resume orphan sweep stopped: stage=list reason="ListObjectsV2 timed out" deleted=0 failed=0',
    )
  })

  it('a listing failure on a later page stops the run: no delete after it', async () => {
    bucket.pageSize = 1
    bucket.objects.set('senior-resumes/u/a', OLD)
    bucket.objects.set('senior-resumes/u/b', OLD)
    bucket.failListAtPage = 1
    const result = await make().sweep(NOW)
    expect(bucket.deleteOrThrow.mock.calls).toEqual([['senior-resumes/u/a']])
    expect(result).toMatchObject({ deleted: 1, complete: false })
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('a failure loading the referenced set deletes nothing and logs one warning', async () => {
    bucket.objects.set('senior-resumes/u/orphan', OLD)
    const result = await make(() => true).sweep(NOW)
    expect(bucket.deleteOrThrow).not.toHaveBeenCalled()
    expect(result).toMatchObject({ deleted: 0, complete: false })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      'Resume orphan sweep stopped: stage=references reason="connection terminated" deleted=0 failed=0',
    )
  })

  it('a key the listing saw as old but a render re-uploaded since is not deleted', async () => {
    bucket.objects.set('senior-resumes/u/rerendered', OLD)
    bucket.objects.set('senior-resumes/u/orphan', OLD)
    // The render re-uploads the fingerprinted key after the page was listed.
    bucket.listObjects.mockImplementationOnce(async () => {
      const objects = [...bucket.objects.keys()].map((key) => ({
        key,
        sizeBytes: 1,
        lastModified: OLD,
      }))
      bucket.objects.set('senior-resumes/u/rerendered', new Date(NOW.getTime() - HOUR))
      return { objects, nextContinuationToken: undefined }
    })
    const result = await make().sweep(NOW)
    expect(bucket.headLastModified.mock.calls).toEqual([
      ['senior-resumes/u/rerendered'],
      ['senior-resumes/u/orphan'],
    ])
    expect(bucket.deleteOrThrow.mock.calls).toEqual([['senior-resumes/u/orphan']])
    expect(result).toMatchObject({ deleted: 1, failed: 0, young: 1, complete: true })
  })

  it('the re-check keeps an object exactly 24 h old and deletes one a millisecond older', async () => {
    bucket.objects.set('senior-resumes/u/a', OLD)
    bucket.objects.set('senior-resumes/u/b', OLD)
    const edge = NOW.getTime() - ORPHAN_GRACE_MS
    bucket.headLastModified
      .mockResolvedValueOnce(new Date(edge))
      .mockResolvedValueOnce(new Date(edge - 1))
    const result = await make().sweep(NOW)
    expect(bucket.deleteOrThrow.mock.calls).toEqual([['senior-resumes/u/b']])
    expect(result).toMatchObject({ deleted: 1, young: 1 })
  })

  it('an object gone by the re-check is skipped: no delete, not failed, no warning', async () => {
    bucket.objects.set('senior-resumes/u/gone', OLD)
    bucket.headLastModified.mockResolvedValueOnce(null)
    const result = await make().sweep(NOW)
    expect(bucket.deleteOrThrow).not.toHaveBeenCalled()
    expect(result).toMatchObject({ deleted: 0, failed: 0, young: 0, gone: 1, complete: true })
    expect(warn).not.toHaveBeenCalled()
  })

  it('a failed re-check counts as failed, is logged by key, and the next key is still processed', async () => {
    bucket.objects.set('senior-resumes/u/a', OLD)
    bucket.objects.set('senior-resumes/u/b', OLD)
    bucket.headLastModified.mockRejectedValueOnce(new Error('HeadObject timed out'))
    const result = await make().sweep(NOW)
    expect(bucket.deleteOrThrow.mock.calls).toEqual([['senior-resumes/u/b']])
    expect(result).toMatchObject({ deleted: 1, failed: 1, complete: true })
    expect(warn).toHaveBeenCalledWith(
      'Resume orphan not deleted: key=senior-resumes/u/a reason="HeadObject timed out"',
    )
  })

  it('the referenced set holds only the string keys rows point at', async () => {
    rows = [
      {
        source_s3_key: 'senior-resumes/u/s',
        pdf_s3_key: null,
        staged_pdf_s3_key: 'senior-resumes/u/st',
        staged_previous: { pdfKey: 7 },
      },
      {
        source_s3_key: null,
        pdf_s3_key: 'senior-resumes/u/p',
        staged_pdf_s3_key: null,
        staged_previous: { pdfKey: 'senior-resumes/u/prev' },
      },
    ]
    const cron = make() as unknown as { referencedKeys(): Promise<Set<string>> }
    expect(await cron.referencedKeys()).toEqual(
      new Set([
        'senior-resumes/u/s',
        'senior-resumes/u/st',
        'senior-resumes/u/p',
        'senior-resumes/u/prev',
      ]),
    )
  })

  it('a page with no aged object does not query the database', async () => {
    bucket.objects.set('senior-resumes/u/young', new Date(NOW.getTime() - HOUR))
    const fail = vi.fn(() => true)
    const result = await make(fail).sweep(NOW)
    expect(fail).not.toHaveBeenCalled()
    expect(result).toMatchObject({ young: 1, complete: true })
  })

  it('one failed delete does not stop the rest, and is logged by key', async () => {
    for (const k of ['a', 'b', 'c']) bucket.objects.set(`senior-resumes/u/${k}`, OLD)
    bucket.failDelete.add('senior-resumes/u/b')
    const result = await make().sweep(NOW)
    expect(bucket.deleteOrThrow).toHaveBeenCalledTimes(3)
    expect([...bucket.objects.keys()]).toEqual(['senior-resumes/u/b'])
    expect(result).toMatchObject({ deleted: 2, failed: 1, complete: true })
    expect(warn).toHaveBeenCalledWith(
      'Resume orphan not deleted: key=senior-resumes/u/b reason="DeleteObject failed for senior-resumes/u/b"',
    )
  })

  it('a non-Error rejection is logged as "unknown error"', async () => {
    bucket.objects.set('senior-resumes/u/a', OLD)
    bucket.deleteOrThrow.mockRejectedValueOnce('boom')
    const result = await make().sweep(NOW)
    expect(result).toMatchObject({ deleted: 0, failed: 1 })
    expect(warn).toHaveBeenCalledWith(
      'Resume orphan not deleted: key=senior-resumes/u/a reason="unknown error"',
    )
  })

  it('stops at the cap of delete attempts per run and says so', async () => {
    const total = MAX_ORPHAN_DELETES_PER_RUN + 2
    for (let n = 0; n < total; n += 1) {
      bucket.objects.set(`senior-resumes/u/${String(n).padStart(4, '0')}`, OLD)
    }
    bucket.failDelete.add('senior-resumes/u/0000') // a failed attempt counts toward the cap
    const result = await make().sweep(NOW)
    expect(bucket.deleteOrThrow).toHaveBeenCalledTimes(MAX_ORPHAN_DELETES_PER_RUN)
    expect(result).toMatchObject({
      deleted: MAX_ORPHAN_DELETES_PER_RUN - 1,
      failed: 1,
      complete: false,
    })
    expect(warn).toHaveBeenCalledWith(
      'Resume orphan sweep hit the cap of 500 deletes under senior-resumes/; the rest waits for the next run',
    )
  })

  it('exactly the cap of orphans is a complete run with no cap warning', async () => {
    for (let n = 0; n < MAX_ORPHAN_DELETES_PER_RUN; n += 1) {
      bucket.objects.set(`senior-resumes/u/${String(n).padStart(4, '0')}`, OLD)
    }
    const result = await make().sweep(NOW)
    expect(result).toMatchObject({ deleted: MAX_ORPHAN_DELETES_PER_RUN, complete: true })
    expect(warn).not.toHaveBeenCalled()
  })

  it('runs one sweep at a time in a process; the guard is released after a run', async () => {
    bucket.objects.set('senior-resumes/u/orphan', OLD)
    let release!: () => void
    bucket.listObjects.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              objects: [{ key: 'senior-resumes/u/orphan', sizeBytes: 1, lastModified: OLD }],
              nextContinuationToken: undefined,
            })
        }),
    )
    const cron = make()
    const first = cron.sweep(NOW)
    expect(await cron.sweep(NOW)).toBeNull()
    expect(log).toHaveBeenCalledWith('Resume orphan sweep skipped: a run is already in progress')
    release()
    expect(await first).toMatchObject({ deleted: 1 })
    expect(await cron.sweep(NOW)).toMatchObject({ listed: 0, complete: true })
  })

  it('the guard is released after a run that stopped on a failure', async () => {
    bucket.failListAtPage = 0
    const cron = make()
    expect(await cron.sweep(NOW)).toMatchObject({ complete: false })
    bucket.failListAtPage = null
    expect(await cron.sweep(NOW)).toMatchObject({ complete: true })
  })

  it('the scheduler handler ignores what cron passes and sweeps with the current time', async () => {
    vi.useFakeTimers({ now: NOW })
    try {
      bucket.objects.set('senior-resumes/u/young', new Date(NOW.getTime() - HOUR))
      bucket.objects.set('senior-resumes/u/old', OLD)
      const cron = make()
      // What `cron` hands `onTick`: its onComplete callback.
      await (cron.handleSweep as (...args: unknown[]) => Promise<void>).call(cron, () => undefined)
      expect(bucket.deleteOrThrow.mock.calls).toEqual([['senior-resumes/u/old']])
    } finally {
      vi.useRealTimers()
    }
  })

  it('defaults "now" to the current time', async () => {
    vi.useFakeTimers({ now: NOW })
    try {
      bucket.objects.set('senior-resumes/u/young', new Date(NOW.getTime() - HOUR))
      bucket.objects.set('senior-resumes/u/old', OLD)
      await make().sweep()
      expect(bucket.deleteOrThrow.mock.calls).toEqual([['senior-resumes/u/old']])
    } finally {
      vi.useRealTimers()
    }
  })

  describe('staged PDFs under resumes/<id>/staged/ (backlog 448)', () => {
    const staged = (run: string) => `resumes/r-1/staged/${run}.pdf`

    it('deletes an aged staged PDF no row points at; current, previous and young ones stay', async () => {
      const young = new Date(NOW.getTime() - 23 * HOUR)
      for (const run of ['orphan', 'current', 'previous']) bucket.objects.set(staged(run), OLD)
      bucket.objects.set(staged('young'), young)
      rows = [
        {
          staged_pdf_s3_key: staged('current'),
          staged_previous: { pdfKey: staged('previous') },
        },
      ]

      const result = await make().sweep(NOW)

      expect(bucket.listObjects.mock.calls).toEqual([
        [undefined, 'senior-resumes/'],
        [undefined, 'resumes/'],
      ])
      expect(bucket.deleteOrThrow.mock.calls).toEqual([[staged('orphan')]])
      expect(bucket.headLastModified.mock.calls).toEqual([[staged('orphan')]])
      expect(result).toEqual({
        listed: 4,
        deleted: 1,
        failed: 0,
        referenced: 2,
        young: 1,
        undated: 0,
        gone: 0,
        complete: true,
      })
    })

    it('a confirmed staged key now held by pdf_s3_key is the live PDF and stays', async () => {
      bucket.objects.set(staged('confirmed'), OLD)
      rows = [{ pdf_s3_key: staged('confirmed'), staged_pdf_s3_key: null }]
      const result = await make().sweep(NOW)
      expect(bucket.deleteOrThrow).not.toHaveBeenCalled()
      expect(result).toMatchObject({ referenced: 1, deleted: 0 })
    })

    it('the HEAD re-check keeps a staged key re-written since the listing', async () => {
      bucket.objects.set(staged('rewritten'), OLD)
      bucket.headLastModified.mockResolvedValueOnce(new Date(NOW.getTime() - HOUR))
      const result = await make().sweep(NOW)
      expect(bucket.deleteOrThrow).not.toHaveBeenCalled()
      expect(result).toMatchObject({ young: 1, deleted: 0 })
    })

    it('never deletes anything under resumes/ that is not a staged PDF', async () => {
      for (const k of [
        'resumes/r-1/other.pdf',
        'resumes/r-1/staged/run.txt',
        'resumes/r-1/staged/nested/run.pdf',
        'resumes/a/b/staged/run.pdf',
        'resumes/r-1/staged/run.pdf.bak',
        'resumes/r-1/staged/runxpdf',
        'resumes/staged/run.pdf',
        'xresumes/r-1/staged/run.pdf',
      ]) {
        bucket.objects.set(k, OLD)
        if (!k.startsWith('resumes/')) bucket.foreign.push(k)
      }
      const result = await make().sweep(NOW)
      expect(bucket.deleteOrThrow).not.toHaveBeenCalled()
      expect(bucket.headLastModified).not.toHaveBeenCalled()
      expect(result).toMatchObject({ deleted: 0, complete: true })
    })

    it('each prefix has its own cap: staged keys are reached when senior-resumes/ alone exceeds it', async () => {
      bucket.pageSize = 100 // more pages after the cap: the capped prefix must stop listing
      for (let n = 0; n < MAX_ORPHAN_DELETES_PER_RUN + 1; n++) {
        bucket.objects.set(`senior-resumes/u/${String(n).padStart(4, '0')}`, OLD)
      }
      bucket.objects.set(staged('orphan'), OLD)
      const result = await make().sweep(NOW)
      expect(bucket.objects.has(staged('orphan'))).toBe(false)
      expect(bucket.objects.has('senior-resumes/u/0500')).toBe(true)
      expect(result).toMatchObject({ deleted: MAX_ORPHAN_DELETES_PER_RUN + 1, complete: false })
      expect(warn).toHaveBeenCalledTimes(1)
    })

    it("the staged cap counts only the staged prefix's attempts, failed ones included", async () => {
      bucket.objects.set('senior-resumes/u/fails', OLD)
      bucket.failDelete.add('senior-resumes/u/fails')
      for (let n = 0; n < MAX_ORPHAN_DELETES_PER_RUN + 1; n++) {
        bucket.objects.set(staged(String(n).padStart(4, '0')), OLD)
      }
      const result = await make().sweep(NOW)
      expect(result).toMatchObject({
        deleted: MAX_ORPHAN_DELETES_PER_RUN,
        failed: 1,
        complete: false,
      })
    })

    it('the staged prefix stops at its own cap', async () => {
      for (let n = 0; n < MAX_ORPHAN_DELETES_PER_RUN + 1; n++) {
        bucket.objects.set(staged(String(n).padStart(4, '0')), OLD)
      }
      const result = await make().sweep(NOW)
      expect(bucket.deleteOrThrow).toHaveBeenCalledTimes(MAX_ORPHAN_DELETES_PER_RUN)
      expect(result).toMatchObject({ deleted: MAX_ORPHAN_DELETES_PER_RUN, complete: false })
      expect(warn).toHaveBeenCalledWith(
        'Resume orphan sweep hit the cap of 500 deletes under resumes/; the rest waits for the next run',
      )
    })

    it('exactly the cap under each prefix is a complete run', async () => {
      for (let n = 0; n < MAX_ORPHAN_DELETES_PER_RUN; n++) {
        bucket.objects.set(`senior-resumes/u/${String(n).padStart(4, '0')}`, OLD)
        bucket.objects.set(staged(String(n).padStart(4, '0')), OLD)
      }
      const result = await make().sweep(NOW)
      expect(result).toMatchObject({ deleted: 2 * MAX_ORPHAN_DELETES_PER_RUN, complete: true })
      expect(warn).not.toHaveBeenCalled()
    })

    it('a listing failure on resumes/ stops the run after senior-resumes/ was swept', async () => {
      bucket.objects.set('senior-resumes/u/orphan', OLD)
      bucket.objects.set(staged('orphan'), OLD)
      const list = bucket.listObjects.getMockImplementation()!
      bucket.listObjects.mockImplementation(async (token, prefix) => {
        if (prefix === 'resumes/') throw new Error('ListObjectsV2 timed out')
        return list(token, prefix)
      })
      const result = await make().sweep(NOW)
      expect(bucket.deleteOrThrow.mock.calls).toEqual([['senior-resumes/u/orphan']])
      expect(bucket.objects.has(staged('orphan'))).toBe(true)
      expect(result).toMatchObject({ deleted: 1, complete: false })
      expect(warn).toHaveBeenCalledWith(
        'Resume orphan sweep stopped: stage=list reason="ListObjectsV2 timed out" deleted=1 failed=0',
      )
    })
  })
})
