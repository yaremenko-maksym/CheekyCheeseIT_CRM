import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DETAIL_FETCH } from '../job-sourcing/ownership/dirty-work.store'
import { hasDatabaseUrl } from '../test/require-real-db'
import { TailoredHarness } from '../test/tailored-harness'

/**
 * Plan Task 11 Step 2: the run start and the reads over a real Postgres (see `TailoredHarness`).
 * HR A and seniors A and B share team A; each case has its own opportunity, so no case sees
 * another's row. The daily cap and the POST throttle come with Task 12.
 *
 * DB-SKIP-GUARD: with no DATABASE_URL the suite is skipped (reported as skipped, never "passed").
 */
const h = new TailoredHarness(`trsvc${randomUUID().slice(0, 8)}`)
const CONFLICT = 'TAILORED_RESUME_CONFLICT'
const OPPS = ['oppIdem', 'oppRender', 'oppPub', 'oppPend', 'oppPdf'] as const
const PUBLISHED_CONTENT = JSON.stringify({
  links: [],
  skills: ['Go'],
  summary: 'Tailored',
  education: [],
  languages: [],
  experience: [],
})

const post = (opp: string, overwrite: boolean) =>
  h.call('POST', `/${h.id(opp)}/seniors/${h.id('senA')}/tailored`, 'hrA', { overwrite })
/** A published variant for (opp, senior A) with the given PDF state. */
const published = (opp: string, pdfStatus: string) =>
  h.sql(
    `INSERT INTO tailored_resumes (job_opportunity_id, senior_user_id, base_version,
       opportunity_revision, content, cover_letter, generated_at, pdf_status)
     VALUES ($1, $2, 3, 1, $3::jsonb, 'Dear team', now(), $4)`,
    [h.id(opp), h.id('senA'), PUBLISHED_CONTENT, pdfStatus],
  )
const auditRows = (opp: string) =>
  h.sql(
    `SELECT changes FROM user_audit_log
      WHERE actor_id = $1 AND action = 'tailored_resume_generate' AND changes::text LIKE $2`,
    [h.id('hrA'), `%${h.id(opp)}%`],
  )

describe.skipIf(!hasDatabaseUrl())('TailoredResumesService — real Postgres (Task 11)', () => {
  beforeAll(async () => {
    await h.open()
    await h.mkUser('hrA', 'HR')
    for (const s of ['senA', 'senB']) await h.mkUser(s, 'SENIOR')
    await h.mkTeam('teamA')
    for (const m of ['hrA', 'senA', 'senB']) await h.join('teamA', m)
    for (const s of ['senA', 'senB']) await h.verified(s)
    await h.loadLive()
    for (const opp of OPPS) {
      await h.mkOpp(opp)
      await h.lead(opp, 'senA')
      await h.lead(opp, 'senB')
    }
    await h.boot()
  })

  afterAll(() => h.close())

  beforeEach(() => {
    h.runner.enqueue.mockClear()
    h.s3.getObject.mockClear()
  })

  it('POST while a run is active answers the same run: enqueued once, one audit row', async () => {
    const first = await post('oppIdem', false)
    const second = await post('oppIdem', true)
    expect([first.status, second.status]).toEqual([202, 202])
    expect(second.json).toEqual(first.json)
    const { rows } = await h.sql(
      `SELECT id, run_id FROM tailored_resumes WHERE job_opportunity_id = $1`,
      [h.id('oppIdem')],
    )
    expect(rows).toHaveLength(1)
    expect(first.json).toEqual({ runId: rows[0].run_id })
    expect(h.runner.enqueue.mock.calls).toEqual([[rows[0].id, rows[0].run_id]])
    const audit = await auditRows('oppIdem')
    expect(audit.rows.map((r) => r.changes)).toEqual([
      {
        opportunityId: { before: null, after: h.id('oppIdem') },
        teamId: { before: null, after: h.id('teamA') },
        runId: { before: null, after: rows[0].run_id },
        overwrite: { before: null, after: false },
      },
    ])
  })

  it('POST while the PDF is QUEUED or RUNNING is the 409, even with overwrite', async () => {
    await published('oppRender', 'QUEUED')
    for (const status of ['QUEUED', 'RUNNING']) {
      await h.sql(`UPDATE tailored_resumes SET pdf_status = $2 WHERE job_opportunity_id = $1`, [
        h.id('oppRender'),
        status,
      ])
      const res = await post('oppRender', true)
      expect([status, res.status, res.json['code']]).toEqual([status, 409, CONFLICT])
    }
    expect(h.runner.enqueue).not.toHaveBeenCalled()
    expect((await auditRows('oppRender')).rowCount).toBe(0)
  })

  it('POST over a published variant without overwrite is the 409; with overwrite it starts', async () => {
    await published('oppPub', 'READY')
    const refused = await post('oppPub', false)
    expect([refused.status, refused.json['code']]).toEqual([409, CONFLICT])
    expect(h.runner.enqueue).not.toHaveBeenCalled()
    const started = await post('oppPub', true)
    expect(started.status).toBe(202)
    expect(h.runner.enqueue).toHaveBeenCalledTimes(1)
  })

  it('a posting whose detail fetch is queued is POSTING_PENDING: POST 422, the batch enqueues nothing', async () => {
    const record = h.records['oppPend'] as string
    const rev = await h.sql(
      `INSERT INTO job_source_record_revisions (source_record_id, adapter_version,
         normalizer_version, content_hash, normalized, original_identity)
       VALUES ($1, 'a1', 'n1', $2, '{}'::jsonb, '{}'::jsonb) RETURNING id`,
      [record, 'a'.repeat(64)],
    )
    await h.sql(
      `INSERT INTO job_source_record_heads (source_record_id, latest_revision_id, observed_at,
         observation_seq) VALUES ($1, $2, now(), 1)`,
      [record, rev.rows[0].id],
    )
    await h.sql(
      `INSERT INTO job_dirty_work (entity_kind, entity_id, target_version, reason)
       VALUES ('SOURCE_RECORD', $1, 1, $2)`,
      [record, DETAIL_FETCH],
    )
    const types = h.service.onDemandTypes
    h.service.onDemandTypes = () => ['GREENHOUSE_ATS']
    try {
      const res = await post('oppPend', false)
      expect([res.status, res.json['code'], res.json['params']]).toEqual([
        422,
        'TAILORED_RESUME_NOT_ELIGIBLE',
        { eligibility: 'POSTING_PENDING' },
      ])
      const batch = await h.call(
        'GET',
        `/${h.id('oppPend')}/tailored?seniorIds=${h.id('senA')}`,
        'hrA',
      )
      expect(batch.status).toBe(200)
      expect((batch.json as unknown as Array<{ eligibility: string }>)[0]?.eligibility).toBe(
        'POSTING_PENDING',
      )
    } finally {
      h.service.onDemandTypes = types
    }
    expect(h.runner.enqueue).not.toHaveBeenCalled()
    const work = await h.sql(`SELECT status FROM job_dirty_work WHERE entity_id = $1`, [record])
    expect(work.rows).toEqual([{ status: 'PENDING' }])
    const rows = await h.sql(`SELECT 1 FROM tailored_resumes WHERE job_opportunity_id = $1`, [
      h.id('oppPend'),
    ])
    expect(rows.rowCount).toBe(0)
  })

  it('GET pdf serves the previous PDF while a regenerate runs, and is the 404 when none exists', async () => {
    const key = `tailored/${h.tag}/previous.pdf`
    await published('oppPdf', 'READY')
    await h.sql(
      `UPDATE tailored_resumes SET pdf_s3_key = $2, run_status = 'RUNNING', run_id = $3
        WHERE job_opportunity_id = $1`,
      [h.id('oppPdf'), key, randomUUID()],
    )
    const res = await h.call(
      'GET',
      `/${h.id('oppPdf')}/seniors/${h.id('senA')}/tailored/pdf`,
      'hrA',
    )
    expect(res.status).toBe(200)
    expect(res.raw).toBe('%PDF-previous')
    expect(res.headers['content-type']).toBe('application/pdf')
    expect(String(res.headers['content-disposition'])).toMatch(/^attachment; filename="/)
    expect(h.s3.getObject.mock.calls).toEqual([[key]])

    // the real driver's row shape: timestamps and ints read straight into the detail answer
    const detail = await h.call('GET', `/${h.id('oppPdf')}/seniors/${h.id('senA')}/tailored`, 'hrA')
    expect(detail.status).toBe(200)
    expect(detail.json).toMatchObject({ published: true, baseChanged: false, runStatus: 'RUNNING' })
    expect(detail.json['generatedAt']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(detail.json['editedAt']).toBeNull()

    const none = await h.call(
      'GET',
      `/${h.id('oppPdf')}/seniors/${h.id('senB')}/tailored/pdf`,
      'hrA',
    )
    expect([none.status, none.json['code']]).toEqual([404, 'JOB_OPPORTUNITY_NOT_FOUND'])
    expect(h.s3.getObject).toHaveBeenCalledTimes(1)
  })
})
