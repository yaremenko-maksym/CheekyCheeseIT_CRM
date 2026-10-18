/**
 * The privilege-class model, checked without a database.
 *
 * Why this spec exists
 * --------------------
 * `docs/architecture/2026-10-17-db-least-privilege-roles.md` §2 puts every table in
 * `public` into exactly ONE privilege class, and the class decides what `crm_app` and
 * `crm_collector` may do to it. The failure mode the whole design exists to prevent is a
 * table nobody classified: it inherits `SELECT, INSERT, UPDATE, DELETE` from the default
 * privileges, so an audit log or a migration-internal table added later is silently
 * writable by the API — the shape of the finding on PR #1017.
 *
 * The ADR's catalog check (§2 item 1) catches that against a real database, in CI and on
 * every deploy. This spec catches it EARLIER and WITHOUT a database, which matters
 * because adding a table is a `schema/*.ts` edit and the unit suite is what runs on every
 * such edit. The relation list is derived from the Drizzle schema at runtime — never
 * hand-maintained — so a `pgTable(…)` added anywhere under `schema/` fails here until its
 * class is chosen.
 */
import { getTableColumns, getTableName, getViewName, isTable, isView } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import * as schema from '../schema'
import {
  ALL_TABLE_PRIVILEGES,
  CLASS_PRIVILEGES,
  PRIVILEGE_CLASSES,
  MANUAL_DDL_RELATIONS,
  RETENTION_OWNER_TABLE_PRIVILEGES,
  VIEW_CLASS,
  appendOnlyTriggers,
  collectorColumns,
  relationClass,
  type PrivilegeClass,
} from './privilege-classes'

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

  it('documents, for each manual-DDL relation, which file creates it', () => {
    for (const [relation, entry] of Object.entries(MANUAL_DDL_RELATIONS)) {
      expect({ relation, file: entry.file.startsWith('drizzle/manual/') }).toEqual({
        relation,
        file: true,
      })
      expect(entry.why.length).toBeGreaterThan(20)
    }
  })

  it('declares no manual-DDL relation that the Drizzle schema also declares', () => {
    // If one ever becomes a real schema table, it stops being optional and the entry must
    // go — otherwise the check would stop requiring it to exist.
    const declared = new Set([...schemaTableNames(), ...schemaViewNames()])
    expect(Object.keys(MANUAL_DDL_RELATIONS).filter((r) => declared.has(r))).toEqual([])
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

  it('gives the retention owner no table privileges before Task 1.3b grants them', () => {
    // Empty by policy, not by accident: DELETE on an append-only log belongs to the R-B
    // functions, and arrives with them.
    expect(RETENTION_OWNER_TABLE_PRIVILEGES).toEqual([])
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

  it('declares collector column lists only for class D tables, naming real columns', () => {
    for (const [table, columns] of Object.entries(collectorColumns)) {
      expect({ table, cls: relationClass(table) }).toEqual({ table, cls: 'D' })
      expect({ table, unknown: columns.filter((c) => !columnsOf(table).includes(c)) }).toEqual({
        table,
        unknown: [],
      })
    }
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
