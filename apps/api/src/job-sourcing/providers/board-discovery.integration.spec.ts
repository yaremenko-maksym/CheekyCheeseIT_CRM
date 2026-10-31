import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertRealDbSchema, hasDatabaseUrl } from '../../test/require-real-db'
import { discoverBoardTokens, type Queryable } from './board-discovery'

/**
 * Board discovery against a REAL Postgres (ADR 8a, U8b). Seeds records with a URL of each of the six
 * shapes plus a non-matching one, and reads them back through the query. Run against a scratch
 * database only, after `db:push`:
 *
 *   DATABASE_URL=postgresql://crm_user:password@127.0.0.1:5432/crm_scratch_sfsu8b \
 *     pnpm --filter @crm/api exec vitest run board-discovery.integration
 *
 * The seed rows are tagged and deleted in `afterAll`. The discovery call itself must write nothing:
 * the table row counts are compared around it.
 */
const TAG = `u8b-${randomUUID().slice(0, 8)}`

let pool: Pool
const q = (text: string, params: unknown[] = []) => pool.query(text, params)

const COUNT_TABLES = [
  'job_source_records',
  'job_opportunities',
  'job_opportunity_sources',
  'job_opportunity_matches',
] as const
const counts = async () => {
  const out: Record<string, number> = {}
  for (const t of COUNT_TABLES) {
    out[t] = Number((await q(`SELECT count(*) AS n FROM ${t}`)).rows[0].n)
  }
  return out
}

let seq = 0
async function record(urls: {
  original?: string
  display?: string
  application?: string
}): Promise<string> {
  seq += 1
  const { rows } = await q(
    `INSERT INTO job_source_records
       (source_type, namespace, identity_kind, identity_key, original_url, display_url, application_url)
     VALUES ('GREENHOUSE_ATS', $1, 'NATIVE_ID', $2, $3, $4, $5) RETURNING id`,
    [
      `${TAG}-ns`,
      `${TAG}-k${seq}`,
      urls.original ?? null,
      urls.display ?? null,
      urls.application ?? null,
    ],
  )
  return rows[0].id as string
}

async function opportunity(recordIds: string[], matches: Array<'LEAD' | 'TRIAGE' | 'EXCLUDED'>) {
  seq += 1
  const { rows } = await q(
    `INSERT INTO job_opportunities (title, title_key) VALUES ($1, $1) RETURNING id`,
    [`${TAG} title ${seq}`],
  )
  const id = rows[0].id as string
  for (const r of recordIds) {
    await q(
      `INSERT INTO job_opportunity_sources (source_record_id, opportunity_id, rule_version)
       VALUES ($1, $2, 'u8b')`,
      [r, id],
    )
  }
  for (const outcome of matches) {
    seq += 1
    const user = await q(
      `INSERT INTO users (email, display_name) VALUES ($1, 'u8b') RETURNING id`,
      [`${TAG}-${seq}@example.test`],
    )
    await q(
      `INSERT INTO job_opportunity_matches
         (opportunity_id, senior_id, opportunity_revision, senior_profile_version,
          exclusion_version, rule_version, outcome)
       VALUES ($1, $2, 1, 'v', 'v', 'u8b', $3)`,
      [id, user.rows[0].id, outcome],
    )
  }
  return id
}

describe.skipIf(!hasDatabaseUrl())('board discovery (real Postgres)', () => {
  beforeAll(async () => {
    await assertRealDbSchema([
      { table: 'job_source_records', column: 'application_url' },
      { table: 'job_opportunity_sources', column: 'unlinked_at' },
    ])
    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
  })

  it('is connected to a database that is not the live one', async () => {
    const { rows } = await q('SELECT current_database() AS db, version() AS v')
    expect(rows[0].db).not.toBe('crm_db')
  })

  afterAll(async () => {
    await q(
      `DELETE FROM job_opportunity_matches WHERE opportunity_id IN
             (SELECT id FROM job_opportunities WHERE title LIKE $1)`,
      [`${TAG}%`],
    )
    await q(
      `DELETE FROM job_opportunity_sources WHERE source_record_id IN
             (SELECT id FROM job_source_records WHERE namespace = $1)`,
      [`${TAG}-ns`],
    )
    await q(`DELETE FROM job_opportunities WHERE title LIKE $1`, [`${TAG}%`])
    await q(`DELETE FROM job_source_records WHERE namespace = $1`, [`${TAG}-ns`])
    await q(`DELETE FROM users WHERE email LIKE $1`, [`${TAG}-%`])
    await pool.end()
  })

  it('returns the six tokens, not the seventh, drops a known one, counts distinct opportunities', async () => {
    const r1 = await record({ original: `https://boards.greenhouse.io/${TAG}-gh/jobs/1` })
    const r2 = await record({ display: `https://jobs.lever.co/${TAG}-lv/x` })
    const r3 = await record({ application: `https://jobs.ashbyhq.com/${TAG}-ab/x` })
    const r4 = await record({ original: `https://${TAG}-rc.recruitee.com/o/x` })
    const r5 = await record({ original: `https://${TAG}-pe.jobs.personio.de/job/1` })
    const r6 = await record({ original: `https://apply.workable.com/${TAG}-wk/j/1` })
    const r7 = await record({ original: `https://example.com/${TAG}-seventh` })
    // the same greenhouse board under a second record and URL variant, one opportunity
    const r1b = await record({
      display: `https://boards.greenhouse.io/${TAG.toUpperCase()}-GH/jobs/2`,
    })
    // a token a board file already lists
    const rk = await record({ original: `https://jobs.ashbyhq.com/linear/x` })
    await opportunity([r1, r1b], ['LEAD', 'EXCLUDED'])
    await opportunity([r2], ['TRIAGE', 'LEAD'])
    await opportunity([rk], ['LEAD'])
    void [r3, r4, r5, r6, r7]

    const before = await counts()
    const out = await discoverBoardTokens(pool as unknown as Queryable)
    const after = await counts()
    expect(after).toEqual(before)

    const mine = out.filter((o) => o.token.startsWith(TAG.toLowerCase()))
    expect(mine.map((o) => `${o.provider}:${o.token.slice(TAG.length + 1)}`).sort()).toEqual([
      'ashby:ab',
      'greenhouse:gh',
      'lever:lv',
      'personio:pe',
      'recruitee:rc',
      'workable:wk',
    ])
    expect(out.some((o) => o.token.includes('seventh'))).toBe(false)
    expect(out.some((o) => o.provider === 'ashby' && o.token === 'linear')).toBe(false)
    const by = (p: string) => mine.find((o) => o.provider === p)
    expect(by('greenhouse')).toMatchObject({ opportunities: 1, matches: 1 })
    expect(by('lever')).toMatchObject({ opportunities: 1, matches: 2 })
    expect(by('workable')).toMatchObject({ opportunities: 0, matches: 0 })
  })

  it('does not count an unlinked source link', async () => {
    const r = await record({ original: `https://jobs.lever.co/${TAG}-unlinked/x` })
    const o = await opportunity([r], ['LEAD'])
    await q(
      `UPDATE job_opportunity_sources SET unlinked_at = now(), unlink_reason = 'u8b' WHERE opportunity_id = $1`,
      [o],
    )
    const out = await discoverBoardTokens(pool as unknown as Queryable)
    expect(out.find((x) => x.token === `${TAG.toLowerCase()}-unlinked`)).toMatchObject({
      opportunities: 0,
      matches: 0,
    })
  })
})
