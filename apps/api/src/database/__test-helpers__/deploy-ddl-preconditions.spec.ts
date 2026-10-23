import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  APPEND_ONLY_CHECK_SQL,
  APPEND_ONLY_TRIGGERS_DDL,
  DEPLOY_ROLES,
  GRANTS_DDL,
  ROLES_DDL,
  productionRetentionOwnerGrants,
} from './deploy-ddl-preconditions'

/**
 * The part of `deploy-ddl-preconditions.ts` that needs NO database: the paths it resolves
 * and the grant statements it parses out of the shipped grants file.
 *
 * WHY THIS FILE EXISTS (fix round 1 of PR #1095, finding FIX-2)
 * ------------------------------------------------------------
 * The mutation gate reported two SURVIVED mutants in that helper — `GRANTS_DDL`'s filename
 * mutated to `''` and the module-private role name mutated to `''` — and survived is not
 * no-coverage: a top-level constant is executed by every test that imports the module, so
 * the gate counted them covered while nothing asserted their values. Both must match
 * something real outside this repository's TypeScript: a file that exists on disk, and the
 * role name the generated grants file actually grants to. An assertion is therefore
 * available and is strictly better than a suppression, and it catches the drift this PR's
 * own CI failure was about — a renamed DDL file.
 *
 * Every path constant is pinned the same way, not just the one that survived: the two that
 * did are an accident of which tests import the module today, and the next import makes the
 * rest survivors too.
 *
 * `productionRetentionOwnerGrants()` is exercised here for the same reason, and it is a pure
 * read of a committed file — it needs no cluster, which is why this is a unit spec and not a
 * second integration one.
 */

describe('deploy DDL preconditions — the shipped file paths', () => {
  it.each([
    ['ROLES_DDL', ROLES_DDL, '2026-10-18_db_roles.sql'],
    [
      'APPEND_ONLY_TRIGGERS_DDL',
      APPEND_ONLY_TRIGGERS_DDL,
      '2026-10-18_job_queue_append_only_triggers.sql',
    ],
    ['APPEND_ONLY_CHECK_SQL', APPEND_ONLY_CHECK_SQL, '2026-10-18_job_queue_append_only_check.sql'],
    ['GRANTS_DDL', GRANTS_DDL, '2026-10-18_db_grants.sql'],
  ])('%s names %s and that file exists', (_label, resolved, expectedName) => {
    // The basename, not merely `existsSync`: a constant mutated to the directory itself
    // still exists on disk, so existence alone would not notice.
    expect(basename(resolved)).toBe(expectedName)
    expect({ path: resolved, exists: existsSync(resolved) }).toEqual({
      path: resolved,
      exists: true,
    })
    expect(resolved.endsWith(`/drizzle/manual/${expectedName}`)).toBe(true)
  })

  it('lists exactly the roles the roles DDL creates', () => {
    expect([...DEPLOY_ROLES]).toEqual(['crm_app', 'crm_collector', 'crm_retention_owner'])
    const rolesSql = readFileSync(ROLES_DDL, 'utf8')
    for (const role of DEPLOY_ROLES) {
      expect({ role, named: rolesSql.includes(role) }).toEqual({ role, named: true })
    }
  })
})

describe("productionRetentionOwnerGrants — the retention owner's shipped grant set", () => {
  it('returns the grants file statements that grant to crm_retention_owner, and only those', () => {
    const statements = productionRetentionOwnerGrants()

    // Non-empty is the first thing the helper itself refuses on; assert it here so the
    // role name the filter is built from is observed rather than assumed.
    expect(statements.length).toBeGreaterThan(0)
    for (const statement of statements) {
      expect(statement).toMatch(/^GRANT /)
      expect(statement).toMatch(/\bTO crm_retention_owner;?$/)
    }
  })

  it('refuses a file that grants that role nothing, instead of returning an empty set', () => {
    // The guard's failure path, watched firing. Until the file path became a parameter this
    // branch was unreachable and the mutation gate reported it SURVIVED: an empty result
    // would have left the role with no privileges and failed every dependent test somewhere
    // far away, for a reason nobody would look at here.
    const file = join(mkdtempSync(join(tmpdir(), 'grants-none-')), 'db_grants.sql')
    writeFileSync(file, 'GRANT SELECT ON TABLE public.t TO crm_app;\n')
    expect(() => productionRetentionOwnerGrants(file)).toThrow(
      /no GRANT \.\.\. TO crm_retention_owner found in/,
    )
  })

  it('does NOT mistake ALTER DEFAULT PRIVILEGES ... GRANT ... for a grant to that role', () => {
    // Why `^GRANT ` is anchored. This statement contains `GRANT ` and ends in the role name,
    // so an unanchored test matches it — and it is not a table grant at all: it sets a
    // DEFAULT privilege for objects created later, which `applyProductionRetentionOwnerGrants`
    // would then replay as though it were the role's grant set.
    const file = join(mkdtempSync(join(tmpdir(), 'grants-altdef-')), 'db_grants.sql')
    writeFileSync(
      file,
      [
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO crm_retention_owner;',
        'GRANT SELECT, DELETE ON TABLE public.job_queue_actions TO crm_retention_owner;',
      ].join('\n'),
    )
    // No trailing semicolon: `splitSqlStatements` strips the terminator, which is also why
    // the filter's `;?` is optional rather than required.
    expect(productionRetentionOwnerGrants(file)).toEqual([
      'GRANT SELECT, DELETE ON TABLE public.job_queue_actions TO crm_retention_owner',
    ])
  })

  it('covers every grant the shipped file makes to that role — no statement left behind', () => {
    // An independent count, taken from the file's own text rather than from the helper's
    // own filter, so the two cannot agree by construction.
    const fromFile = readFileSync(GRANTS_DDL, 'utf8')
      .split('\n')
      .filter((line) => /\bTO crm_retention_owner;\s*$/.test(line)).length

    expect(productionRetentionOwnerGrants().length).toBe(fromFile)
  })
})
