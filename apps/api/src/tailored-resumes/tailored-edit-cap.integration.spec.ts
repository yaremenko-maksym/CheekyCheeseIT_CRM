import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseService } from '../database/database.service'
import type { S3Service } from '../documents/s3.service'
import { hasDatabaseUrl } from '../test/require-real-db'
import { TailoredHarness } from '../test/tailored-harness'
import { assertUnderDailyCap } from './tailored-cap'
import type { TailoredRunner } from './tailored-runner'
import { TailoredSweepCron } from './tailored-sweep.cron'

/**
 * Plan Task 12 over a real Postgres as `crm_app` (see `TailoredHarness`): the daily cap, the HR
 * edit (PUT) and the sweep of an edit render. Team A (HR A, seniors A to D) carries the cap cases;
 * every case has its own opportunity, so no case sees another's row. The cap is the default 50.
 *
 * DB-SKIP-GUARD: with no DATABASE_URL the suite is skipped (reported as skipped, never "passed").
 */
const h = new TailoredHarness(`tredit${randomUUID().slice(0, 8)}`)
const CONFLICT = 'TAILORED_RESUME_CONFLICT'
const DAILY_CAP = 'TAILORED_RESUME_DAILY_CAP'
const OPPS = [
  'oppCap',
  'oppRace',
  'oppDouble',
  'oppStudio',
  'oppNoAudit',
  'oppQueued',
  'oppEdit',
  'oppShort',
  'oppTwin',
  'oppSweep',
]
const SENIORS = ['senA', 'senB', 'senC', 'senD']
const SNAPSHOT = {
  links: [{ label: 'GitHub', url: 'https://github.example.test/jane' }],
  skills: ['Go'],
  summary: 'Tailored',
  education: [],
  languages: [],
  experience: [
    { company: 'Acme', title: 'Engineer', start: '2020', end: '2024', bullets: ['Old bullet.'] },
  ],
}
const EDIT = {
  summary: 'Edited summary.',
  skills: ['Go', 'PostgreSQL'],
  bullets: [['New bullet.']],
  coverLetter: 'Edited letter.',
}

const url = (opp: string, senior = 'senA') => `/${h.id(opp)}/seniors/${h.id(senior)}/tailored`
const post = (opp: string, senior = 'senA', who = 'hrA') =>
  h.call('POST', url(opp, senior), who, { overwrite: false })
const put = (opp: string, body: unknown = EDIT) => h.call('PUT', url(opp), 'hrA', body)
/** A published variant for (opp, senior A) with a previous PDF under `prev.pdf`. */
const published = (opp: string, extra = '') =>
  h.sql(
    `INSERT INTO tailored_resumes (job_opportunity_id, senior_user_id, base_version,
       opportunity_revision, content, cover_letter, generated_at, pdf_status, pdf_s3_key ${extra ? ', run_status, run_id' : ''})
     VALUES ($1, $2, 3, 1, $3::jsonb, 'Dear team', now(), 'READY', 'prev.pdf' ${extra ? `, ${extra}` : ''})`,
    [h.id(opp), h.id('senA'), JSON.stringify(SNAPSHOT)],
  )
const row = async (opp: string) =>
  (
    await h.sql(
      `SELECT id, content, cover_letter, pdf_status, pdf_render_id, pdf_s3_key, edited_by_user_id
         FROM tailored_resumes WHERE job_opportunity_id = $1 AND senior_user_id = $2`,
      [h.id(opp), h.id('senA')],
    )
  ).rows[0]
/** `n` generate audit rows counted under `scope` at `at` (another actor: the HR never appears). */
const seedAudit = (scope: string, n: number, at = 'now()') =>
  h.sql(
    `INSERT INTO user_audit_log (actor_id, target_id, action, changes, created_at)
     SELECT $1, $1, 'tailored_resume_generate',
            jsonb_build_object('teamId', jsonb_build_object('before', null, 'after', $2::text)), ${at}
       FROM generate_series(1, $3)`,
    [h.id('filler'), scope, n],
  )
const auditOf = (action: string, opp: string) =>
  h.sql(
    `SELECT changes FROM user_audit_log
      WHERE actor_id = $1 AND action = $2 AND changes::text LIKE $3`,
    [h.id('hrA'), action, `%${h.id(opp)}%`],
  )
const scopeCount = async (scope: string) =>
  Number(
    (
      await h.sql(
        `SELECT count(*)::int AS n FROM user_audit_log
          WHERE action = 'tailored_resume_generate' AND changes->'teamId'->>'after' = $1`,
        [scope],
      )
    ).rows[0].n,
  )
const refusal = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e,
  )

describe.skipIf(!hasDatabaseUrl())('tailored resume cap and edit — real Postgres (Task 12)', () => {
  beforeAll(async () => {
    await h.open()
    await h.mkUser('hrA', 'HR')
    await h.mkUser('hrR', 'HR')
    await h.mkUser('hrD', 'HR')
    await h.mkUser('admin', 'ADMIN')
    await h.mkUser('filler', 'HR')
    for (const s of SENIORS) await h.mkUser(s, 'SENIOR')
    // SPEC-L-5: a senior of team A with no verified base, for the 422 no-audit case
    await h.mkUser('senNoBase', 'SENIOR')
    for (const t of ['teamA', 'teamRace', 'teamKyiv', 'teamDouble']) await h.mkTeam(t)
    for (const m of ['hrA', ...SENIORS, 'senNoBase']) await h.join('teamA', m)
    for (const m of ['hrR', 'senC', 'senD']) await h.join('teamRace', m)
    for (const m of ['hrD', 'senB']) await h.join('teamDouble', m)
    for (const s of SENIORS) await h.verified(s)
    await h.loadLive()
    for (const opp of OPPS) {
      await h.mkOpp(opp)
      for (const s of SENIORS) await h.lead(opp, s)
    }
    await h.lead('oppNoAudit', 'senNoBase')
    await h.boot()
  })

  afterAll(async () => {
    // the filler rows are another actor's; the harness removes only its own people's rows
    await h.sql(`DELETE FROM user_audit_log WHERE actor_id = $1`, [h.id('filler')])
    await h.close()
  })

  beforeEach(() => {
    h.runner.enqueue.mockClear()
    h.runner.renderEdit.mockClear()
  })

  it('no audit row on 404, 409 or 422 (429: the cap case below)', async () => {
    const missing = await h.call(
      'POST',
      `/${h.id('oppNoAudit')}/seniors/${randomUUID()}/tailored`,
      'hrA',
      { overwrite: false },
    )
    expect(missing.status).toBe(404)
    await published('oppNoAudit')
    const conflict = await post('oppNoAudit', 'senA')
    expect([conflict.status, conflict.json['code']]).toEqual([409, CONFLICT])
    const ineligible = await post('oppNoAudit', 'senNoBase')
    expect([ineligible.status, ineligible.json['code']]).toEqual([
      422,
      'TAILORED_RESUME_NOT_ELIGIBLE',
    ])
    expect((await auditOf('tailored_resume_generate', 'oppNoAudit')).rowCount).toBe(0)
    expect(h.runner.enqueue).not.toHaveBeenCalled()
  })

  it('team at 49 today: the POST passes; at 50 → 429 TAILORED_RESUME_DAILY_CAP, no audit, no run', async () => {
    await seedAudit(h.id('teamA'), 49)
    const passed = await post('oppCap', 'senA')
    expect(passed.status).toBe(202)
    expect(await scopeCount(h.id('teamA'))).toBe(50)
    const refused = await post('oppCap', 'senB')
    expect([refused.status, refused.json['code']]).toEqual([429, DAILY_CAP])
    expect(h.runner.enqueue).toHaveBeenCalledTimes(1)
    expect(await scopeCount(h.id('teamA'))).toBe(50)
    const rows = await h.sql(`SELECT 1 FROM tailored_resumes WHERE job_opportunity_id = $1`, [
      h.id('oppCap'),
    ])
    expect(rows.rowCount).toBe(1)
  })

  it('audit row keys ⊆ {opportunityId, teamId, runId, overwrite}, with no text', async () => {
    const { rows } = await auditOf('tailored_resume_generate', 'oppCap')
    expect(rows).toHaveLength(1)
    const allowed = ['opportunityId', 'teamId', 'runId', 'overwrite']
    expect(Object.keys(rows[0].changes).every((k) => allowed.includes(k))).toBe(true)
    expect(JSON.stringify(rows[0].changes)).not.toMatch(/Tailored|Backend|Dear/)
  })

  it('PUT while a run is QUEUED → 409, content unchanged, no audit, no render', async () => {
    await published('oppQueued', `'QUEUED', gen_random_uuid()`)
    const res = await put('oppQueued')
    expect([res.status, res.json['code']]).toEqual([409, CONFLICT])
    const r = await row('oppQueued')
    expect([r.content, r.cover_letter]).toEqual([SNAPSHOT, 'Dear team'])
    expect([r.pdf_status, r.pdf_s3_key]).toEqual(['READY', 'prev.pdf'])
    expect((await auditOf('tailored_resume_edit', 'oppQueued')).rowCount).toBe(0)
    expect(h.runner.renderEdit).not.toHaveBeenCalled()
  })

  it('PUT keeps the unedited fields of the snapshot and claims one render after the commit', async () => {
    await published('oppEdit')
    const res = await put('oppEdit')
    expect(res.status).toBe(202)
    const r = await row('oppEdit')
    expect(res.json).toEqual({ renderId: r.pdf_render_id })
    expect(r.content).toEqual({
      ...SNAPSHOT,
      summary: 'Edited summary.',
      skills: ['Go', 'PostgreSQL'],
      experience: [{ ...SNAPSHOT.experience[0], bullets: ['New bullet.'] }],
    })
    expect(r.cover_letter).toBe('Edited letter.')
    expect([r.pdf_status, r.pdf_s3_key, r.edited_by_user_id]).toEqual([
      'RUNNING',
      'prev.pdf',
      h.id('hrA'),
    ])
    expect(h.runner.renderEdit.mock.calls).toEqual([[r.id, r.pdf_render_id]])
    const audit = await auditOf('tailored_resume_edit', 'oppEdit')
    expect(audit.rows.map((a) => a.changes)).toEqual([
      {
        opportunityId: { before: null, after: h.id('oppEdit') },
        teamId: { before: null, after: h.id('teamA') },
        renderId: { before: null, after: r.pdf_render_id },
      },
    ])
  })

  it('PUT with one item fewer → 400, content unchanged, no audit', async () => {
    await published('oppShort')
    const res = await put('oppShort', { ...EDIT, bullets: [] })
    expect(res.status).toBe(400)
    const r = await row('oppShort')
    expect([r.content, r.pdf_status]).toEqual([SNAPSHOT, 'READY'])
    expect((await auditOf('tailored_resume_edit', 'oppShort')).rowCount).toBe(0)
    expect(h.runner.renderEdit).not.toHaveBeenCalled()
  })

  it('two concurrent PUTs → one renderId, the other 409', async () => {
    await published('oppTwin')
    const answers = await Promise.all([put('oppTwin'), put('oppTwin')])
    expect(answers.map((a) => a.status).sort()).toEqual([202, 409])
    const r = await row('oppTwin')
    const won = answers.find((a) => a.status === 202)
    expect(won?.json).toEqual({ renderId: r.pdf_render_id })
    expect(h.runner.renderEdit).toHaveBeenCalledTimes(1)
    expect((await auditOf('tailored_resume_edit', 'oppTwin')).rowCount).toBe(1)
  })

  it('an edit render left RUNNING by a restart → FAILED by the sweep after 2 min, previous key kept', async () => {
    await published('oppSweep')
    expect((await put('oppSweep')).status).toBe(202)
    const before = await row('oppSweep')
    await h.sql(
      `UPDATE tailored_resumes SET pdf_render_started_at = now() - interval '3 minutes' WHERE id = $1`,
      [before.id],
    )
    const runner = { waitingRunIds: () => new Set<string>() }
    const sweep = new TailoredSweepCron(
      { db: h.db } as unknown as DatabaseService,
      { delete: vi.fn() } as unknown as S3Service,
      runner as unknown as TailoredRunner,
    )
    await sweep.reapRuns(new Date(), new Set())
    const after = await row('oppSweep')
    expect([after.pdf_status, after.pdf_s3_key, after.pdf_render_id]).toEqual([
      'FAILED',
      'prev.pdf',
      null,
    ])
  })

  it('two concurrent POSTs at 49 → one 202, one 429, one run', async () => {
    await seedAudit(h.id('teamRace'), 49)
    const body = { overwrite: false, teamId: h.id('teamRace') }
    const answers = await Promise.all(
      ['senC', 'senD'].map((s) => h.call('POST', url('oppRace', s), 'hrR', body)),
    )
    expect(answers.map((a) => a.status).sort()).toEqual([202, 429])
    expect(answers.find((a) => a.status === 429)?.json['code']).toBe(DAILY_CAP)
    expect(h.runner.enqueue).toHaveBeenCalledTimes(1)
    expect(await scopeCount(h.id('teamRace'))).toBe(50)
  })

  it('a double click at 49 (two concurrent POSTs, one senior) → both 202 with one run, one audit row', async () => {
    await seedAudit(h.id('teamDouble'), 49)
    const body = { overwrite: false, teamId: h.id('teamDouble') }
    const answers = await Promise.all(
      [1, 2].map(() => h.call('POST', url('oppDouble', 'senB'), 'hrD', body)),
    )
    expect(answers.map((a) => a.status)).toEqual([202, 202])
    expect(answers[0]?.json['runId']).toBe(answers[1]?.json['runId'])
    expect(h.runner.enqueue).toHaveBeenCalledTimes(1)
    expect(await scopeCount(h.id('teamDouble'))).toBe(50)
  })

  it('ADMIN studio POSTs count under "studio", not under a team', async () => {
    const res = await post('oppStudio', 'senA', 'admin')
    expect(res.status).toBe(202)
    const { rows } = await h.sql(
      `SELECT changes->'teamId'->>'after' AS scope FROM user_audit_log
        WHERE actor_id = $1 AND action = 'tailored_resume_generate'`,
      [h.id('admin')],
    )
    expect(rows.map((r) => r.scope)).toEqual(['studio'])
  })

  it('a row written at 23:59 Kyiv time does not count the next day', async () => {
    const team = h.id('teamKyiv')
    // 2026-11-22 23:59 Kyiv (UTC+2 in winter) is 21:59 UTC
    await seedAudit(team, 50, `'2026-11-22T21:59:00Z'::timestamptz`)
    // 23:59:30 Kyiv the same day: all 50 count
    const same = await refusal(
      assertUnderDailyCap(h.db, team, 50, new Date('2026-11-22T21:59:30Z')),
    )
    expect((same as { getStatus?: () => number })?.getStatus?.()).toBe(429)
    // 00:30 Kyiv the next day (22:30 UTC): none of them count
    await expect(
      assertUnderDailyCap(h.db, team, 50, new Date('2026-11-22T22:30:00Z')),
    ).resolves.toBeUndefined()
  })
})
