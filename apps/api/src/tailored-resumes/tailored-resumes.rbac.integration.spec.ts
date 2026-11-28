import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { hasDatabaseUrl } from '../test/require-real-db'
import { type Method, TailoredHarness } from '../test/tailored-harness'

/**
 * Plan Task 11 Step 1: the tailored routes through the real guard chain and the real service over
 * a real Postgres (see `TailoredHarness`). Team A holds HR A and the seniors A, Stop (stop-listed on
 * the posting) and Left (left the team); team B holds HR B and senior B. Every 404 is the queue's
 * uniform one: an out-of-scope answer must not tell itself apart from an unknown id.
 *
 * DB-SKIP-GUARD: with no DATABASE_URL the suite is skipped (reported as skipped, never "passed").
 */
const h = new TailoredHarness(`trbac${randomUUID().slice(0, 8)}`)
const NOT_FOUND = 'JOB_OPPORTUNITY_NOT_FOUND'
const ROLE_REFUSAL = 'FORBIDDEN_INSUFFICIENT_ROLE'
const STOP_WORD = 'zzstopword'
const EDIT = { summary: 'Edited.', skills: ['Go'], bullets: [], coverLetter: 'Hello.' }

/** One request per route for (opportunity, senior): only the guard or the scope can refuse it. */
const routes = (opp: string, senior: string): Array<[Method, string, unknown]> => [
  ['GET', `/${opp}/tailored?seniorIds=${senior}`, undefined],
  ['POST', `/${opp}/seniors/${senior}/tailored`, { overwrite: false }],
  ['GET', `/${opp}/seniors/${senior}/tailored`, undefined],
  ['GET', `/${opp}/seniors/${senior}/tailored/pdf`, undefined],
  ['PUT', `/${opp}/seniors/${senior}/tailored`, EDIT],
]

describe.skipIf(!hasDatabaseUrl())(
  'tailored resume routes — real-controller RBAC (Task 11)',
  () => {
    beforeAll(async () => {
      await h.open()
      await h.mkUser('admin', 'ADMIN')
      for (const hr of ['hrA', 'hrB']) await h.mkUser(hr, 'HR')
      for (const s of ['senA', 'senStop', 'senLeft', 'senB']) await h.mkUser(s, 'SENIOR')
      await h.mkUser('jun', 'JUNIOR')
      await h.mkUser('acc', 'ACCOUNTANT')
      for (const t of ['teamA', 'teamB']) await h.mkTeam(t)
      for (const m of ['hrA', 'senA', 'senStop', 'senLeft']) await h.join('teamA', m)
      for (const m of ['hrB', 'senB']) await h.join('teamB', m)
      await h.sql(`UPDATE team_members SET left_at = now() WHERE user_id = $1`, [h.id('senLeft')])
      for (const s of ['senA', 'senStop', 'senLeft', 'senB']) await h.verified(s)
      await h.sql(
        `INSERT INTO job_exclusion_filters (senior_id, kind, value, normalized_value)
       VALUES ($1, 'KEYWORD', $2, $2)`,
        [h.id('senStop'), STOP_WORD],
      )
      await h.loadLive()
      await h.mkOpp('oppA', `oppA ${STOP_WORD}`)
      await h.lead('oppA', 'senA')
      await h.lead('oppA', 'senStop')
      await h.mkOpp('oppB')
      await h.lead('oppB', 'senB')
      await h.boot()
    })

    afterAll(() => h.close())

    beforeEach(() => {
      h.enabled = true
      h.runner.enqueue.mockClear()
      h.runner.renderEdit.mockClear()
    })

    it('SENIOR, JUNIOR and ACCOUNTANT get 403 on every route', async () => {
      for (const who of ['senA', 'jun', 'acc']) {
        for (const [method, url, body] of routes(h.id('oppA'), h.id('senA'))) {
          const res = await h.call(method, url, who, body)
          expect([who, method, url, res.status]).toEqual([who, method, url, 403])
          expect(res.json['code']).toBe(ROLE_REFUSAL)
        }
      }
      expect(h.runner.enqueue).not.toHaveBeenCalled()
      expect(h.runner.renderEdit).not.toHaveBeenCalled()
    })

    it('HR outside the scope gets the uniform 404 on POST, GET and GET pdf, and on the batch', async () => {
      for (const [method, url, body] of routes(h.id('oppA'), h.id('senA'))) {
        const res = await h.call(method, url, 'hrB', body)
        expect([method, url, res.status, res.json['code']]).toEqual([method, url, 404, NOT_FOUND])
      }
      // the opportunity is visible to B, the senior is not B's
      for (const [method, url, body] of routes(h.id('oppB'), h.id('senA')).slice(1)) {
        const res = await h.call(method, url, 'hrB', body)
        expect([method, url, res.status, res.json['code']]).toEqual([method, url, 404, NOT_FOUND])
      }
      expect(h.runner.enqueue).not.toHaveBeenCalled()
      const rows = await h.sql(`SELECT 1 FROM tailored_resumes WHERE senior_user_id = $1`, [
        h.id('senA'),
      ])
      expect(rows.rowCount).toBe(0)
    })

    it('an out-of-scope opportunity and an unknown one answer byte-equal bodies', async () => {
      const unknown = randomUUID()
      for (const [i, [method, url, body]] of routes(h.id('oppA'), h.id('senA')).entries()) {
        const out = await h.call(method, url, 'hrB', body)
        const [, unknownUrl] = routes(unknown, h.id('senA'))[i] as [Method, string, unknown]
        const none = await h.call(method, unknownUrl, 'hrB', body)
        expect([url, out.status, out.raw]).toEqual([url, none.status, none.raw])
      }
    })

    it('the batch omits a senior outside the scope and a stop-listed one', async () => {
      const asked = [h.id('senA'), h.id('senB'), h.id('senStop'), h.id('senLeft')].join(',')
      const res = await h.call('GET', `/${h.id('oppA')}/tailored?seniorIds=${asked}`, 'hrA')
      expect(res.status).toBe(200)
      const got = res.json as unknown as Array<{ seniorId: string; eligibility: string }>
      expect(got.map((r) => [r.seniorId, r.eligibility])).toEqual([[h.id('senA'), 'READY']])
      expect(res.raw).not.toContain(h.id('senB'))
      expect(res.raw).not.toContain(h.id('senStop'))
    })

    it('a senior who left the team and a stop-listed senior are the 404 on POST, GET and GET pdf', async () => {
      for (const senior of ['senLeft', 'senStop']) {
        for (const [method, url, body] of routes(h.id('oppA'), h.id(senior)).slice(1)) {
          const res = await h.call(method, url, 'hrA', body)
          expect([senior, method, res.status, res.json['code']]).toEqual([
            senior,
            method,
            404,
            NOT_FOUND,
          ])
        }
      }
      expect(h.runner.enqueue).not.toHaveBeenCalled()
    })

    it('a malformed senior id or opportunity id is the 404, never a 400 or a 500', async () => {
      for (const [method, url, body] of [
        ...routes(h.id('oppA'), 'not-a-uuid').slice(1),
        ...routes('not-a-uuid', h.id('senA')),
      ]) {
        const res = await h.call(method, url, 'hrA', body)
        expect([method, url, res.status, res.json['code']]).toEqual([method, url, 404, NOT_FOUND])
      }
    })

    it('ADMIN in the studio scope starts a run: 202 with the run id, enqueued once', async () => {
      const res = await h.call(
        'POST',
        `/${h.id('oppB')}/seniors/${h.id('senB')}/tailored`,
        'admin',
        { overwrite: false },
      )
      expect(res.status).toBe(202)
      const { rows } = await h.sql(
        `SELECT id, run_id, run_status FROM tailored_resumes
        WHERE job_opportunity_id = $1 AND senior_user_id = $2`,
        [h.id('oppB'), h.id('senB')],
      )
      expect(rows).toHaveLength(1)
      expect(res.json).toEqual({ runId: rows[0].run_id })
      expect(rows[0].run_status).toBe('QUEUED')
      expect(h.runner.enqueue.mock.calls).toEqual([[rows[0].id, rows[0].run_id]])
    })

    it('flag off: ADMIN gets the uniform 404 on every route, and nothing starts', async () => {
      h.enabled = false
      for (const [method, url, body] of routes(h.id('oppA'), h.id('senA'))) {
        const res = await h.call(method, url, 'admin', body)
        expect([method, url, res.status, res.json['code']]).toEqual([method, url, 404, NOT_FOUND])
      }
      expect(h.runner.enqueue).not.toHaveBeenCalled()
    })
  },
)
