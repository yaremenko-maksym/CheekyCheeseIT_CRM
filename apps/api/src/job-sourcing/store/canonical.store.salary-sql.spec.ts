import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import type { MeterDb } from '../metering/account-meter.store'
import { resolveRecordsTx } from './canonical.store'

/**
 * sources-17: the five salary columns as `resolveRecords` writes them, on a fake `db` that routes
 * each statement by its text. The real round-trip is `./canonical.store.salary.integration.spec.ts`;
 * this spec is what the mutation gate can execute (it never loads an integration spec).
 */
const REC = '11111111-1111-4111-8111-111111111111'
const OPP = '22222222-2222-4222-8222-222222222222'
const salary = { min: 4000, max: 5500, currency: 'EUR', period: 'MONTH' }
const snapRow = {
  record_id: REC,
  revision_id: '33333333-3333-4333-8333-333333333333',
  received_seq: 1,
  received_at: '2026-11-21T00:00:00.000Z',
  source_type: 'LEVER',
  namespace: 'acme',
  source_url: null,
  application_url: null,
  description_sha256: null,
  original_identity: {},
  normalized: { title: 'Senior Backend Engineer', companyName: 'Acme', tags: ['go'], salary },
}

const dialect = new PgDialect()

function routedDb(linked: boolean) {
  const queries: { sql: string; params: unknown[] }[] = []
  const rowsFor = (text: string): Record<string, unknown>[] => {
    if (/FROM job_source_records r JOIN/.test(text)) return [snapRow]
    if (/FROM job_opportunity_sources\s+WHERE source_record_id IN/.test(text))
      return linked
        ? [{ id: 'link-1', source_record_id: REC, opportunity_id: OPP, decision: 'AUTO' }]
        : []
    if (/FROM job_opportunity_sources s\s+JOIN/.test(text)) return [snapRow]
    if (/^INSERT INTO job_opportunities\s/.test(text)) return [{ id: OPP, revision: 1 }]
    return []
  }
  const db = {
    async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return fn({
        async execute(query: SQL) {
          const q = dialect.sqlToQuery(query)
          queries.push(q)
          return { rows: rowsFor(q.sql.trim()) }
        },
      })
    },
  }
  return { db: db as unknown as MeterDb, queries }
}

/** The five salary values of one statement, in column order, by their `$n` placeholders. */
const salaryParams = (q: { sql: string; params: unknown[] }, re: RegExp) => {
  const m = re.exec(q.sql)
  expect(m, q.sql).not.toBeNull()
  return m!.slice(1).map((n) => q.params[Number(n) - 1])
}
const TUPLE =
  /\$(\d+)::numeric\(12,2\), \$(\d+)::numeric\(12,2\), \$(\d+)::text, \$(\d+)::text, \$(\d+)::numeric\(12,2\)\)/
const EXPECTED = [4000, 5500, 'EUR', 'MONTH', 5500]

describe('resolveRecords writes the salary columns (sources-17)', () => {
  it('NEW: the INSERT names the five columns and carries the five typed values in order', async () => {
    const { db, queries } = routedDb(false)
    expect(await resolveRecordsTx(db, [REC])).toEqual([
      { recordId: REC, kind: 'NEW', opportunityId: OPP },
    ])
    const insert = queries.find((q) => /^INSERT INTO job_opportunities\s/.test(q.sql.trim()))!
    expect(insert.sql).toMatch(
      /role_classifier_version,\s+salary_min, salary_max, salary_currency, salary_period, salary_monthly_top\)\s+VALUES/,
    )
    expect(salaryParams(insert, new RegExp(TUPLE.source + '\\s+RETURNING'))).toEqual(EXPECTED)
  })

  it('KEEP: the refresh sets each column and compares the same typed tuple', async () => {
    const { db, queries } = routedDb(true)
    expect((await resolveRecordsTx(db, [REC]))[0]).toMatchObject({
      kind: 'KEEP',
      opportunityId: OPP,
    })
    const update = queries.find((q) =>
      /^UPDATE job_opportunities\s+SET\s+title = /.test(q.sql.trim()),
    )!
    const set =
      /salary_min = \$(\d+)::numeric\(12,2\), salary_max = \$(\d+)::numeric\(12,2\), salary_currency = \$(\d+)::text, salary_period = \$(\d+)::text, salary_monthly_top = \$(\d+)::numeric\(12,2\),\s+revision = revision \+ 1/
    expect(salaryParams(update, set)).toEqual(EXPECTED)
    expect(update.sql).toMatch(
      /salary_min, salary_max,\s+salary_currency, salary_period, salary_monthly_top\) IS DISTINCT FROM/,
    )
    expect(salaryParams(update, TUPLE)).toEqual(EXPECTED)
  })
})
