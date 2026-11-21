import { randomUUID } from 'node:crypto'
import type { JobSourceType } from '@crm/shared'
import { drizzle } from 'drizzle-orm/node-postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type CrmAppSession,
  openCrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import * as schema from '../../database/schema'
import {
  LedgerFixtures,
  LedgerKit,
  SpecCatalog,
  handleOf,
  specCheckpoint,
  specRegistry,
} from '../../test/ledger-fixtures'
import { type ObservationSeed, cleanupStore, observation } from '../../test/record-store-fixtures'
import { hasDatabaseUrl } from '../../test/require-real-db'
import { JobRunLedger } from '../ownership/job-run-ledger'
import type { RunHandle } from '../ownership/run-ownership'
import type { SalaryObservation } from '../normalize/salary'
import { resolveRecordsTx } from './canonical.store'
import { saveObservationPage } from './source-record.store'

/**
 * Sources-17 AC5 — the canonical salary columns against real Postgres, as `crm_app`: a create
 * writes the five columns, a changed salary rewrites them and advances `revision`, a removed one
 * nulls them. The CHECKs and the index are the DDL's (`drizzle/manual/2026-11-21_*_salary.sql`).
 */
const TAG = randomUUID().slice(0, 8)
const PREFIX = `t3spec-${TAG}`
const SOURCE: JobSourceType = 'REMOTIVE_API'

let session: CrmAppSession
let fx: LedgerFixtures
let kit: LedgerKit
let db: ReturnType<typeof drizzle<typeof schema>>
let run: RunHandle | undefined
let seq = 0

async function record(seed: Omit<ObservationSeed, 'tag' | 'namespace'>): Promise<string> {
  const o = observation({ namespace: `${PREFIX}-s`, ...seed, tag: TAG })
  run ??= handleOf(await kit.claimOne(await kit.reporting({ type: SOURCE })))
  seq += 1
  const [saved] = await saveObservationPage(db, run, {
    observations: [o],
    checkpoint: specCheckpoint(seq),
  })
  return saved?.recordId as string
}

async function resolve(recordId: string): Promise<string> {
  const [out] = await resolveRecordsTx(db, [recordId])
  return (out as { opportunityId: string }).opportunityId
}

async function salaryOf(id: string) {
  const { rows } = await session.admin.query(
    `SELECT revision, salary_min, salary_max, salary_currency, salary_period, salary_monthly_top,
            field_revisions->'salary' AS salary_revision
       FROM job_opportunities WHERE id = $1`,
    [id],
  )
  return rows[0] as {
    revision: number
    salary_min: string | null
    salary_max: string | null
    salary_currency: string | null
    salary_period: string | null
    salary_monthly_top: string | null
    salary_revision: unknown
  }
}

const EUR_MONTH: SalaryObservation = { min: 4000, max: 5500, currency: 'EUR', period: 'MONTH' }
const USD_YEAR: SalaryObservation = { min: 120000, max: null, currency: 'USD', period: 'YEAR' }
const NONE = {
  salary_min: null,
  salary_max: null,
  salary_currency: null,
  salary_period: null,
  salary_monthly_top: null,
}

describe.skipIf(!hasDatabaseUrl())('canonical salary columns (sources-17, real Postgres)', () => {
  beforeAll(async () => {
    session = await openCrmAppSession({ appPoolMax: 4 })
    const { rows } = await session.admin.query(`SELECT current_database() AS db`)
    if (rows[0].db === 'crm_db') throw new Error('refusing the live database')
    fx = new LedgerFixtures(session.admin, TAG)
    const catalog = new SpecCatalog()
    db = drizzle(session.pool, { schema })
    const ledger = new JobRunLedger(db, specRegistry([SOURCE]), catalog)
    const { rows: users } = await session.admin.query(
      `INSERT INTO users (email, display_name, role) VALUES ($1, 'S17 salary spec', 'ADMIN') RETURNING id`,
      [`s17-${TAG}@example.test`],
    )
    kit = new LedgerKit(ledger, fx, catalog, users[0].id as string)
  }, 120_000)

  afterAll(async () => {
    if (session === undefined) return
    try {
      await cleanupStore(session.admin, PREFIX, TAG)
      await fx.cleanup()
      await session.admin.query(`DELETE FROM users WHERE id = $1`, [kit.actor])
    } finally {
      await session.close()
    }
  })

  it('a create writes the five columns and the winning revision of the claim', async () => {
    const id = await resolve(await record({ nativeId: 'c1', salary: EUR_MONTH }))
    const row = await salaryOf(id)
    expect(row).toMatchObject({
      salary_min: '4000.00',
      salary_max: '5500.00',
      salary_currency: 'EUR',
      salary_period: 'MONTH',
      salary_monthly_top: '5500.00',
    })
    // A known claim records the winning revision id, as every other canonical field does.
    expect(typeof row.salary_revision).toBe('string')
  })

  it('a create without a salary leaves all five null', async () => {
    const id = await resolve(await record({ nativeId: 'c2' }))
    expect(await salaryOf(id)).toMatchObject(NONE)
  })

  it('a changed salary rewrites the columns and advances the revision; a removed one nulls them', async () => {
    const id = await resolve(await record({ nativeId: 'c3', salary: EUR_MONTH }))
    const first = await salaryOf(id)

    expect(await resolve(await record({ nativeId: 'c3', salary: USD_YEAR }))).toBe(id)
    const changed = await salaryOf(id)
    expect(changed).toMatchObject({
      salary_min: '120000.00',
      salary_max: null,
      salary_currency: 'USD',
      salary_period: 'YEAR',
      salary_monthly_top: '10000.00',
    })
    expect(changed.revision).toBeGreaterThan(first.revision)

    expect(await resolve(await record({ nativeId: 'c3' }))).toBe(id)
    const removed = await salaryOf(id)
    expect(removed).toMatchObject(NONE)
    expect(removed.revision).toBeGreaterThan(changed.revision)
  })

  it('back to an earlier salary (a content hash seen before) moves the columns back too', async () => {
    const id = await resolve(await record({ nativeId: 'c4' }))
    await resolve(await record({ nativeId: 'c4', salary: EUR_MONTH }))
    expect(await salaryOf(id)).toMatchObject({ salary_currency: 'EUR' })
    // The third observation hashes like the first: the store reuses that revision.
    expect(await resolve(await record({ nativeId: 'c4' }))).toBe(id)
    expect(await salaryOf(id)).toMatchObject(NONE)
  })

  it('the CHECK refuses a half-written salary', async () => {
    const id = await resolve(await record({ nativeId: 'c5' }))
    await expect(
      session.admin.query(`UPDATE job_opportunities SET salary_currency = 'EUR' WHERE id = $1`, [
        id,
      ]),
    ).rejects.toThrow(/ck_job_opportunities_salary_shape/)
  })

  it('the CHECK refuses a zero or negative bound, which the queue response would refuse', async () => {
    const id = await resolve(await record({ nativeId: 'c6', salary: EUR_MONTH }))
    for (const set of ['salary_min = 0', 'salary_max = -1']) {
      await expect(
        session.admin.query(`UPDATE job_opportunities SET ${set} WHERE id = $1`, [id]),
      ).rejects.toThrow(/ck_job_opportunities_salary_shape/)
    }
  })
})
