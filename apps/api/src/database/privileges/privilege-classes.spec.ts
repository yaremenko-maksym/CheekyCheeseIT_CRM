/**
 * The privilege-class model, checked without a database.
 *
 * Why this spec exists
 * --------------------
 * `docs/architecture/2026-10-17-db-least-privilege-roles.md` §2 puts every table in
 * `public` into exactly ONE privilege class, and the class decides what `crm_app` and
 * `crm_collector` may do to it. The failure mode the whole design exists to prevent is a
 * table nobody classified — the shape of the finding on PR #1017, where an audit log or a
 * migration-internal table added later would be silently writable by the API.
 *
 * The ADR's catalog check (§2 item 1) catches that against a real database, in CI and on
 * every deploy. This spec catches it EARLIER and WITHOUT a database, which matters
 * because adding a table is a `schema/*.ts` edit and the unit suite is what runs on every
 * such edit. The relation list is derived from the Drizzle schema at runtime — never
 * hand-maintained — so a `pgTable(…)` added anywhere under `schema/` fails here until its
 * class is chosen.
 *
 * THIS SPEC IS NOW LOAD-BEARING FOR THE PRIVILEGE MODEL, NOT MERELY EARLIER
 * ------------------------------------------------------------------------
 * An unclassified table used to inherit `SELECT, INSERT, UPDATE, DELETE` from a default
 * privilege on TABLES. That default privilege is gone (fix round 1, SR-H-1: it covered
 * VIEWS too, and an auto-updatable view writes its base tables as the view owner, which
 * reopened every class whose point is a revoke). So an unclassified table is now
 * UNREACHABLE rather than over-granted — and the only reason removing the default
 * privilege cost nothing is the assertion below: a `pgTable` with no manifest entry fails
 * the unit suite, so a new table cannot reach a deploy without a class and a regenerated
 * grant. Weakening the derivation here would quietly restore the window that default
 * privilege existed to cover.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { getTableColumns, getTableName, getViewName, isTable, isView } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import * as schema from '../schema'
import {
  ALL_TABLE_PRIVILEGES,
  CLASS_PRIVILEGES,
  PRIVILEGE_CLASSES,
  MANUAL_DDL_RELATIONS,
  RETENTION_OWNER_CLASSES,
  RETENTION_OWNER_COLUMN_WRITE_GRANTS,
  RETENTION_OWNER_EVIDENCE_COLUMN_GRANT,
  RETENTION_OWNER_REDACTION_COLUMN_GRANT,
  RETENTION_OWNER_TABLE_PRIVILEGES,
  STAGED_RELATIONS,
  VIEW_CLASS,
  appendOnlyTriggers,
  collectorColumns,
  relationClass,
  retentionOwnerPrivilegesFor,
  type PrivilegeClass,
} from './privilege-classes'

const MANUAL_DIR = join(__dirname, '..', '..', '..', 'drizzle', 'manual')

/** Every manual DDL file in the repository, as `[name, body]`. */
function manualSqlFiles(): [string, string][] {
  return readdirSync(MANUAL_DIR)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => [f, readFileSync(join(MANUAL_DIR, f), 'utf8')])
}

/** Every table name the Drizzle schema declares, derived — not listed. */
function schemaTableNames(): string[] {
  return Object.values(schema)
    .filter((v) => isTable(v))
    .map((t) => getTableName(t))
    .sort()
}

/** Every view name the Drizzle schema declares, derived — not listed. */
function schemaViewNames(): string[] {
  return Object.values(schema)
    .filter((v) => isView(v))
    .map((v) => getViewName(v))
    .sort()
}

function columnsOf(relation: string): string[] {
  const found = Object.values(schema).find(
    (v) =>
      (isTable(v) && getTableName(v) === relation) || (isView(v) && getViewName(v) === relation),
  )
  if (!found) return []
  return Object.values(getTableColumns(found as never)).map((c) => (c as { name: string }).name)
}

describe('privilege-class manifest', () => {
  it('derives a non-trivial relation list from the Drizzle schema', () => {
    // Guards the derivation itself: if `isTable` ever stopped matching, every
    // coverage assertion below would pass vacuously on an empty list.
    expect(schemaTableNames().length).toBeGreaterThan(50)
    expect(schemaViewNames().length).toBeGreaterThan(0)
  })

  it('classifies every table the Drizzle schema declares', () => {
    const unclassified = schemaTableNames().filter((t) => relationClass(t) === undefined)
    expect(unclassified).toEqual([])
  })

  it('classifies every view the Drizzle schema declares, and only as a view class', () => {
    const views = schemaViewNames()
    expect(views.filter((v) => relationClass(v) === undefined)).toEqual([])
    expect(views.filter((v) => relationClass(v) !== VIEW_CLASS)).toEqual([])
  })

  it('puts each relation in exactly one class', () => {
    const seen = new Map<string, PrivilegeClass[]>()
    for (const [cls, relations] of Object.entries(PRIVILEGE_CLASSES)) {
      for (const relation of relations) {
        seen.set(relation, [...(seen.get(relation) ?? []), cls as PrivilegeClass])
      }
    }
    expect([...seen].filter(([, classes]) => classes.length > 1)).toEqual([])
  })

  it('names no relation that neither the Drizzle schema nor a manual DDL file creates', () => {
    // This is the assertion that catches a table renamed or dropped without updating the
    // manifest — the symmetric case the catalog check deliberately does not test against a
    // shared database (see the note in db-privileges.integration.spec.ts).
    const known = new Set([
      ...schemaTableNames(),
      ...schemaViewNames(),
      ...Object.keys(MANUAL_DDL_RELATIONS),
    ])
    const stale = Object.values(PRIVILEGE_CLASSES)
      .flat()
      .filter((r) => !known.has(r))
      .sort()
    expect(stale).toEqual([])
  })

  it('classifies every relation a manual DDL file leaves in public', () => {
    // These exist without being declared anywhere in `schema/`, so the derivation above
    // cannot see them; the catalog check found the first one and the rest came from reading
    // every CREATE TABLE in drizzle/manual. Each must still have a class.
    for (const relation of Object.keys(MANUAL_DDL_RELATIONS)) {
      expect({ relation, cls: relationClass(relation) }).toEqual({ relation, cls: 'E' })
    }
  })

  it('classifies salary_month_shift_backup — the backup production carries and no file creates', () => {
    // Measured against live production, read-only, 2026-10-18: `public` there holds 70
    // tables + 3 views, and this relation is one of them. It appears in no `CREATE TABLE`
    // anywhere in this repository — an operator took the backup by hand — so no scratch
    // database would ever have shown it and part 1 of the catalog check would have failed
    // on the FIRST production deploy, naming a table nobody had classified.
    //
    // Class E for the same reason as the `transactions` row backup beside it: a backup of
    // salary data is exactly the object the internet-facing role must not reach, and class
    // E is "the API gets nothing".
    expect(relationClass('salary_month_shift_backup')).toBe('E')
    // And OPTIONAL, through MANUAL_DDL_RELATIONS: it exists only on production, so
    // requiring it to be present would fail the check on every other database.
    expect(Object.keys(MANUAL_DDL_RELATIONS)).toContain('salary_month_shift_backup')
  })

  it('documents, for each manual-DDL relation, the file that creates it — or that none does', () => {
    const entries = Object.entries(MANUAL_DDL_RELATIONS)
    const handMade = entries.filter(([, e]) => e.file === null)
    const fromFile = entries.filter(([, e]) => e.file !== null) as [
      string,
      { file: string; why: string },
    ][]

    // `file: null` is a claim too, and a checkable one: nothing in the repository may
    // create a relation declared as made by hand.
    expect(
      handMade
        .filter(([relation]) =>
          manualSqlFiles().some(([, body]) =>
            new RegExp(`CREATE TABLE[^;]*\\b${relation}\\b`, 'i').test(body),
          ),
        )
        .map(([relation]) => relation),
    ).toEqual([])

    // And the other claim, equally checkable: a named file must EXIST and must actually
    // create the relation. A path written in a field is a claim nothing checked; this is
    // the same claim, checked.
    // `manual-staged/` holds a file written ahead of its DevOps wiring PR (the #1142 -> #1155 route).
    expect(fromFile.filter(([, e]) => !/^drizzle\/manual(-staged)?\//.test(e.file))).toEqual([])
    const pathOf = (file: string): string =>
      join(MANUAL_DIR, '..', file.replace(/^drizzle\//, '').split(' ')[0] as string)
    expect(fromFile.filter(([, e]) => !existsSync(pathOf(e.file))).map(([r]) => r)).toEqual([])
    expect(
      fromFile
        .filter(([relation, e]) => !readFileSync(pathOf(e.file), 'utf8').includes(relation))
        .map(([r]) => r),
    ).toEqual([])
    expect(entries.filter(([, e]) => e.why.length <= 20).map(([r]) => r)).toEqual([])
  })

  it('makes no claim about production presence, which nothing here can verify', () => {
    // The fourth recurrence on this feature of a comment asserting a guarantee the system
    // does not deliver: one entry said "Confirmed present in production" of a relation
    // production does not have (measured 2026-10-18). The mechanism never needed the
    // claim — every entry here is OPTIONAL, so presence is irrelevant to it — and no test
    // in this repository can check one. So the claim is not allowed to be made.
    for (const [relation, entry] of Object.entries(MANUAL_DDL_RELATIONS)) {
      expect({ relation, claimsProduction: /in production/i.test(entry.why) }).toEqual({
        relation,
        claimsProduction: false,
      })
    }
  })

  it('declares no manual-DDL relation that the Drizzle schema also declares', () => {
    // If one ever becomes a real schema table, it stops being optional and the entry must
    // go — otherwise the check would stop requiring it to exist.
    const declared = new Set([...schemaTableNames(), ...schemaViewNames()])
    expect(Object.keys(MANUAL_DDL_RELATIONS).filter((r) => declared.has(r))).toEqual([])
  })

  it('declares STAGED relations only for Drizzle tables whose staged file creates them (Task 4.5)', () => {
    // STAGED_RELATIONS is empty by design after the Task 4.6 S0 promotion, so this pass is
    // intended and runs vacuously. The staged mechanism is still covered by the `withStaged`
    // tests in generate-privilege-sql.spec.ts; do not delete it as dead code.
    // A staged entry makes the catalog check stop requiring the table and guards its grant,
    // so each one must be a real schema table, classified, and created by a file that is
    // still in manual-staged/: once the file moves to manual/, the entry must go with it.
    const tables = new Set(schemaTableNames())
    const entries = Object.entries(STAGED_RELATIONS)
    expect(entries.filter(([r]) => !tables.has(r)).map(([r]) => r)).toEqual([])
    expect(entries.filter(([r]) => relationClass(r) === undefined).map(([r]) => r)).toEqual([])
    expect(entries.filter(([, e]) => !e.file.startsWith('drizzle/manual-staged/'))).toEqual([])
    const pathOf = (file: string) => join(MANUAL_DIR, '..', file.replace(/^drizzle\//, ''))
    expect(
      entries
        .filter(
          ([r, e]) =>
            !existsSync(pathOf(e.file)) ||
            !new RegExp(`CREATE TABLE IF NOT EXISTS ${r}\\b`).test(
              readFileSync(pathOf(e.file), 'utf8'),
            ),
        )
        .map(([r]) => r),
    ).toEqual([])
    expect(entries.filter(([r]) => r in MANUAL_DDL_RELATIONS).map(([r]) => r)).toEqual([])
  })

  it('assigns no table to the view class', () => {
    const tables = new Set(schemaTableNames())
    expect(PRIVILEGE_CLASSES[VIEW_CLASS].filter((r) => tables.has(r))).toEqual([])
  })

  it('defines the privileges of every class it assigns relations to', () => {
    expect(Object.keys(CLASS_PRIVILEGES).sort()).toEqual(Object.keys(PRIVILEGE_CLASSES).sort())
  })

  it('enumerates exactly PostgreSQL 16’s seven table privileges', () => {
    // The catalog check asserts each of these present-or-absent for every relation and
    // role, so a privilege missing from this list is a privilege nothing ever checks —
    // `TRUNCATE` dropping out would stop anyone noticing it had been granted.
    expect([...ALL_TABLE_PRIVILEGES].sort()).toEqual([
      'DELETE',
      'INSERT',
      'REFERENCES',
      'SELECT',
      'TRIGGER',
      'TRUNCATE',
      'UPDATE',
    ])
  })

  it('gives class D no table-level privilege for the collector at all', () => {
    // This is class D's entire reason to exist: a table-level SELECT would silently cover
    // every column, including the credential and finance columns the collector must not
    // read. The columns are granted one by one through `collectorColumns`.
    expect(CLASS_PRIVILEGES.D.collector).toEqual([])
  })

  it('gives the retention owner exactly the table privileges its two functions measurably need', () => {
    // `[]` until Task 1.3b; `SELECT, DELETE` for the purge (four runs, recorded in the
    // manifest). NEITHER write privilege is held at table level: owner decisions 2 and 3 of
    // 2026-10-22 put the redaction's `UPDATE` and the evidence row's `INSERT` at COLUMN
    // level, each on a named list. A table-level entry for either would hand this role the
    // whole audit log and is what the next assertion exists to forbid.
    expect(RETENTION_OWNER_TABLE_PRIVILEGES).toEqual(['SELECT', 'DELETE'])
    expect(RETENTION_OWNER_TABLE_PRIVILEGES).not.toContain('UPDATE')
    expect(RETENTION_OWNER_TABLE_PRIVILEGES).not.toContain('INSERT')
  })

  it('declares exactly TWO non-SELECT column grants, both on the action log, both for the retention owner', () => {
    // Owner decisions 2 and 3, 2026-10-22. Asserted whole, so widening any field — another
    // column, another role, another table, another privilege — fails here before it reaches
    // a generated file or a database.
    expect(RETENTION_OWNER_COLUMN_WRITE_GRANTS).toEqual([
      {
        role: 'crm_retention_owner',
        relation: 'job_queue_actions',
        privilege: 'UPDATE',
        columns: ['reason'],
      },
      {
        role: 'crm_retention_owner',
        relation: 'job_queue_actions',
        privilege: 'INSERT',
        // Exactly the columns the function's INSERT names, and the order it names them in.
        // Each one was proven necessary by a revocation that produced 42501; `created_at`
        // and `id` were proven NOT necessary. See the manifest for the full run record.
        columns: [
          'kind',
          'subject_action_id',
          'actor_id',
          'scope_kind',
          'team_id',
          'idempotency_key',
        ],
      },
    ])
    // Exactly two, so a third exception cannot arrive unnoticed. The tuple TYPE already
    // rejects a third at compile time; this is the same statement at runtime, for the
    // reader who is not running tsc.
    expect(RETENTION_OWNER_COLUMN_WRITE_GRANTS).toHaveLength(2)
    for (const grant of RETENTION_OWNER_COLUMN_WRITE_GRANTS) {
      expect(PRIVILEGE_CLASSES.B).toContain(grant.relation)
    }
    // The named export the generator and the check both read stays the first entry, so a
    // reordering that silently swapped which privilege is "the redaction's" fails here.
    expect(RETENTION_OWNER_COLUMN_WRITE_GRANTS[0]).toBe(RETENTION_OWNER_REDACTION_COLUMN_GRANT)
    expect(RETENTION_OWNER_COLUMN_WRITE_GRANTS[1]).toBe(RETENTION_OWNER_EVIDENCE_COLUMN_GRANT)
  })

  it('confines the retention owner to class B, never to a class holding ordinary tables', () => {
    // The scoping is what keeps `SELECT, DELETE` off `users`, `transactions` and the six
    // audit logs. Asserted as a property rather than as the literal ['B'], so that adding
    // a class here is only possible if every relation in it is an append-only log.
    for (const cls of RETENTION_OWNER_CLASSES) {
      expect({ cls, app: CLASS_PRIVILEGES[cls].app }).toEqual({ cls, app: ['SELECT', 'INSERT'] })
    }
    // And off every other class entirely.
    for (const cls of Object.keys(CLASS_PRIVILEGES) as PrivilegeClass[]) {
      if (RETENTION_OWNER_CLASSES.includes(cls)) continue
      expect({ cls, granted: retentionOwnerPrivilegesFor(cls) }).toEqual({ cls, granted: [] })
    }
  })

  it('never grants TRUNCATE, REFERENCES or TRIGGER to either application role', () => {
    // ADR §2: "Never granted to crm_app or crm_collector, on any class".
    const forbidden = ['TRUNCATE', 'REFERENCES', 'TRIGGER']
    for (const [cls, privileges] of Object.entries(CLASS_PRIVILEGES)) {
      expect({ cls, app: privileges.app.filter((p) => forbidden.includes(p)) }).toEqual({
        cls,
        app: [],
      })
      expect({
        cls,
        collector: privileges.collector.filter((p) => forbidden.includes(p)),
      }).toEqual({ cls, collector: [] })
    }
  })

  it('grants the collector nothing outside classes C and D', () => {
    for (const [cls, privileges] of Object.entries(CLASS_PRIVILEGES)) {
      if (cls === 'C' || cls === 'D') continue
      expect({ cls, collector: privileges.collector }).toEqual({ cls, collector: [] })
    }
  })

  /**
   * The rule "a collector column list belongs to a class D table and names real columns",
   * as a function over an arbitrary declaration rather than a loop over the real one.
   *
   * CR-M-9: as a loop over `collectorColumns` this was a test that COULD NOT FAIL —
   * `collectorColumns` is empty until ADR §4 step 8, so the loop body never ran and the
   * rule inside it was never evaluated. A test that cannot fail is not a test; worse, this
   * one would have gone on passing when step 8 adds the first real entry and gets it
   * wrong. Extracted here so it can be fed a declaration that violates it.
   */
  function columnDeclarationViolations(declaration: Record<string, readonly string[]>): string[] {
    return Object.entries(declaration).flatMap(([table, columns]) => {
      const cls = relationClass(table)
      const unknown = columns.filter((c) => !columnsOf(table).includes(c))
      return [
        ...(cls === 'D' ? [] : [`${table}: class ${cls ?? 'none'}, expected D`]),
        ...unknown.map((c) => `${table}.${c}: not a column of that relation`),
      ]
    })
  }

  it('declares collector column lists only for class D tables, naming real columns', () => {
    expect(columnDeclarationViolations(collectorColumns)).toEqual([])
    // Empty today (ADR §4 step 8), so this assertion pins the manifest's current state and
    // the test below pins the RULE. Stated rather than left implicit, because "zero
    // violations of a rule nothing evaluated" is what CR-M-9 was.
    expect(Object.keys(collectorColumns)).toEqual([])
  })

  it('and the rule bites: a non-class-D table or an unknown column is a violation', () => {
    // `users` is class A, so a collector column list on it is the mistake class D exists
    // to prevent — a table-level read of a table holding credentials, dressed as a column
    // grant. `job_queue_actions` is class B, and `nonesuch` is no column of it.
    expect(columnDeclarationViolations({ users: ['id'], job_queue_actions: ['nonesuch'] })).toEqual(
      [
        'users: class A, expected D',
        'job_queue_actions: class B, expected D',
        'job_queue_actions.nonesuch: not a column of that relation',
      ],
    )
    // And an unclassified relation is named as such rather than crashing the rule.
    expect(columnDeclarationViolations({ no_such_table: ['id'] })).toEqual([
      'no_such_table: class none, expected D',
      'no_such_table.id: not a column of that relation',
    ])
  })

  it('declares append-only triggers only for class B tables', () => {
    for (const table of Object.keys(appendOnlyTriggers)) {
      expect({ table, cls: relationClass(table) }).toEqual({ table, cls: 'B' })
    }
    // Every class B table must declare its trigger set, even when empty: the catalog
    // check asserts the database matches the declaration exactly, so an undeclared
    // class B table would assert nothing. Task 1.3b fills these in.
    for (const table of PRIVILEGE_CLASSES.B) {
      expect({ table, declared: table in appendOnlyTriggers }).toEqual({ table, declared: true })
    }
  })
})
