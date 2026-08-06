/**
 * task-domains-expansion — `vacancy_domain` is defined in THREE independent
 * places, and prod only ever sees one of them:
 *   1. `VACANCY_DOMAINS` (`@crm/shared`) — what the API accepts and what both
 *      UIs render labels for.
 *   2. `vacancyDomainEnum` (`schema.ts`) — what `drizzle-kit push` builds in
 *      dev/CI.
 *   3. `drizzle/manual/*.sql` — the hand-written DDL that migrates PROD
 *      (`2026-07-22_vacancies.sql` creates the type, the 2026-08-05 expansion
 *      appends to it); prod ships no drizzle-kit.
 *
 * Adding a domain to (1) and (2) while forgetting (3) does not fail anywhere
 * in dev or CI — it fails on prod, at the moment an admin first saves a
 * vacancy in the new domain, with `invalid input value for enum
 * vacancy_domain`. That is the same shape as the incident
 * `scripts/devops/check-prod-ddl-wiring.py` was written for (a DDL file that
 * merged but never ran); this spec covers the other half — a DDL file that
 * runs but no longer says what the code assumes.
 *
 * Both sides are DERIVED fresh on every run (the SQL is parsed, never
 * hand-copied into an expectation), so the test cannot pass by agreeing with
 * a stale copy of itself. Order is compared too, not just membership:
 * `ALTER TYPE … ADD VALUE` appends, so the TypeScript arrays are kept in the
 * physical enum order to keep `drizzle-kit push` a no-op on an already
 * migrated database.
 *
 * Pure unit spec — reads two files, opens no connection.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { VACANCY_DOMAINS } from '@crm/shared'

import { vacancyDomainEnum } from './schema'

const MANUAL_DIR = join(import.meta.dirname, '../../drizzle/manual')
const CREATE_FILE = join(MANUAL_DIR, '2026-07-22_vacancies.sql')
const EXPANSION_FILE = join(MANUAL_DIR, '2026-08-05_vacancy_domain_expansion.sql')

/** Values of the initial `CREATE TYPE vacancy_domain AS ENUM (…)`. */
function createdValues(): string[] {
  const sql = readFileSync(CREATE_FILE, 'utf-8')
  const match = /create\s+type\s+vacancy_domain\s+as\s+enum\s*\(([^)]*)\)/i.exec(sql)
  expect(match, `no CREATE TYPE vacancy_domain found in ${CREATE_FILE}`).not.toBeNull()
  return [...match![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!)
}

/**
 * Values appended by the expansion file, in statement order. Comment lines are
 * stripped first so a value merely *mentioned* in the header prose (e.g.
 * `domain: "FINTECH"` in the incident note) can never be mistaken for an
 * applied statement — the point is to read what psql will execute.
 */
function appendedValues(): string[] {
  const sql = readFileSync(EXPANSION_FILE, 'utf-8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
  return [...sql.matchAll(/alter\s+type\s+vacancy_domain\s+add\s+value\s+([^;]+);/gi)].map(
    (statement) => {
      const value = /'([^']+)'/.exec(statement[1]!)
      expect(value, `ADD VALUE statement without a quoted value: ${statement[0]}`).not.toBeNull()
      return value![1]!
    },
  )
}

describe('vacancy_domain — shared enum, Drizzle schema and prod DDL agree (task-domains-expansion)', () => {
  it('the prod DDL produces exactly the value list `@crm/shared` declares, in the same order', () => {
    expect([...createdValues(), ...appendedValues()]).toEqual([...VACANCY_DOMAINS])
  })

  it('the Drizzle pgEnum matches `@crm/shared` exactly (so `db:push` is a no-op after the DDL)', () => {
    expect([...vacancyDomainEnum.enumValues]).toEqual([...VACANCY_DOMAINS])
  })

  it('every ADD VALUE is idempotent — re-running the file on a migrated DB is a no-op', () => {
    // deploy.yml applies its DDL list on EVERY deploy, so a bare `ADD VALUE`
    // would abort the migration step (and the deploy) on the second run.
    const statements = readFileSync(EXPANSION_FILE, 'utf-8')
      .split('\n')
      .filter((line) => /alter\s+type/i.test(line) && !line.trimStart().startsWith('--'))
    expect(statements.length).toBeGreaterThan(0)
    const notGuarded = statements.filter((line) => !/add\s+value\s+if\s+not\s+exists/i.test(line))
    expect(notGuarded, 'every ALTER TYPE … ADD VALUE must carry IF NOT EXISTS').toEqual([])
  })

  it('the four original values keep their identity and position (live rows reference them)', () => {
    // Postgres cannot rename/remove a value in use; reordering the TS array
    // would also make `drizzle-kit push` see a phantom diff. Pinned literally.
    expect([...VACANCY_DOMAINS].slice(0, 4)).toEqual(['AI', 'EDTECH', 'ECOMMERCE', 'OTHER'])
  })

  it('declares no duplicate values', () => {
    expect(new Set(VACANCY_DOMAINS).size).toBe(VACANCY_DOMAINS.length)
  })
})
