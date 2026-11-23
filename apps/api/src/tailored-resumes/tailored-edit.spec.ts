import { EMPTY_RESUME_CONTENT, type ResumeContent } from '@crm/shared'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { ZodError } from 'zod'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RunFailure } from '../resumes/verification/content-gates'
import { TAILORED_RENDER_DEADLINE_MS } from './tailored-run'

const renderAccepted = vi.fn()
vi.mock('../resumes/verification/render-gates', async (orig) => ({
  ...(await orig<object>()),
  renderAccepted: (...a: unknown[]) => renderAccepted(...a),
}))

const { applyEdit, renderEdit, editedPathsOf, EDIT_MAX_PAGES } = await import('./tailored-edit')

const dialect = new PgDialect()
const ROW = '0b5e0000-0000-4000-8000-0000000000f1'
const USER = '0b5e0000-0000-4000-8000-0000000000d1'
const RENDER = '0b5e0000-0000-4000-8000-0000000000b1'
const LAYOUT = { density: 'normal', fontScale: 'normal', hiddenSections: [] }
const snapshot: ResumeContent = {
  ...EMPTY_RESUME_CONTENT,
  summary: 'Old summary.',
  skills: ['Go'],
  education: [{ institution: 'KPI', degree: 'BSc', period: '2015' }] as never,
  experience: [
    { company: 'Acme', role: 'Dev', period: '2020', bullets: ['Shipped A'] },
    { company: 'Beta', role: 'Lead', period: '2022', bullets: ['Led B', 'Hired C'] },
  ] as never,
}
const edit = {
  summary: 'New summary.',
  skills: ['Go', 'Rust'],
  bullets: [['Shipped A faster'], ['Led B']],
  coverLetter: 'Dear team, hire me.',
}

type Q = { sql: string; params: unknown[] }

/** A db double: answers by SQL shape; `updated` decides whether a CAS update matched. */
function fakeDb(
  a: {
    row?: Record<string, unknown> | null
    updated?: boolean
    lockRow?: Record<string, unknown> | null
  } = {},
) {
  const qs: Q[] = []
  const execute = vi.fn(async (q: SQL) => {
    const { sql, params } = dialect.sqlToQuery(q)
    qs.push({ sql, params })
    if (/^\s*SELECT/i.test(sql) && /FOR UPDATE/.test(sql)) {
      const r = a.lockRow === undefined ? a.row : a.lockRow
      return { rows: r ? [r] : [] }
    }
    if (/^\s*SELECT/i.test(sql)) return { rows: a.row ? [a.row] : [] }
    if (/^\s*UPDATE/i.test(sql)) return { rows: a.updated === false ? [] : [{ id: ROW }] }
    return { rows: [] }
  })
  const tx = { execute }
  const transaction = vi.fn(async (cb: (t: unknown) => Promise<unknown>) => cb(tx))
  return { db: { execute, transaction }, qs, execute, transaction }
}

const idle = { content: snapshot, run_status: 'SUCCEEDED', pdf_status: 'READY' }

beforeEach(() => vi.clearAllMocks())

describe('applyEdit', () => {
  it('locks the row, merges the edit over the snapshot and claims the render in one CAS', async () => {
    const { db, qs, transaction } = fakeDb({ row: idle })
    const got = await applyEdit(db as never, { rowId: ROW, userId: USER, edit })
    expect(got).not.toBeNull()
    expect(got?.renderId).toMatch(/^[0-9a-f-]{36}$/)
    expect(transaction).toHaveBeenCalledTimes(1)
    expect(qs).toHaveLength(2)
    const [lock, update] = qs as [Q, Q]
    expect(lock.sql).toMatch(/FROM tailored_resumes WHERE id = \$1::uuid FOR UPDATE/)
    expect(lock.params).toEqual([ROW])
    expect(update.sql).toContain(`pdf_status = 'RUNNING'`)
    expect(update.sql).toContain(
      `AND (run_status IS NULL OR run_status NOT IN ('QUEUED', 'RUNNING')) AND pdf_status NOT IN ('QUEUED', 'RUNNING')`,
    )
    const merged = JSON.parse(update.params[0] as string) as ResumeContent
    // the unedited fields of the snapshot stay; only summary, skills and bullets change
    expect(merged).toEqual({
      ...snapshot,
      summary: 'New summary.',
      skills: ['Go', 'Rust'],
      experience: [
        { company: 'Acme', role: 'Dev', period: '2020', bullets: ['Shipped A faster'] },
        { company: 'Beta', role: 'Lead', period: '2022', bullets: ['Led B'] },
      ],
    })
    expect(update.params.slice(1, 4)).toEqual([edit.coverLetter, USER, update.params[3]])
    expect(update.params).toContain(got?.renderId)
    expect(update.params.at(-1)).toBe(ROW)
  })

  it.each([
    ['a run QUEUED', { ...idle, run_status: 'QUEUED' }],
    ['a run RUNNING', { ...idle, run_status: 'RUNNING' }],
    ['a render QUEUED', { ...idle, pdf_status: 'QUEUED' }],
    ['a render RUNNING', { ...idle, pdf_status: 'RUNNING' }],
    ['nothing published', { ...idle, content: null }],
  ])('%s → null, nothing written', async (_l, row) => {
    const { db, qs } = fakeDb({ row })
    expect(await applyEdit(db as never, { rowId: ROW, userId: USER, edit })).toBeNull()
    expect(qs.filter((q) => /^\s*UPDATE/i.test(q.sql))).toHaveLength(0)
  })

  it('no row → null', async () => {
    const { db } = fakeDb({ row: null })
    expect(await applyEdit(db as never, { rowId: ROW, userId: USER, edit })).toBeNull()
  })

  it('a FAILED run and a FAILED render are free to edit', async () => {
    const { db } = fakeDb({ row: { ...idle, run_status: 'FAILED', pdf_status: 'FAILED' } })
    expect(await applyEdit(db as never, { rowId: ROW, userId: USER, edit })).not.toBeNull()
    const never = fakeDb({ row: { ...idle, run_status: null, pdf_status: 'IDLE' } })
    expect(await applyEdit(never.db as never, { rowId: ROW, userId: USER, edit })).not.toBeNull()
  })

  it('the CAS update matched nothing → null', async () => {
    const { db } = fakeDb({ row: idle, updated: false })
    expect(await applyEdit(db as never, { rowId: ROW, userId: USER, edit })).toBeNull()
  })

  it.each([
    ['one item fewer', [['Shipped A']]],
    ['one item more', [['a'], ['b'], ['c']]],
  ])('%s → 400 (a ZodError at bullets), nothing written', async (_l, bullets) => {
    const { db, qs } = fakeDb({ row: idle })
    const err = await applyEdit(db as never, {
      rowId: ROW,
      userId: USER,
      edit: { ...edit, bullets },
    }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(ZodError)
    expect((err as ZodError).issues[0]).toMatchObject({
      code: 'custom',
      path: ['bullets'],
      message: 'bullets must hold one list per experience item, in order',
    })
    expect(qs.filter((q) => /^\s*UPDATE/i.test(q.sql))).toHaveLength(0)
  })
})

describe('editedPathsOf', () => {
  it('every HR-editable path: the summary and each item’s bullets', () => {
    expect(editedPathsOf(snapshot)).toEqual([
      'summary',
      'experience.0.bullets',
      'experience.1.bullets',
    ])
  })
})

describe('renderEdit', () => {
  const NOW = new Date('2026-11-22T10:00:00.000Z')
  /** `pdf_render_started_at` `ms` before NOW, as text (how `db.execute` returns a timestamp). */
  const startedAgo = (ms: number) =>
    new Date(NOW.getTime() - ms).toISOString().replace('T', ' ').replace('Z', '+00')
  const FRESH = startedAgo(30_000)
  const claimed = {
    content: snapshot,
    layout: LAYOUT,
    template_name: 'classic',
    display_name: 'Tara Prep',
    email: 'tara@x.test',
    phone: '+380 50 000 0000',
    telegram: '@tara_prep',
  }
  const accepted = {
    pdf: Buffer.from('%PDF-edit'),
    content: snapshot,
    layout: { ...LAYOUT, density: 'compact' },
    gates: [],
    fallbacks: [],
  }
  function deps(a: Parameters<typeof fakeDb>[0]) {
    const f = fakeDb(a)
    const s3 = { upload: vi.fn(async () => undefined), delete: vi.fn(async () => undefined) }
    const logger = { warn: vi.fn(), error: vi.fn() }
    const typst = { render: vi.fn(), renderPng: vi.fn() }
    const extraction = { countRenderedPages: vi.fn(), extractRenderedPages: vi.fn() }
    const now = () => NOW
    return { ...f, s3, logger, d: { db: f.db, s3, logger, typst, extraction, now } as never }
  }
  const key = `tailored-resumes/${ROW}/edit-${RENDER}.pdf`

  it('renders the snapshot with every editable path protected, no shrink, uploads, CAS → READY, deletes the previous after', async () => {
    const t = deps({
      row: claimed,
      lockRow: { pdf_s3_key: 'tailored-resumes/x/run-old.pdf', pdf_render_started_at: FRESH },
    })
    renderAccepted.mockResolvedValueOnce(accepted)
    let committed = false
    t.transaction.mockImplementationOnce(async (cb) => {
      const out = await cb({ execute: t.execute })
      committed = true
      return out
    })
    t.s3.delete.mockImplementation(async () => void expect(committed).toBe(true))
    await renderEdit(t.d, ROW, RENDER)
    const [plan] = renderAccepted.mock.calls[0] as [Record<string, unknown>]
    expect(plan).toEqual({
      displayName: 'Tara Prep',
      email: 'tara@x.test',
      phone: '+380 50 000 0000',
      telegram: '@tara_prep',
      content: snapshot,
      layout: LAYOUT,
      templateName: 'classic',
      notes: snapshot,
      fallbacks: [],
      editedPaths: ['summary', 'experience.0.bullets', 'experience.1.bullets'],
      maxPages: EDIT_MAX_PAGES,
    })
    expect(EDIT_MAX_PAGES).toBe(2)
    // the deterministic gates only: the render deps carry no model (D21)
    const [, gateDeps] = renderAccepted.mock.calls[0] as [unknown, Record<string, () => unknown>]
    expect(gateDeps['typst']).toBe((t.d as { typst: unknown }).typst)
    expect(gateDeps['extraction']).toBe((t.d as { extraction: unknown }).extraction)
    await expect(
      (gateDeps['vision'] as unknown as { check: () => Promise<unknown> }).check(),
    ).rejects.toThrow('an edit render never runs the visual check')
    await expect(gateDeps['beforeModelCall']?.()).resolves.toBeUndefined()
    expect(t.s3.upload).toHaveBeenCalledWith(key, accepted.pdf, 'application/pdf', 'RESUME')
    const claim = t.qs[0] as Q
    expect(claim.sql).toMatch(/JOIN users u ON u\.id = t\.senior_user_id/)
    expect(claim.sql).toContain(`t.pdf_render_id = $2::uuid AND t.pdf_status = 'RUNNING'`)
    expect(claim.params).toEqual([ROW, RENDER])
    const lock = t.qs[1] as Q
    expect(lock.sql).toMatch(/pdf_render_id = \$2::uuid AND pdf_status = 'RUNNING' FOR UPDATE/)
    const update = t.qs[2] as Q
    expect(update.sql).toContain(`pdf_status = 'READY'`)
    expect(update.params.slice(0, 2)).toEqual([key, JSON.stringify(accepted.layout)])
    expect(t.s3.delete).toHaveBeenCalledTimes(1)
    expect(t.s3.delete).toHaveBeenCalledWith('tailored-resumes/x/run-old.pdf')
  })

  describe('the page limit comes from the base live PDF, like the run (plan D5)', () => {
    const BASE_KEY = 'senior-resumes/base/pdf/live.pdf'
    const BASE_PDF = Buffer.from('%PDF-base')
    const limitOf = () => (renderAccepted.mock.calls[0] as [{ maxPages: number }])[0].maxPages
    const withBase = (
      getObject: () => Promise<Buffer>,
      pages = 1,
      baseKey: string | null = BASE_KEY,
    ) => {
      const t = deps({
        row: { ...claimed, base_pdf_s3_key: baseKey },
        lockRow: { pdf_s3_key: null, pdf_render_started_at: FRESH },
      })
      const d = t.d as unknown as {
        s3: { getObject: ReturnType<typeof vi.fn> }
        extraction: { countRenderedPages: ReturnType<typeof vi.fn> }
      }
      d.s3.getObject = vi.fn(getObject)
      d.extraction.countRenderedPages.mockResolvedValue(pages)
      return { ...t, d }
    }

    it('a 1-page base caps the edit at the 1-page limit; the claim reads the base PDF key', async () => {
      const t = withBase(async () => BASE_PDF, 1)
      renderAccepted.mockResolvedValueOnce(accepted)
      await renderEdit(t.d as never, ROW, RENDER)
      expect(t.d.s3.getObject).toHaveBeenCalledWith(BASE_KEY)
      expect(t.d.extraction.countRenderedPages).toHaveBeenCalledWith(BASE_PDF)
      expect(limitOf()).toBe(1)
      const claim = t.qs[0] as Q
      expect(claim.sql).toMatch(/LEFT JOIN senior_resumes s ON s\.id = t\.base_resume_id/)
      expect(claim.sql).toContain('s.pdf_s3_key AS base_pdf_s3_key')
      expect(t.logger.warn).not.toHaveBeenCalled()
    })

    it('a 3-page base still caps at the tailored ceiling of 2', async () => {
      const t = withBase(async () => BASE_PDF, 3)
      renderAccepted.mockResolvedValueOnce(accepted)
      await renderEdit(t.d as never, ROW, RENDER)
      expect(limitOf()).toBe(2)
    })

    it('the base PDF cannot be read: EDIT_MAX_PAGES, logged, the render goes ahead', async () => {
      const t = withBase(() => Promise.reject(new Error('NoSuchKey')))
      renderAccepted.mockResolvedValueOnce(accepted)
      await renderEdit(t.d as never, ROW, RENDER)
      expect(limitOf()).toBe(EDIT_MAX_PAGES)
      expect(t.logger.warn).toHaveBeenCalledWith(
        JSON.stringify({ event: 'tailored_resume_edit_page_limit_fallback', rowId: ROW }),
      )
      expect(t.s3.upload).toHaveBeenCalledWith(key, accepted.pdf, 'application/pdf', 'RESUME')
    })

    it('the base has no PDF: EDIT_MAX_PAGES, logged, nothing read', async () => {
      const t = withBase(async () => BASE_PDF, 1, null)
      renderAccepted.mockResolvedValueOnce(accepted)
      await renderEdit(t.d as never, ROW, RENDER)
      expect(t.d.s3.getObject).not.toHaveBeenCalled()
      expect(limitOf()).toBe(EDIT_MAX_PAGES)
      expect(t.logger.warn).toHaveBeenCalledWith(
        JSON.stringify({ event: 'tailored_resume_edit_page_limit_fallback', rowId: ROW }),
      )
    })
  })

  it('no previous PDF: nothing else deleted', async () => {
    const t = deps({ row: claimed, lockRow: { pdf_s3_key: null, pdf_render_started_at: FRESH } })
    renderAccepted.mockResolvedValueOnce(accepted)
    await renderEdit(t.d, ROW, RENDER)
    expect(t.s3.delete).not.toHaveBeenCalled()
  })

  it('the render is no longer ours before it starts (swept, superseded): no render, no write', async () => {
    const t = deps({ row: null })
    await renderEdit(t.d, ROW, RENDER)
    expect(renderAccepted).not.toHaveBeenCalled()
    expect(t.s3.upload).not.toHaveBeenCalled()
    expect(t.qs).toHaveLength(1)
  })

  it('a late older edit render is dropped and its own object deleted', async () => {
    const t = deps({ row: claimed, lockRow: null })
    renderAccepted.mockResolvedValueOnce(accepted)
    await renderEdit(t.d, ROW, RENDER)
    expect(t.qs.filter((q) => /^\s*UPDATE/i.test(q.sql))).toHaveLength(0)
    expect(t.s3.delete.mock.calls).toEqual([[key]])
    expect(t.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('tailored_resume_edit_render_lost'),
    )
  })

  // SR-L-2: the CAS also bounds the render's age by the sweep's 2 min stall rule, so a render the
  // sweep has (or may have) failed never publishes.
  it.each([
    ['exactly 2 min old: still ours → READY', startedAgo(TAILORED_RENDER_DEADLINE_MS), true],
    ['2 min + 1 ms old: stalled → lost', startedAgo(TAILORED_RENDER_DEADLINE_MS + 1), false],
    ['1 ms younger than 2 min → READY', startedAgo(TAILORED_RENDER_DEADLINE_MS - 1), true],
    ['no start time: stalled → lost', null, false],
  ])('a render %s', async (_l, started, ready) => {
    const t = deps({
      row: claimed,
      lockRow: { pdf_s3_key: 'prev.pdf', pdf_render_started_at: started },
    })
    renderAccepted.mockResolvedValueOnce(accepted)
    await renderEdit(t.d, ROW, RENDER)
    const updates = t.qs.filter((q) => /^\s*UPDATE/i.test(q.sql))
    expect(updates).toHaveLength(ready ? 1 : 0)
    expect(t.s3.delete.mock.calls).toEqual(ready ? [['prev.pdf']] : [[key]])
    const lock = t.qs[1] as Q
    expect(lock.sql).toContain('pdf_render_started_at')
  })

  it('edit ATS failure on an edited path → FAILED with the code, CAS on the render id, previous key kept', async () => {
    const t = deps({ row: claimed })
    renderAccepted.mockRejectedValueOnce(new RunFailure('ATS_CHECK_FAILED', []))
    await renderEdit(t.d, ROW, RENDER)
    expect(t.s3.upload).not.toHaveBeenCalled()
    const update = t.qs.find((q) => /^\s*UPDATE/i.test(q.sql)) as Q
    expect(update.sql).toContain(`pdf_status = 'FAILED'`)
    expect(update.sql).not.toContain('pdf_s3_key')
    expect(update.sql).toContain(`pdf_render_id = $3::uuid AND pdf_status = 'RUNNING'`)
    expect(update.params).toEqual(['ATS_CHECK_FAILED', ROW, RENDER])
    // a gate failure is an outcome, not a crash: nothing logged as an error
    expect(t.logger.error).not.toHaveBeenCalled()
  })

  it('a crash (not a gate) is FAILED INTERNAL_ERROR, logged by class only; never rejects', async () => {
    const t = deps({ row: claimed })
    renderAccepted.mockRejectedValueOnce(new TypeError('secret resume text'))
    await expect(renderEdit(t.d, ROW, RENDER)).resolves.toBeUndefined()
    const update = t.qs.find((q) => /^\s*UPDATE/i.test(q.sql)) as Q
    expect(update.params[0]).toBe('INTERNAL_ERROR')
    expect(JSON.stringify(t.logger.error.mock.calls)).not.toContain('secret')
    expect(JSON.stringify(t.logger.error.mock.calls)).toContain('TypeError')
  })

  it('a verified-base-only gate code maps to INTERNAL_ERROR', async () => {
    const t = deps({ row: claimed })
    renderAccepted.mockRejectedValueOnce(new RunFailure('INCOMPLETE' as never, []))
    await renderEdit(t.d, ROW, RENDER)
    expect((t.qs.find((q) => /^\s*UPDATE/i.test(q.sql)) as Q).params[0]).toBe('INTERNAL_ERROR')
  })

  it('the upload fails after the render: FAILED, nothing published', async () => {
    const t = deps({ row: claimed })
    renderAccepted.mockResolvedValueOnce(accepted)
    t.s3.upload.mockRejectedValueOnce(new Error('s3 down'))
    await renderEdit(t.d, ROW, RENDER)
    const updates = t.qs.filter((q) => /^\s*UPDATE/i.test(q.sql))
    expect(updates).toHaveLength(1)
    expect(updates[0]?.sql).toContain(`pdf_status = 'FAILED'`)
  })

  it('the publish tx throws after the upload: own object deleted, FAILED written', async () => {
    const t = deps({ row: claimed })
    renderAccepted.mockResolvedValueOnce(accepted)
    t.transaction.mockRejectedValueOnce(new Error('db gone'))
    await renderEdit(t.d, ROW, RENDER)
    expect(t.s3.delete.mock.calls).toEqual([[key]])
    expect(t.qs.at(-1)?.sql).toContain(`pdf_status = 'FAILED'`)
  })

  it('writing FAILED itself fails: logged, never rejects', async () => {
    const t = deps({ row: claimed })
    renderAccepted.mockRejectedValueOnce(new RunFailure('RENDER_FAILED', []))
    t.execute.mockImplementation(async (q: SQL) => {
      const { sql } = dialect.sqlToQuery(q)
      if (/^\s*UPDATE/i.test(sql)) throw new Error('db gone')
      return { rows: [claimed] }
    })
    await expect(renderEdit(t.d, ROW, RENDER)).resolves.toBeUndefined()
    expect(t.logger.error).toHaveBeenCalledWith(expect.stringContaining(RENDER))
  })
})
