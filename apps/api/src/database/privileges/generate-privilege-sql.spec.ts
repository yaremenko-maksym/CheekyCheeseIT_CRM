/**
 * The committed privilege SQL is what the generator produces — and is applicable as
 * production applies it.
 *
 * The first half is a drift test: `2026-10-18_db_grants.sql` and
 * `2026-10-18_db_privileges_check.sql` are generated from `privilege-classes.ts`, and a
 * hand edit to either (or a manifest change without regenerating) is precisely the state
 * in which the check asserts a stale expectation and passes. One byte of difference fails
 * here, with the command that fixes it.
 *
 * The second half is about the file being APPLICABLE the way `deploy.yml` applies it:
 * statement-level autocommit, no psql meta-commands. `splitSqlStatements` throws on a
 * backslash command, so running it over both files proves they can be verified — and
 * applied — by sending statements to the server, which is what the integration spec then
 * does with the same bytes.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { splitSqlStatements } from '../manual-sql-statements'
import {
  CHECK_FILE,
  GRANTS_FILE,
  ROLES_FILE,
  buildCheckSql,
  buildGrantsSql,
} from './generate-privilege-sql'
import {
  PRIVILEGE_CLASSES,
  RETENTION_OWNER_TABLE_PRIVILEGES,
  ROLES,
  appendOnlyTriggers,
  collectorColumns,
  retentionOwnerFunctions,
} from './privilege-classes'

const MANUAL_DIR = join(__dirname, '..', '..', '..', 'drizzle', 'manual')
const read = (file: string): string => readFileSync(join(MANUAL_DIR, file), 'utf8')

describe('generated privilege SQL', () => {
  it('matches the committed grants file', () => {
    expect(read(GRANTS_FILE)).toBe(buildGrantsSql())
  })

  it('matches the committed catalog-check file', () => {
    expect(read(CHECK_FILE)).toBe(buildCheckSql())
  })

  it('splits into statements the way psql does, with no meta-commands', () => {
    for (const file of [ROLES_FILE, GRANTS_FILE, CHECK_FILE]) {
      const statements = splitSqlStatements(read(file))
      expect({ file, statements: statements.length > 0 }).toEqual({ file, statements: true })
    }
  })

  it('wraps the grants in one explicit transaction', () => {
    // ADR §4: without the transaction every deploy re-grants UPDATE, DELETE on the
    // append-only log for the length of a few statements.
    // `splitSqlStatements` returns statements without their terminator, as psql sends them.
    const statements = splitSqlStatements(read(GRANTS_FILE)).map((s) => s.trim().toUpperCase())
    expect(statements.at(0)).toBe('BEGIN')
    expect(statements.at(-1)).toBe('COMMIT')
    expect(statements.filter((s) => s === 'BEGIN' || s === 'COMMIT')).toHaveLength(2)
  })

  it('revokes before it grants, so a hand-made grant on production does not survive', () => {
    const sql = read(GRANTS_FILE)
    const firstRevoke = sql.indexOf('REVOKE ALL PRIVILEGES ON ALL TABLES')
    const firstGrant = sql.indexOf('GRANT SELECT')
    expect(firstRevoke).toBeGreaterThan(-1)
    expect(firstGrant).toBeGreaterThan(firstRevoke)
  })

  it('never emits TRUNCATE, REFERENCES, TRIGGER or WITH GRANT OPTION in a GRANT', () => {
    const grants = splitSqlStatements(read(GRANTS_FILE)).filter((s) => /^\s*GRANT /.test(s))
    expect(grants.length).toBeGreaterThan(0)
    for (const statement of grants) {
      const subject = statement.slice(0, statement.indexOf(' ON '))
      expect({ statement: subject, bad: /TRUNCATE|REFERENCES|TRIGGER/.test(subject) }).toEqual({
        statement: subject,
        bad: false,
      })
      expect(/WITH GRANT OPTION/i.test(statement)).toBe(false)
    }
  })

  it('grants the append-only table SELECT and INSERT only', () => {
    const [appendOnly] = PRIVILEGE_CLASSES.B
    expect(appendOnly).toBeDefined()
    const grants = splitSqlStatements(read(GRANTS_FILE)).filter(
      (s) => /^\s*GRANT /.test(s) && s.includes(`public.${appendOnly}`),
    )
    expect(grants).toHaveLength(1)
    expect(grants[0]).toMatch(/^GRANT SELECT, INSERT ON TABLE/)
    expect(grants[0]).toMatch(new RegExp(`TO ${ROLES.app}$`))
  })

  it('grants a class E or collector-less class nothing at all', () => {
    const sql = read(GRANTS_FILE)
    // The collector has no login credential and no class C/D table yet, so no statement
    // may name it as a grantee. Fail-closed is the designed state, not an oversight.
    const grantsToCollector = splitSqlStatements(sql).filter(
      (s) => /^\s*GRANT /.test(s) && s.includes(`TO ${ROLES.collector}`),
    )
    expect(grantsToCollector).toEqual([])
    const grantsToRetentionOwner = splitSqlStatements(sql).filter(
      (s) => /^\s*GRANT /.test(s) && s.includes(`TO ${ROLES.retentionOwner}`),
    )
    expect(grantsToRetentionOwner).toEqual([])
  })

  it('emits relations in sorted order whatever order the manifest lists them in', () => {
    // The file is regenerated on every manifest change and committed, so a non-deterministic
    // order would churn the diff and hide the real change inside it.
    const classes = PRIVILEGE_CLASSES as unknown as Record<string, string[]>
    const original = classes['A-log']
    try {
      classes['A-log'] = [...original].reverse()
      const grants = splitSqlStatements(buildGrantsSql()).find(
        (s) => /^GRANT SELECT, INSERT ON TABLE/.test(s) && s.includes('user_audit_log'),
      )
      const relations = [...(grants ?? '').matchAll(/public\.([a-z_0-9]+)/g)].map((m) => m[1])
      expect(relations).toEqual([...relations].sort())
      expect(relations.length).toBeGreaterThan(1)
    } finally {
      classes['A-log'] = original
    }
  })

  it('refuses a manifest entry that is not a plain identifier', () => {
    // The generator validates rather than escapes: a name needing quotes is a manifest
    // bug, and rendering it safely would hide it.
    const classes = PRIVILEGE_CLASSES as unknown as Record<string, string[]>
    const original = classes.A
    try {
      classes.A = [...original, 'users; DROP TABLE users']
      expect(() => buildGrantsSql()).toThrow(/not a plain lower-case identifier/)
    } finally {
      classes.A = original
    }
  })

  it('refuses a manifest with no grants at all', () => {
    const classes = PRIVILEGE_CLASSES as unknown as Record<string, string[]>
    const original = { ...classes }
    try {
      for (const cls of Object.keys(classes)) classes[cls] = []
      expect(() => buildGrantsSql()).toThrow(/no grants emitted/)
    } finally {
      for (const [cls, relations] of Object.entries(original)) classes[cls] = relations
    }
  })
})

/**
 * The emission paths for the classes that have no members YET.
 *
 * Classes C, D and E are empty today by decision (ADR §4 step 8 for the collector's grants;
 * the migration ledger does not exist), and `appendOnlyTriggers` is empty until Task 1.3b.
 * Shipping that machinery unexercised is exactly the defect the ADR complains about — "a
 * guarantee documented ahead of the mechanism that delivers it" — and the mutation gate
 * says the same thing mechanically: every branch below had a surviving mutant, because the
 * only path the real manifest takes is the empty one.
 *
 * So each test populates the manifest temporarily and asserts the SQL that comes out. The
 * expected statements are written out literally, not derived from the manifest.
 */
describe('privilege SQL for classes with no members yet', () => {
  const classes = PRIVILEGE_CLASSES as unknown as Record<string, string[]>
  const columns = collectorColumns as Record<string, readonly string[]>
  const triggers = appendOnlyTriggers as Record<string, readonly { name: string; enabled: 'A' }[]>
  const functions = retentionOwnerFunctions as unknown as string[]

  function withManifest(mutate: () => void, assert: () => void): void {
    const originalClasses = { ...classes }
    const originalColumns = { ...columns }
    const originalTriggers = { ...triggers }
    const originalFunctions = [...functions]
    try {
      mutate()
      assert()
    } finally {
      for (const key of Object.keys(classes)) delete classes[key]
      Object.assign(classes, originalClasses)
      for (const key of Object.keys(columns)) delete columns[key]
      Object.assign(columns, originalColumns)
      for (const key of Object.keys(triggers)) delete triggers[key]
      Object.assign(triggers, originalTriggers)
      functions.length = 0
      functions.push(...originalFunctions)
    }
  }

  it('grants the collector full DML and its sequence on a class C table', () => {
    withManifest(
      () => {
        classes.C = ['job_postings']
        classes.A = classes.A.filter((r) => r !== 'job_postings')
      },
      () => {
        const sql = buildGrantsSql()
        expect(sql).toContain(
          'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE\n  public.job_postings\n  TO crm_collector;',
        )
        // The collector gets USAGE on the sequences OF ITS CLASS C TABLES only, which is a
        // lookup through pg_depend rather than a name — so the emitted block must name the
        // table, not a sequence.
        expect(sql).toContain("t.relname IN ('job_postings')")
        expect(sql).toContain('GRANT USAGE ON SEQUENCE public.%I')
      },
    )
  })

  it('grants a class D table its named columns and no table-level SELECT', () => {
    withManifest(
      () => {
        classes.D = ['users']
        classes.A = classes.A.filter((r) => r !== 'users')
        columns['users'] = ['id', 'role']
      },
      () => {
        const sql = buildGrantsSql()
        expect(sql).toContain('GRANT SELECT (id, role) ON TABLE public.users TO crm_collector;')
        const toCollector = splitSqlStatements(sql).filter((s) => s.includes('TO crm_collector'))
        // Exactly one statement, and it is the column-level one: a table-level SELECT
        // anywhere here would defeat the class.
        expect(toCollector).toHaveLength(1)
        expect(toCollector[0]).toMatch(/^GRANT SELECT \(id, role\)/)
      },
    )
  })

  it('emits no grant of any kind for a class E table', () => {
    withManifest(
      () => {
        classes.E = ['transactions']
        classes.A = classes.A.filter((r) => r !== 'transactions')
      },
      () => {
        const grants = splitSqlStatements(buildGrantsSql()).filter(
          (s) => /^GRANT /.test(s) && s.includes('public.transactions'),
        )
        expect(grants).toEqual([])
      },
    )
  })

  it('pins each declared append-only trigger with its enabled state', () => {
    withManifest(
      () => {
        classes.B = ['job_queue_actions', 'user_audit_log']
        classes['A-log'] = classes['A-log'].filter((r) => r !== 'user_audit_log')
        triggers['job_queue_actions'] = [
          { name: 'job_queue_actions_no_update', enabled: 'A' },
          { name: 'job_queue_actions_no_truncate', enabled: 'A' },
        ]
        triggers['user_audit_log'] = []
      },
      () => {
        const sql = buildCheckSql()
        expect(sql).toContain("('job_queue_actions', 'job_queue_actions_no_update', 'A')")
        expect(sql).toContain("('job_queue_actions', 'job_queue_actions_no_truncate', 'A')")
        // Two class B tables, so the separator between them is observable — with one table
        // a broken join looks identical.
        const classB = /class_b\(table_name\) AS \(([\s\S]*?)\),\n/.exec(sql)?.[1]
        expect(classB).toBe(
          "SELECT 'job_queue_actions'\n    UNION ALL\n    SELECT 'user_audit_log'",
        )
      },
    )
  })

  it('doubles a quote inside a declared name instead of emitting it raw', () => {
    // Trigger names are the one manifest value not forced through the identifier check, so
    // they are where the SQL-literal escaping is observable. A raw apostrophe would end the
    // literal and leave the file unparseable.
    withManifest(
      () => {
        triggers['job_queue_actions'] = [{ name: "it's_a_trigger", enabled: 'A' }]
      },
      () => {
        expect(buildCheckSql()).toContain("'it''s_a_trigger'")
      },
    )
  })

  it('pins a declared retention-owner function by name', () => {
    withManifest(
      () => {
        functions.push('job_queue_actions_purge_expired')
      },
      () => {
        const sql = buildCheckSql()
        expect(sql).toContain("SELECT 'job_queue_actions_purge_expired'")
        expect(sql).toContain('declared function %s is not owned by')
      },
    )
  })

  it('expects the retention owner to hold whatever privileges the manifest declares', () => {
    // Task 1.3b sets RETENTION_OWNER_TABLE_PRIVILEGES to what its functions need; this
    // proves the check will then expect them rather than silently keep asserting "none".
    const declared = RETENTION_OWNER_TABLE_PRIVILEGES as unknown as string[]
    try {
      declared.push('DELETE')
      expect(buildCheckSql()).toContain("('B', 'crm_retention_owner', 'DELETE', true)")
    } finally {
      declared.length = 0
    }
  })
})
