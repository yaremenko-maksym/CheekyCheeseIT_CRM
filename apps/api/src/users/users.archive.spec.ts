/**
 * Tests for the new archive / unarchive / archive-impact flows added by the
 * archive backend foundation. These exercise UsersService against an in-memory
 * fake of the Drizzle query/builder surface so we can assert pair-cascade and
 * audit log behaviour without spinning up Postgres.
 *
 * Spec: docs/specs/2026-05-21-users-archive-refactor-design.md §5 + §6.3
 */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import { UsersService } from './users.service'

// ---------------------------------------------------------------------------
// Drizzle fake — in-memory tables + a chainable query builder that supports the
// subset of operations the service uses. Each row is a plain object; the
// builder ignores actual SQL semantics — tests express assertions by reading
// the mutated arrays directly.
// ---------------------------------------------------------------------------

interface FakeStore {
  users: Array<Record<string, unknown>>
  teams: Array<Record<string, unknown>>
  teamMembers: Array<Record<string, unknown>>
  projects: Array<Record<string, unknown>>
  projectMembers: Array<Record<string, unknown>>
  userAuditLog: Array<Record<string, unknown>>
  teamAuditLog: Array<Record<string, unknown>>
  projectAuditLog: Array<Record<string, unknown>>
  // task-archive-pending-modal (AC2): getArchiveImpact now also reads
  // pending transactions for the warning list.
  transactions: Array<Record<string, unknown>>
}

function emptyStore(): FakeStore {
  return {
    users: [],
    teams: [],
    teamMembers: [],
    projects: [],
    projectMembers: [],
    userAuditLog: [],
    teamAuditLog: [],
    projectAuditLog: [],
    transactions: [],
  }
}

// Drizzle table objects expose `[Symbol.for('drizzle:Name')]` (and sometimes `_.name`).
// We don't have access to the real table symbols here, so we tag each call by
// the imported binding instead — tracked via WeakMap when the service passes
// in the table identifier as the first arg to db.select/from/update/insert.
//
// To keep the fake simple, we wire all table refs onto a Map keyed by tag, and
// have the chain reading them inspect a "lastTable" property set by `.from()`
// or `.update()` or `.insert()`. Since the service code imports concrete table
// objects from `../database/schema`, we re-export those and key the map by
// reference equality.

import {
  projectMembers as projectMembersTable,
  projects as projectsTable,
  teamMembers as teamMembersTable,
  teams as teamsTable,
  transactions as transactionsTable,
  users as usersTable,
} from '../database/schema'

function makeDb(store: FakeStore) {
  // ---- Query builder ----
  // We attempt to honour the WHERE filters by inspecting the SQL expression's
  // `queryChunks` (Drizzle's internal shape) — but that's brittle. Instead, we
  // remember the *last filter intent* via helper functions in the service
  // tests. To keep this manageable, we expose simple selectors directly.
  //
  // The simpler path: implement `select().from(t).where(...)` to return ALL rows
  // for that table, and force the calling service to filter in memory. This
  // breaks the service's reliance on SQL filtering — so we instead translate by
  // pattern-matching the imported binding `t` against our tables map.

  const tableMap = new Map<unknown, keyof FakeStore>([
    [usersTable, 'users'],
    [teamsTable, 'teams'],
    [teamMembersTable, 'teamMembers'],
    [projectsTable, 'projects'],
    [projectMembersTable, 'projectMembers'],
    [transactionsTable, 'transactions'],
  ])

  // Each Drizzle `where(...)` returns an expression that we don't introspect —
  // instead we register filter callbacks alongside chain calls by stashing the
  // last predicate on the chain object. The service is consistent: build the
  // chain, then call .then() — we walk the recorded state to evaluate.

  // To translate WHERE conditions into JS filters, we accept a parallel API on
  // the chain: the service uses helper functions `eq`, `and`, `isNull`, etc.
  // from drizzle-orm. We don't import those — we leave the predicates opaque
  // and instead require each service callsite to be "selecting all rows of
  // table". For exact matching we add hooks that recognise specific drizzle
  // expressions.

  // Drizzle's `eq(col, val)`, `and(...)`, `isNull(col)`, `ne(col, val)`,
  // `inArray(col, vals)` return value objects we can stringify to inspect
  // their column reference. Because of how they're constructed (via the column
  // accessor object), we can read `col.name` to identify the column.
  //
  // We rebuild the predicate machinery here:

  type Predicate = (row: Record<string, unknown>) => boolean

  function toPredicate(expr: unknown): Predicate {
    if (!expr) return () => true
    // Drizzle internal: `eq` returns a SQL object with `.queryChunks` describing the binary op.
    // To avoid SQL parsing, we use a lightweight shim: expressions created by
    // our own helper system would carry a `__predicate` function. Since we
    // don't control drizzle's helpers, we let the service compile but treat
    // expressions opaquely — returning a permissive predicate.
    if (typeof expr === 'object' && expr !== null && '__predicate' in expr) {
      return (expr as { __predicate: Predicate }).__predicate
    }
    return () => true
  }

  function selectChain(table: unknown, predicate?: unknown) {
    const tableKey = tableMap.get(table)
    return {
      from: (_t: unknown) => selectChain(_t ?? table, predicate),
      where: (expr: unknown) => {
        const pred = toPredicate(expr ?? predicate)
        // Return live references so updates inside the same tx still reflect.
        const rows = tableKey ? store[tableKey].filter(pred) : []
        const thenable = {
          then: (onF: (v: Array<Record<string, unknown>>) => unknown) => Promise.resolve(onF(rows)),
          orderBy: () => thenable,
          limit: () => thenable,
          offset: () => thenable,
          innerJoin: () => thenable,
        }
        return thenable as unknown as Promise<Array<Record<string, unknown>>>
      },
      innerJoin: () => selectChain(table, predicate),
    }
  }

  // We pre-stub queries by intercepting key code paths: each test sets up rows
  // and asserts post-conditions on the rows.

  let lastInsertTable: keyof FakeStore | null = null

  const buildUpdate = (table: unknown) => {
    const tableKey = tableMap.get(table) ?? null
    return {
      set: (values: Record<string, unknown>) => {
        return {
          where: (expr: unknown) => {
            const pred = toPredicate(expr)
            if (tableKey) {
              for (const row of store[tableKey]) {
                if (pred(row)) Object.assign(row, values)
              }
            }
            return Promise.resolve()
          },
          returning: () => {
            const rows = tableKey ? store[tableKey] : []
            return Promise.resolve(rows.map((r) => ({ ...r, ...values })))
          },
        }
      },
    }
  }

  const buildInsert = (table: unknown) => {
    lastInsertTable = tableMap.get(table) ?? null
    return {
      values: (vals: Record<string, unknown> | Array<Record<string, unknown>>) => {
        const arr = Array.isArray(vals) ? vals : [vals]
        const key = lastInsertTable
        if (key) {
          for (const v of arr) {
            store[key].push({
              id: `gen-${Math.random().toString(36).slice(2, 9)}`,
              createdAt: new Date(),
              ...v,
            })
          }
        }
        return {
          returning: () => Promise.resolve(arr),
        }
      },
    }
  }

  const buildDelete = (table: unknown) => {
    const key = tableMap.get(table)
    return {
      where: (_expr: unknown) => {
        if (key) store[key].length = 0
        return Promise.resolve()
      },
    }
  }

  // Provides query.<table>.findFirst({where, with}) by scanning the store.
  const queryHelpers = {
    users: {
      findFirst: (opts: { where?: unknown }) => {
        const pred = toPredicate(opts?.where)
        const found = store.users.find(pred)
        return Promise.resolve(found)
      },
      findMany: (opts?: { where?: unknown }) => {
        const pred = toPredicate(opts?.where)
        return Promise.resolve(store.users.filter(pred))
      },
    },
    teams: {
      findFirst: (opts: { where?: unknown }) => {
        const pred = toPredicate(opts?.where)
        return Promise.resolve(store.teams.find(pred))
      },
      findMany: (opts?: { where?: unknown }) =>
        Promise.resolve(store.teams.filter(toPredicate(opts?.where))),
    },
    teamMembers: {
      findFirst: (opts: { where?: unknown }) =>
        Promise.resolve(store.teamMembers.find(toPredicate(opts?.where))),
      findMany: (opts?: { where?: unknown }) =>
        Promise.resolve(store.teamMembers.filter(toPredicate(opts?.where))),
    },
    projects: {
      findFirst: (opts: { where?: unknown }) =>
        Promise.resolve(store.projects.find(toPredicate(opts?.where))),
      findMany: (opts?: { where?: unknown }) =>
        Promise.resolve(store.projects.filter(toPredicate(opts?.where))),
    },
    projectMembers: {
      findFirst: (opts: { where?: unknown }) =>
        Promise.resolve(store.projectMembers.find(toPredicate(opts?.where))),
      findMany: (opts?: { where?: unknown }) =>
        Promise.resolve(store.projectMembers.filter(toPredicate(opts?.where))),
    },
  }

  // Counters track WHICH handle (top-level db vs transaction tx) was used for
  // each mutation type. We use them to assert that all writes inside
  // db.transaction() flow through `tx` — i.e. they would roll back together
  // with the entity mutations. If a code path mistakenly uses `this.db.db`
  // for an audit-log insert inside a tx, the counters reveal the leak.
  const counters = {
    dbInsert: 0,
    dbUpdate: 0,
    dbDelete: 0,
    txInsert: 0,
    txUpdate: 0,
    txDelete: 0,
  }

  // ---- Two-stage transaction tracking ----
  // The fake's `tx` is a *separate* object from `db`. They share the same
  // backing `store` arrays (the row mutations are visible across both), but
  // calls on `tx` increment `tx*` counters and calls on `db` increment `db*`.
  // This catches bugs where code closes over `this.db.db` instead of `tx`.
  //
  // We also support "rollback" semantics: when the transaction body throws,
  // we restore the store snapshot taken at tx entry — so tests can assert
  // that audit log rows are rolled back together with entity changes.

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrapMutation = <F extends (...args: any[]) => any>(
    fn: F,
    kind: 'insert' | 'update' | 'delete',
    target: 'db' | 'tx',
  ): F => {
    return ((...args: Parameters<F>) => {
      counters[
        `${target}${kind.charAt(0).toUpperCase() + kind.slice(1)}` as keyof typeof counters
      ]++
      return fn(...args)
    }) as F
  }

  const makeHandle = (target: 'db' | 'tx') => ({
    select: (_proj?: unknown) => ({
      from: (table: unknown) => selectChain(table),
    }),
    insert: wrapMutation(buildInsert, 'insert', target),
    update: wrapMutation(buildUpdate, 'update', target),
    delete: wrapMutation(buildDelete, 'delete', target),
    query: queryHelpers,
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db: any = {
    ...makeHandle('db'),
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      // Capture a snapshot of every row's current shape (shallow clone keeps
      // Date instances intact). On rollback we restore the array contents
      // back to this snapshot, mutating row objects in place where they
      // existed before the tx started.
      const snapshot: Record<keyof FakeStore, Array<Record<string, unknown>>> = {
        users: store.users.map((r) => ({ ...r })),
        teams: store.teams.map((r) => ({ ...r })),
        teamMembers: store.teamMembers.map((r) => ({ ...r })),
        projects: store.projects.map((r) => ({ ...r })),
        projectMembers: store.projectMembers.map((r) => ({ ...r })),
        userAuditLog: store.userAuditLog.map((r) => ({ ...r })),
        teamAuditLog: store.teamAuditLog.map((r) => ({ ...r })),
        projectAuditLog: store.projectAuditLog.map((r) => ({ ...r })),
        transactions: store.transactions.map((r) => ({ ...r })),
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tx: any = makeHandle('tx')
      try {
        return await fn(tx)
      } catch (err) {
        for (const key of Object.keys(store) as Array<keyof FakeStore>) {
          ;(store[key] as Array<unknown>).length = 0
          for (const row of snapshot[key]) {
            ;(store[key] as Array<unknown>).push(row)
          }
        }
        throw err
      }
    },
  }

  return { db, counters }
}

// We need to inject a predicate marker into drizzle expressions so the in-memory
// store can filter rows correctly. We do this by **monkey-patching** the
// drizzle helpers we re-use in this test file. The simpler alternative is to
// shape store interactions so that all WHERE filters happen client-side by the
// tests asserting on the underlying mutation. Below we take the simpler path:
// each test snapshots the store rows after the operation and asserts the
// fields directly.

// ---------------------------------------------------------------------------
// Helper builders for store fixtures
// ---------------------------------------------------------------------------

function seedSeniorWithTeamAndProjects(store: FakeStore) {
  store.users.push(
    { id: 'senior-1', email: 's@x.com', displayName: 'Senior', role: 'SENIOR', archivedAt: null },
    { id: 'hr-1', email: 'h@x.com', displayName: 'HR', role: 'HR', archivedAt: null },
    { id: 'acc-1', email: 'a@x.com', displayName: 'Acc', role: 'ACCOUNTANT', archivedAt: null },
    { id: 'junior-1', email: 'j1@x.com', displayName: 'J1', role: 'JUNIOR', archivedAt: null },
    { id: 'junior-2', email: 'j2@x.com', displayName: 'J2', role: 'JUNIOR', archivedAt: null },
  )
  store.teams.push({ id: 'team-1', name: 'Команда Senior', archivedAt: null })
  store.teamMembers.push(
    { id: 'tm-1', teamId: 'team-1', userId: 'senior-1', leftAt: null, joinedAt: new Date() },
    { id: 'tm-2', teamId: 'team-1', userId: 'hr-1', leftAt: null, joinedAt: new Date() },
    { id: 'tm-3', teamId: 'team-1', userId: 'acc-1', leftAt: null, joinedAt: new Date() },
  )
  store.projects.push(
    { id: 'proj-1', name: 'P1', seniorId: 'senior-1', archivedAt: null },
    { id: 'proj-2', name: 'P2', seniorId: 'senior-1', archivedAt: null },
  )
  store.projectMembers.push(
    { id: 'pm-1', projectId: 'proj-1', userId: 'junior-1', leftAt: null, joinedAt: new Date() },
    { id: 'pm-2', projectId: 'proj-2', userId: 'junior-2', leftAt: null, joinedAt: new Date() },
  )
}

// ---------------------------------------------------------------------------
// Service construction with all 5 dependencies stubbed.
// ---------------------------------------------------------------------------

function buildService(store: FakeStore) {
  // The audit-log fakes record which handle (db.db vs tx) was passed in. A
  // record() call inside a `db.transaction()` block MUST receive `tx` so the
  // audit row is part of the same transaction. If a test ever observes
  // `txHandle === undefined` here for an in-transaction call, it means the
  // service forgot to thread `tx` and the audit row would leak past rollback.
  const usedTxFor: Record<string, Array<unknown>> = { user: [], team: [], project: [] }
  const auditLogService = {
    record: vi.fn(
      async (
        params: { actorId: string | null; targetId: string; action: string; changes: unknown },
        tx?: unknown,
      ) => {
        usedTxFor.user!.push(tx)
        store.userAuditLog.push({ ...params })
      },
    ),
  }
  const teamAuditLogService = {
    record: vi.fn(
      async (
        params: { actorId: string | null; targetId: string; action: string; changes: unknown },
        tx?: unknown,
      ) => {
        usedTxFor.team!.push(tx)
        store.teamAuditLog.push({ ...params })
      },
    ),
  }
  const projectAuditLogService = {
    record: vi.fn(
      async (
        params: { actorId: string | null; targetId: string; action: string; changes: unknown },
        tx?: unknown,
      ) => {
        usedTxFor.project!.push(tx)
        store.projectAuditLog.push({ ...params })
      },
    ),
  }
  const accessService = {} as never
  const { db, counters } = makeDb(store)
  // UsersService expects a DatabaseService-shaped object — i.e. one with a
  // `.db` field whose value is the actual Drizzle handle. Our `db` from
  // makeDb IS the handle, so we wrap it in { db } to match the service's
  // `this.db.db.*` access pattern.
  const tosService = { getLatestAcceptanceForUser: vi.fn().mockResolvedValue(null) } as never
  const service = new UsersService(
    { db } as never,
    accessService,
    auditLogService as never,
    tosService,
    teamAuditLogService as never,
    projectAuditLogService as never,
  )
  return {
    service,
    auditLogService,
    teamAuditLogService,
    projectAuditLogService,
    store,
    counters,
    usedTxFor,
    db,
  }
}

// The fake's select/update predicates are opaque so we have to substitute
// service implementations that work against the in-memory store. To keep the
// scope tight, we monkey-patch the small set of `tx.select(...).from(...).where(...)`
// calls used inside `archive` and `unarchive` by replacing the underlying
// methods on UsersService with thin wrappers that read/write the store
// directly. This keeps the test pure (no real DB) and meaningfully asserts
// the cascade contract.
//
// We achieve this by overriding service.findById to read from the store and
// rewriting `archive` / `unarchive` / `getArchiveImpact` to operate on
// the store. THIS IS NOT what we want — we want to test the real methods.
//
// SIMPLER APPROACH: We test through `archive` and `unarchive` directly using
// a richer db fake that interprets drizzle helpers. To do that we replace the
// drizzle helpers (`eq`, `and`, `isNull`, `ne`, `inArray`) at module level
// with shims that produce `__predicate` functions our fake recognises.
//
// Module mock is set up at the top of the test file via vi.mock.

// ---------------------------------------------------------------------------
// Mock drizzle-orm helpers so our `where` expressions carry a __predicate.
// ---------------------------------------------------------------------------

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>()
  const colName = (col: unknown): string => {
    // Drizzle column objects expose a `.name` via the pg-core PgColumn class.
    if (col && typeof col === 'object') {
      const c = col as { name?: string }
      if (typeof c.name === 'string') return c.name
    }
    return String(col)
  }
  const toJsKey = (sqlName: string): string => {
    // snake_case -> camelCase (matches Drizzle's column mapping from schema).
    return sqlName.replace(/_([a-z])/g, (_, l: string) => l.toUpperCase())
  }
  const resolveKey = (col: unknown): string => toJsKey(colName(col))
  return {
    ...actual,
    eq: (col: unknown, val: unknown) => ({
      __predicate: (row: Record<string, unknown>) => row[resolveKey(col)] === val,
    }),
    ne: (col: unknown, val: unknown) => ({
      __predicate: (row: Record<string, unknown>) => row[resolveKey(col)] !== val,
    }),
    isNull: (col: unknown) => ({
      __predicate: (row: Record<string, unknown>) => row[resolveKey(col)] == null,
    }),
    isNotNull: (col: unknown) => ({
      __predicate: (row: Record<string, unknown>) => row[resolveKey(col)] != null,
    }),
    inArray: (col: unknown, vals: unknown[]) => ({
      __predicate: (row: Record<string, unknown>) => vals.includes(row[resolveKey(col)]),
    }),
    and: (...exprs: Array<{ __predicate: (row: Record<string, unknown>) => boolean }>) => ({
      __predicate: (row: Record<string, unknown>) => exprs.every((e) => e.__predicate(row)),
    }),
    or: (...exprs: Array<{ __predicate: (row: Record<string, unknown>) => boolean }>) => ({
      __predicate: (row: Record<string, unknown>) => exprs.some((e) => e.__predicate(row)),
    }),
  }
})

// ---------------------------------------------------------------------------
// UsersService.archive — SENIOR pair cascade
// ---------------------------------------------------------------------------

describe('UsersService.archive — SENIOR (pair cascade)', () => {
  // task-archive-pending-modal (AC9, owner decision 2026-08-19): a SENIOR/DROP
  // cascade archive touches the TEAM and the PROJECTS — never the membership
  // of a third party sitting on them. HR/ACCOUNTANT/JUNIOR keep earning off
  // their own `archivedAt` (see the salary cron), so leaving `leftAt` alone
  // here is what keeps that true. Renamed from the pre-AC9 title, which
  // asserted the opposite.
  it('archives senior + team + projects; HR/Acc/Junior membership is left untouched', async () => {
    const store = emptyStore()
    seedSeniorWithTeamAndProjects(store)
    const { service } = buildService(store)

    await service.archive('senior-1', 'admin-x')

    expect(store.users.find((u) => u.id === 'senior-1')?.archivedAt).toBeInstanceOf(Date)
    expect(store.teams.find((t) => t.id === 'team-1')?.archivedAt).toBeInstanceOf(Date)
    expect(store.projects.find((p) => p.id === 'proj-1')?.archivedAt).toBeInstanceOf(Date)
    expect(store.projects.find((p) => p.id === 'proj-2')?.archivedAt).toBeInstanceOf(Date)

    // AC9: HR + ACCOUNTANT team_members stay active — archiving the team is
    // not archiving them.
    expect(store.teamMembers.find((m) => m.userId === 'hr-1')?.leftAt).toBeNull()
    expect(store.teamMembers.find((m) => m.userId === 'acc-1')?.leftAt).toBeNull()

    // SENIOR's own team_member row stays leftAt = NULL (unchanged by AC9).
    expect(store.teamMembers.find((m) => m.userId === 'senior-1')?.leftAt).toBeNull()

    // AC9: active JUNIORs on the now-archived projects stay attached — their
    // salary keeps accruing off their own `archivedAt`, not the project's.
    expect(store.projectMembers.find((m) => m.userId === 'junior-1')?.leftAt).toBeNull()
    expect(store.projectMembers.find((m) => m.userId === 'junior-2')?.leftAt).toBeNull()
  })

  it('writes audit log entries to user / team / project tables', async () => {
    const store = emptyStore()
    seedSeniorWithTeamAndProjects(store)
    const { service } = buildService(store)

    await service.archive('senior-1', 'admin-x')

    const userActions = store.userAuditLog.map((e) => e.action)
    const teamActions = store.teamAuditLog.map((e) => e.action)
    const projectActions = store.projectAuditLog.map((e) => e.action)

    expect(userActions).toContain('user_archived')
    expect(teamActions).toContain('team_archived')
    expect(projectActions.filter((a) => a === 'project_archived')).toHaveLength(2)
    // AC9: nobody is being removed from the team/projects any more — the
    // per-member 'team_member_removed'/'project_member_removed' entries this
    // cascade used to write are gone.
    expect(teamActions).not.toContain('team_member_removed')
    expect(projectActions).not.toContain('project_member_removed')
  })

  it('throws BadRequestException on double-archive (idempotency)', async () => {
    const store = emptyStore()
    seedSeniorWithTeamAndProjects(store)
    const { service } = buildService(store)
    await service.archive('senior-1', 'admin-x')
    await expect(service.archive('senior-1', 'admin-x')).rejects.toThrow(BadRequestException)
  })

  it('throws NotFoundException for missing user', async () => {
    const store = emptyStore()
    const { service } = buildService(store)
    await expect(service.archive('ghost', 'admin-x')).rejects.toThrow(NotFoundException)
  })

  it('threads tx through every audit-log call inside the transaction (atomicity)', async () => {
    // This test would have caught the original bug: previously the service
    // called `this.auditLogService.record(...)` without passing `tx`, so
    // audit rows would survive a transaction rollback. After the fix, every
    // record() call inside db.transaction() receives `tx` — the assertion
    // here asserts that all observed handles are defined (i.e. not undefined,
    // which would indicate the service used the top-level db connection).
    const store = emptyStore()
    seedSeniorWithTeamAndProjects(store)
    const { service, usedTxFor, counters } = buildService(store)

    await service.archive('senior-1', 'admin-x')

    // No audit-log handle should be undefined — every call ran inside a tx.
    expect(usedTxFor.user!.every((tx) => tx !== undefined)).toBe(true)
    expect(usedTxFor.team!.every((tx) => tx !== undefined)).toBe(true)
    expect(usedTxFor.project!.every((tx) => tx !== undefined)).toBe(true)

    // And the top-level db handle should NOT have been used for any mutation
    // inside the transaction (insert/update/delete). All went through tx.
    // (Audit log inserts are routed through the fake audit services which
    // are vi.fn mocks — so they don't show up in the fake-db counters; the
    // `usedTxFor` checks above cover those. Here we only verify entity
    // mutations — which only use tx.update — touched `tx`, not `db`.)
    expect(counters.dbInsert + counters.dbUpdate + counters.dbDelete).toBe(0)
    expect(counters.txUpdate).toBeGreaterThan(0)
  })

  it('rolls back audit log entries when the transaction throws', async () => {
    // Simulate an inner failure after some audit log writes — assert the
    // store is restored to pre-transaction state, including any audit rows.
    const store = emptyStore()
    seedSeniorWithTeamAndProjects(store)
    const { service, projectAuditLogService } = buildService(store)

    // Force a throw partway through the cascade by failing on the 2nd project.
    let callCount = 0
    projectAuditLogService.record.mockImplementation(async (_params, _tx) => {
      callCount++
      if (callCount === 2) throw new Error('Simulated DB failure during project audit log')
      store.projectAuditLog.push({ ..._params })
    })

    await expect(service.archive('senior-1', 'admin-x')).rejects.toThrow(/Simulated DB failure/)

    // Rollback assertions: the user, team, projects, and any audit log rows
    // written before the throw must be wiped (the snapshot is restored).
    expect(store.users.find((u) => u.id === 'senior-1')?.archivedAt).toBeNull()
    expect(store.teams.find((t) => t.id === 'team-1')?.archivedAt).toBeNull()
    expect(store.projects.find((p) => p.id === 'proj-1')?.archivedAt).toBeNull()
    // The successful first audit entry must also have rolled back.
    expect(store.projectAuditLog).toHaveLength(0)
    expect(store.teamAuditLog).toHaveLength(0)
    expect(store.userAuditLog).toHaveLength(0)
  })
})

describe('UsersService.archive — HR / ACCOUNTANT / JUNIOR / ADMIN', () => {
  it('HR: archives user + sets leftAt on team_members; no project_members touched', async () => {
    const store = emptyStore()
    store.users.push({ id: 'hr-1', role: 'HR', displayName: 'HR1', archivedAt: null })
    store.teamMembers.push(
      { id: 'tm-1', teamId: 'team-A', userId: 'hr-1', leftAt: null, joinedAt: new Date() },
      { id: 'tm-2', teamId: 'team-B', userId: 'hr-1', leftAt: null, joinedAt: new Date() },
    )
    const { service, teamAuditLogService } = buildService(store)
    await service.archive('hr-1', 'admin-x')

    expect(store.users[0]?.archivedAt).toBeInstanceOf(Date)
    expect(store.teamMembers[0]?.leftAt).toBeInstanceOf(Date)
    expect(store.teamMembers[1]?.leftAt).toBeInstanceOf(Date)
    expect(teamAuditLogService.record).toHaveBeenCalledTimes(2)
  })

  it('JUNIOR: archives user + sets leftAt on project_members', async () => {
    const store = emptyStore()
    store.users.push({ id: 'junior-1', role: 'JUNIOR', displayName: 'J', archivedAt: null })
    store.projectMembers.push({
      id: 'pm-1',
      projectId: 'proj-1',
      userId: 'junior-1',
      leftAt: null,
      joinedAt: new Date(),
    })
    const { service, projectAuditLogService } = buildService(store)
    await service.archive('junior-1', 'admin-x')

    expect(store.projectMembers[0]?.leftAt).toBeInstanceOf(Date)
    expect(projectAuditLogService.record).toHaveBeenCalled()
  })

  it('ADMIN: archives self (actorId === userId); no other side effects', async () => {
    // Self-archive is still allowed at the service layer (the controller
    // separately blocks self-archive for safety, but the service must not
    // reject it — otherwise re-entrant flows like account deletion break).
    const store = emptyStore()
    store.users.push({ id: 'admin-1', role: 'ADMIN', displayName: 'Adm', archivedAt: null })
    const { service, teamAuditLogService, projectAuditLogService } = buildService(store)
    await service.archive('admin-1', 'admin-1')

    expect(store.users[0]?.archivedAt).toBeInstanceOf(Date)
    expect(teamAuditLogService.record).not.toHaveBeenCalled()
    expect(projectAuditLogService.record).not.toHaveBeenCalled()
  })

  it('ADMIN: cannot archive another ADMIN — throws ForbiddenException (ut-2)', async () => {
    // Defense-in-depth: ADMINs are mutually indestructible. Even if the
    // controller-level self-check is bypassed (e.g. a different actor id),
    // the service must refuse to archive a target whose role is ADMIN.
    const store = emptyStore()
    store.users.push({
      id: 'admin-target',
      role: 'ADMIN',
      displayName: 'Target Admin',
      archivedAt: null,
    })
    const { service } = buildService(store)

    await expect(service.archive('admin-target', 'admin-actor')).rejects.toThrow(ForbiddenException)

    // Target row remains active — guard fires BEFORE any mutation.
    expect(store.users[0]?.archivedAt).toBeNull()
  })

  it('ADMIN: archive with null actorId (system) still permitted', async () => {
    // The guard only kicks in when an explicit actor differs from the target.
    // A null actor represents a system-initiated archive (e.g. a future
    // cleanup job) — we don't want to lock those out.
    const store = emptyStore()
    store.users.push({ id: 'admin-1', role: 'ADMIN', displayName: 'Adm', archivedAt: null })
    const { service } = buildService(store)
    await service.archive('admin-1', null)

    expect(store.users[0]?.archivedAt).toBeInstanceOf(Date)
  })
})

// ---------------------------------------------------------------------------
// UsersService.unarchive — SENIOR pair restore
// ---------------------------------------------------------------------------

describe('UsersService.unarchive — SENIOR (pair restore)', () => {
  // task-archive-pending-modal (AC9): HR/Acc membership was never closed by
  // archive() any more, so "NOT restored" is now simply "never touched" —
  // title + body updated to say so instead of the pre-AC9 claim.
  it('restores senior + team; leaves projects archived; HR/Acc/Junior membership was never touched', async () => {
    const store = emptyStore()
    seedSeniorWithTeamAndProjects(store)
    const { service } = buildService(store)

    // Archive first.
    await service.archive('senior-1', 'admin-x')

    // Sanity: pre-state.
    expect(store.users.find((u) => u.id === 'senior-1')?.archivedAt).toBeInstanceOf(Date)

    await service.unarchive('senior-1', 'admin-x')

    expect(store.users.find((u) => u.id === 'senior-1')?.archivedAt).toBeNull()
    expect(store.teams.find((t) => t.id === 'team-1')?.archivedAt).toBeNull()

    // Projects STAY archived.
    expect(store.projects.find((p) => p.id === 'proj-1')?.archivedAt).toBeInstanceOf(Date)
    expect(store.projects.find((p) => p.id === 'proj-2')?.archivedAt).toBeInstanceOf(Date)

    // AC9: HR/Acc memberships were never closed — still active before AND
    // after unarchive.
    expect(store.teamMembers.find((m) => m.userId === 'hr-1')?.leftAt).toBeNull()
    expect(store.teamMembers.find((m) => m.userId === 'acc-1')?.leftAt).toBeNull()

    // JUNIOR project memberships were never closed either.
    expect(store.projectMembers.find((m) => m.userId === 'junior-1')?.leftAt).toBeNull()
    expect(store.projectMembers.find((m) => m.userId === 'junior-2')?.leftAt).toBeNull()

    // SENIOR's row remains active.
    expect(store.teamMembers.find((m) => m.userId === 'senior-1')?.leftAt).toBeNull()
  })

  it('records user_unarchived + team_unarchived audit entries', async () => {
    const store = emptyStore()
    seedSeniorWithTeamAndProjects(store)
    const { service } = buildService(store)
    await service.archive('senior-1', 'admin-x')
    await service.unarchive('senior-1', 'admin-x')

    expect(store.userAuditLog.map((e) => e.action)).toContain('user_unarchived')
    expect(store.teamAuditLog.map((e) => e.action)).toContain('team_unarchived')
  })

  it('throws BadRequestException when user is not archived', async () => {
    const store = emptyStore()
    store.users.push({ id: 'u-1', role: 'JUNIOR', archivedAt: null })
    const { service } = buildService(store)
    await expect(service.unarchive('u-1', 'admin-x')).rejects.toThrow(BadRequestException)
  })
})

describe('UsersService.unarchive — HR / JUNIOR / ADMIN', () => {
  it('HR: restores user only; team_members stay closed', async () => {
    const store = emptyStore()
    store.users.push({ id: 'hr-1', role: 'HR', archivedAt: new Date() })
    store.teamMembers.push({
      id: 'tm-1',
      teamId: 't',
      userId: 'hr-1',
      leftAt: new Date(),
      joinedAt: new Date(),
    })
    const { service } = buildService(store)
    await service.unarchive('hr-1', 'admin-x')

    expect(store.users[0]?.archivedAt).toBeNull()
    // leftAt stays closed
    expect(store.teamMembers[0]?.leftAt).toBeInstanceOf(Date)
  })
})

// ---------------------------------------------------------------------------
// UsersService.getArchiveImpact
// ---------------------------------------------------------------------------

describe('UsersService.getArchiveImpact', () => {
  it('SENIOR: returns paired cascade counts + named projects', async () => {
    const store = emptyStore()
    seedSeniorWithTeamAndProjects(store)
    const { service } = buildService(store)
    const impact = await service.getArchiveImpact('senior-1')
    expect(impact).toMatchObject({
      type: 'user',
      role: 'SENIOR',
      isPaired: true,
      teamName: 'Команда Senior',
      projectsCount: 2,
      // task-archive-pending-modal (AC8): named list, not just a count.
      projectNames: ['P1', 'P2'],
      juniorsAffected: 2,
      hrAccountantsToBeRemoved: 2,
      pendingTransactions: [],
    })
  })

  // task-archive-pending-modal (AC2). Seeds a still-open SALARY reminder
  // addressed to the senior AND a PAID one (must be excluded — settled,
  // nothing "remains hanging") AND a SENIOR_INCOME PENDING (senior's own
  // unpaid-share income, the second category the owner named).
  it('SENIOR: surfaces PENDING salary + income rows, excludes PAID/other-receiver rows', async () => {
    const store = emptyStore()
    seedSeniorWithTeamAndProjects(store)
    store.transactions.push(
      {
        id: 'tx-salary-pending',
        type: 'SALARY',
        status: 'PENDING',
        receiverId: 'senior-1',
        salaryMonth: '2026-07',
        txDate: null,
        amount: '1500.00',
        currency: 'USD',
        deletedAt: null,
      },
      {
        id: 'tx-income-pending',
        type: 'SENIOR_INCOME',
        status: 'PENDING',
        receiverId: 'senior-1',
        salaryMonth: null,
        txDate: new Date('2026-07-15T00:00:00.000Z'),
        amount: '900.00',
        currency: 'USDT',
        deletedAt: null,
      },
      // Already settled — must NOT appear (nothing is "hanging").
      {
        id: 'tx-salary-paid',
        type: 'SALARY',
        status: 'PAID',
        receiverId: 'senior-1',
        salaryMonth: '2026-06',
        txDate: null,
        amount: '1500.00',
        currency: 'USD',
        deletedAt: null,
      },
      // Someone else's PENDING salary — must NOT appear.
      {
        id: 'tx-other-receiver',
        type: 'SALARY',
        status: 'PENDING',
        receiverId: 'hr-1',
        salaryMonth: '2026-07',
        txDate: null,
        amount: '1200.00',
        currency: 'USD',
        deletedAt: null,
      },
      // Soft-deleted PENDING salary — must NOT appear.
      {
        id: 'tx-deleted',
        type: 'SALARY',
        status: 'PENDING',
        receiverId: 'senior-1',
        salaryMonth: '2026-05',
        txDate: null,
        amount: '1500.00',
        currency: 'USD',
        deletedAt: new Date(),
      },
    )
    const { service } = buildService(store)

    const impact = await service.getArchiveImpact('senior-1')

    expect(impact.type).toBe('user')
    const pending =
      impact.type === 'user' && impact.role === 'SENIOR' ? impact.pendingTransactions : undefined
    expect(pending?.map((t) => t.id).sort()).toEqual(['tx-income-pending', 'tx-salary-pending'])
  })

  it('HR: returns teamsCount', async () => {
    const store = emptyStore()
    store.users.push({ id: 'hr-1', role: 'HR', archivedAt: null })
    store.teamMembers.push(
      { id: 'tm-1', teamId: 'team-A', userId: 'hr-1', leftAt: null },
      { id: 'tm-2', teamId: 'team-B', userId: 'hr-1', leftAt: null },
    )
    const { service } = buildService(store)
    const impact = await service.getArchiveImpact('hr-1')
    expect(impact).toMatchObject({
      type: 'user',
      role: 'HR',
      teamsCount: 2,
      pendingTransactions: [],
    })
  })

  it('JUNIOR: returns projectsCount', async () => {
    const store = emptyStore()
    store.users.push({ id: 'j-1', role: 'JUNIOR', archivedAt: null })
    store.projectMembers.push({ id: 'pm-1', projectId: 'proj-1', userId: 'j-1', leftAt: null })
    const { service } = buildService(store)
    const impact = await service.getArchiveImpact('j-1')
    expect(impact).toMatchObject({ type: 'user', role: 'JUNIOR', projectsCount: 1 })
  })

  it('ADMIN: returns noDependencies', async () => {
    const store = emptyStore()
    store.users.push({ id: 'adm', role: 'ADMIN', archivedAt: null })
    const { service } = buildService(store)
    const impact = await service.getArchiveImpact('adm')
    expect(impact).toMatchObject({ type: 'user', role: 'ADMIN', noDependencies: true })
  })
})
