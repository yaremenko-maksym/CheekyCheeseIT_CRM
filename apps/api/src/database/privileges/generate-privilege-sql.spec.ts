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
  CLASS_PRIVILEGES,
  PRIVILEGE_CLASSES,
  RETENTION_OWNER_TABLE_PRIVILEGES,
  ROLES,
  appendOnlyTriggers,
  collectorColumns,
  retentionOwnerFunctions,
} from './privilege-classes'

const MANUAL_DIR = join(__dirname, '..', '..', '..', 'drizzle', 'manual')
const read = (file: string): string => readFileSync(join(MANUAL_DIR, file), 'utf8')

/**
 * The manifest's relation list for one class, or a loud failure.
 *
 * These tests mutate the manifest through an index signature, and under
 * `noUncheckedIndexedAccess` every read of it is `string[] | undefined` — which the
 * `typecheck:specs` project reported and the gating `typecheck` does not (CR-M-10). A
 * non-null assertion would silence it; this answers it instead, because a class missing
 * from the manifest really is a defect and "cannot read properties of undefined" three
 * lines later is a worse way to learn it.
 */
function classList(classes: Record<string, string[]>, cls: string): string[] {
  const list = classes[cls]
  if (!list) throw new Error(`manifest has no class ${cls} — this spec is out of date`)
  return list
}

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

  it('sets no password but the two application roles’ — never the migration role’s own', () => {
    // The owner's decision, 2026-10-18, against ADR §4 step 7: rotating `crm_user` stays
    // an explicit, deliberate owner step and is NOT in this file. The reason is concrete
    // and not a preference — the deploy connects to the database AS `crm_user`, so a
    // rotation triggered by "a CI secret appears" means any divergence between the secret
    // and the stored password breaks EVERY subsequent deploy, recoverable only with
    // machine access to the host. A dormant mechanism that fails that way is worse than no
    // mechanism, because nothing exercises it until the day it locks the deploy out.
    const body = read(ROLES_FILE)
    const passwords = body.slice(body.indexOf('DO $passwords$'), body.indexOf('$passwords$;'))
    expect(passwords.length).toBeGreaterThan(200)
    // The loop's row set names the two application roles and nothing else: no
    // `current_user` row, and no GUC whose name is not one of the two.
    expect(passwords).not.toMatch(/current_user/i)
    expect([...passwords.matchAll(/crm_roles\.(\w+)/g)].map((m) => m[1]).sort()).toEqual([
      'app_verifier',
      'collector_verifier',
    ])
    // And nothing anywhere else in the file rotates it either.
    expect(body).not.toMatch(/owner_verifier/)
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

  it('grants the append-only table SELECT and INSERT to the API, and the purge pair to the retention owner', () => {
    const [appendOnly] = PRIVILEGE_CLASSES.B
    expect(appendOnly).toBeDefined()
    const grants = splitSqlStatements(read(GRANTS_FILE)).filter(
      (s) => /^\s*GRANT /.test(s) && s.includes(`public.${appendOnly}`),
    )
    // Two statements now, and the pair is the whole point of class B: the API may add
    // rows and never rewrite them, and the one role that may remove a row is the owner of
    // the R-B purge — which holds no INSERT, so it cannot forge the history it prunes.
    expect(grants).toHaveLength(2)
    expect(grants[0]).toMatch(/^GRANT SELECT, INSERT ON TABLE/)
    expect(grants[0]).toMatch(new RegExp(`TO ${ROLES.app}$`))
    expect(grants[1]).toMatch(/^GRANT SELECT, DELETE ON TABLE/)
    expect(grants[1]).toMatch(new RegExp(`TO ${ROLES.retentionOwner}$`))
  })

  it('grants a class E or collector-less class nothing at all', () => {
    const sql = read(GRANTS_FILE)
    // The collector has no login credential and no class C/D table yet, so no statement
    // may name it as a grantee. Fail-closed is the designed state, not an oversight.
    const grantsToCollector = splitSqlStatements(sql).filter(
      (s) => /^\s*GRANT /.test(s) && s.includes(`TO ${ROLES.collector}`),
    )
    expect(grantsToCollector).toEqual([])
    // The retention owner is granted on class B and NOWHERE else — asserted as "every
    // statement naming it names only class B relations", so a scoping regression that
    // handed it `users` or `transactions` fails here and not only in the catalog check.
    const retentionOwnerGrants = splitSqlStatements(sql).filter(
      (s) => /^\s*GRANT /.test(s) && s.includes(`TO ${ROLES.retentionOwner}`),
    )
    const relationsGranted = retentionOwnerGrants.flatMap((s) =>
      [...s.matchAll(/public\.(\w+)/g)].map((m) => m[1]),
    )
    expect(relationsGranted.sort()).toEqual([...PRIVILEGE_CLASSES.B].sort())
  })

  it('emits relations in sorted order whatever order the manifest lists them in', () => {
    // The file is regenerated on every manifest change and committed, so a non-deterministic
    // order would churn the diff and hide the real change inside it.
    const classes = PRIVILEGE_CLASSES as unknown as Record<string, string[]>
    const original = classList(classes, 'A-log')
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
    const original = classList(classes, 'A')
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

  it('grants the collector full DML and its sequences on class C tables', () => {
    withManifest(
      () => {
        // TWO tables, listed in the wrong order: with one, neither the separator between
        // them nor the sort that keeps the committed file stable is observable.
        classes.C = ['job_postings', 'job_collection_runs']
        classes.A = classList(classes, 'A').filter(
          (r) => r !== 'job_postings' && r !== 'job_collection_runs',
        )
      },
      () => {
        const sql = buildGrantsSql()
        expect(sql).toContain(
          'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE\n  public.job_collection_runs,\n  public.job_postings\n  TO crm_collector;',
        )
        // The collector gets USAGE on the sequences OF ITS CLASS C TABLES only, which is a
        // lookup through pg_depend rather than a name — so the emitted block names the
        // tables, not sequences, and the list separator has to be there.
        expect(sql).toContain("t.relname IN ('job_collection_runs', 'job_postings')")
        expect(sql).toContain('GRANT USAGE ON SEQUENCE public.%I')
      },
    )
  })

  it('grants class D tables their named columns and no table-level SELECT', () => {
    withManifest(
      () => {
        classes.D = ['users', 'team_members']
        classes.A = classList(classes, 'A').filter((r) => r !== 'users' && r !== 'team_members')
        columns['users'] = ['id', 'role']
        columns['team_members'] = ['team_id']
      },
      () => {
        const sql = buildGrantsSql()
        // Sorted and one statement each, so the committed file does not churn.
        expect(sql).toContain(
          'GRANT SELECT (team_id) ON TABLE public.team_members TO crm_collector;\n' +
            'GRANT SELECT (id, role) ON TABLE public.users TO crm_collector;\n',
        )
        const toCollector = splitSqlStatements(sql).filter((s) => s.includes('TO crm_collector'))
        // Exactly two statements, both column-level: a table-level SELECT anywhere here
        // would silently cover every column, which is what class D exists to prevent.
        expect(toCollector).toHaveLength(2)
        for (const statement of toCollector) {
          expect(statement).toMatch(/^GRANT SELECT \([a-z_, ]+\) ON TABLE/)
        }
        // The column block ends with a blank line before the sequences section: the file is
        // read by people during a deploy, and a section running into the next one is how a
        // statement gets attributed to the wrong block.
        expect(sql).toContain(
          'GRANT SELECT (id, role) ON TABLE public.users TO crm_collector;\n\n-- 4. Sequences.',
        )
        // And the check must expect exactly those pairs — a grant the check does not
        // assert is a grant that can vanish unnoticed.
        // The whole row set, in order: sorted by table, columns in declared order, joined
        // with UNION ALL. Asserting the pairs alone would accept them in any order and
        // would accept a missing separator, which is not a row set at all.
        // Keyed by ROLE as well as by relation and column (CR-M-3): the comparison joins
        // on the grantee, and a set that named only the columns is what let a column grant
        // to either of the other two roles pass part 3 unseen.
        expect(buildCheckSql()).toContain(
          "declared(role_name, relation, column_name) AS (    SELECT 'crm_collector', 'team_members', 'team_id'\n" +
            "    UNION ALL\n        SELECT 'crm_collector', 'users', 'id'\n" +
            "    UNION ALL\n        SELECT 'crm_collector', 'users', 'role'),",
        )
        // And the (role, class) pairs that carry a table-level SELECT, which is the other
        // half of the expected set: class D must NOT appear for the collector, or the
        // table-level expansion would make every column of a class D table "expected".
        expect(buildCheckSql()).toContain(
          "role_table_select(role_name, cls) AS (VALUES\n    ('crm_app', 'A'),",
        )
        expect(buildCheckSql()).not.toContain("('crm_collector', 'D')")
      },
    )
  })

  it('spells out an empty table-level SELECT set as an explicit empty row set', () => {
    // The CR-M-3 branch the mutation gate found unpinned: with no (role, class) pair
    // granting a table-level SELECT, part 3's `role_table_select` CTE has no rows, and
    // `VALUES` with nothing after it is not an empty row set but a SYNTAX ERROR — the
    // whole check file would fail to parse, on every deploy, for a manifest change that
    // looks harmless. The real manifest never takes this path (class A grants SELECT), so
    // only an injected manifest reaches it.
    const privileges = CLASS_PRIVILEGES as unknown as Record<
      string,
      { app: readonly string[]; collector: readonly string[]; why: string }
    >
    const original = Object.fromEntries(
      Object.entries(privileges).map(([cls, p]) => [cls, { ...p }]),
    )
    // The retention owner's table-level SELECT does not come from CLASS_PRIVILEGES, so it
    // has to be emptied through its own declaration or this branch stays unreachable.
    const retentionPrivileges = RETENTION_OWNER_TABLE_PRIVILEGES as unknown as string[]
    const originalRetention = [...retentionPrivileges]
    try {
      retentionPrivileges.length = 0
      for (const [cls, p] of Object.entries(privileges)) {
        privileges[cls] = {
          ...p,
          app: p.app.filter((x) => x !== 'SELECT'),
          collector: p.collector.filter((x) => x !== 'SELECT'),
        }
      }
      const check = buildCheckSql()
      expect(check).toContain(
        'role_table_select(role_name, cls) AS (SELECT NULL::text, NULL::text WHERE false)',
      )
      // The consequence, stated as its own assertion: never a VALUES with no rows.
      expect(check).not.toContain('role_table_select(role_name, cls) AS (VALUES\n)')
    } finally {
      for (const key of Object.keys(privileges)) delete privileges[key]
      Object.assign(privileges, original)
      retentionPrivileges.length = 0
      retentionPrivileges.push(...originalRetention)
    }
    expect(buildCheckSql()).toContain(
      "role_table_select(role_name, cls) AS (VALUES\n    ('crm_app'",
    )
  })

  it('spells out an empty class B and an empty trigger set as explicit empty row sets', () => {
    // These are the branches the real manifest takes today, and "no rows" has to be written
    // out: an empty VALUES list is a syntax error, and a dropped CTE would make the part
    // compare nothing while still reporting success.
    withManifest(
      () => {
        classes.B = []
        classes['A-log'] = [...classList(classes, 'A-log'), 'job_queue_actions']
        for (const key of Object.keys(triggers)) delete triggers[key]
      },
      () => {
        const check = buildCheckSql()
        expect(check).toContain('class_b(table_name) AS (SELECT NULL::text WHERE false)')
        expect(check).toContain(
          'WITH declared(table_name, trigger_name, enabled) AS (SELECT NULL::text, NULL::text, NULL::"char" WHERE false)',
        )
      },
    )
  })

  it('emits no grant of any kind for a class E table', () => {
    withManifest(
      () => {
        classes.E = ['transactions']
        classes.A = classList(classes, 'A').filter((r) => r !== 'transactions')
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
        classes['A-log'] = classList(classes, 'A-log').filter((r) => r !== 'user_audit_log')
        triggers['job_queue_actions'] = [
          { name: 'job_queue_actions_no_update', enabled: 'A' },
          { name: 'job_queue_actions_no_truncate', enabled: 'A' },
        ]
        triggers['user_audit_log'] = []
      },
      () => {
        const sql = buildCheckSql()
        // The whole VALUES block, prefix included: without `VALUES` the CTE is not a row
        // set at all, and asserting only the tuples would not notice.
        expect(sql).toContain(
          'WITH declared(table_name, trigger_name, enabled) AS (VALUES\n' +
            "    ('job_queue_actions', 'job_queue_actions_no_update', 'A'),\n" +
            "    ('job_queue_actions', 'job_queue_actions_no_truncate', 'A')),",
        )
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

  it('pins the declared retention-owner functions by name', () => {
    withManifest(
      () => {
        // Both of R-B's functions (ADR §3), so the separator between them is observable.
        // Replaces the real pair rather than appending to it, so the expected text below
        // stays a literal and does not drift with the manifest.
        functions.length = 0
        functions.push('job_queue_actions_purge_expired', 'job_queue_actions_redact_reason')
      },
      () => {
        const sql = buildCheckSql()
        expect(sql).toContain(
          "declared_functions(proname) AS (SELECT 'job_queue_actions_purge_expired'\n" +
            "    UNION ALL\n    SELECT 'job_queue_actions_redact_reason')",
        )
        expect(sql).toContain('declared function %s is not owned by')
      },
    )
  })

  it('spells out an empty retention-function set as an explicit empty row set', () => {
    // No longer the real manifest's state — Task 1.3b declared both R-B functions — but
    // the branch still has to be written out correctly, because it is what a database
    // with NO definer function is checked against: part 7 then requires the role to own
    // nothing, so a definer function appearing without review fails the deploy. An empty
    // `VALUES` would be a syntax error, which is why the empty row set is spelled out.
    withManifest(
      () => {
        functions.length = 0
      },
      () => {
        expect(buildCheckSql()).toContain(
          'declared_functions(proname) AS (SELECT NULL::text WHERE false)',
        )
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
