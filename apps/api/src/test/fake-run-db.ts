/**
 * A recording double of the Drizzle query builder for the verification run's unit specs (Task 14).
 * Every awaited query is logged with its `set` values, its compiled `where` and whether it took a
 * row lock, and resolves to the next scripted result. The real SQL is pinned by the integration spec.
 */
import { PgDialect } from 'drizzle-orm/pg-core'
import { is, SQL } from 'drizzle-orm'

export type LoggedQuery = {
  op: 'update' | 'select' | 'insert'
  set?: Record<string, unknown>
  where?: { sql: string; params: unknown[] }
  /** The keys of the `select` or `returning` column object; `undefined` when none was passed. */
  columns?: string[]
  locked: boolean
  /** The row-lock strength (`for(...)`), when the query took one. */
  lock?: string
  /** An insert's `values`. */
  values?: Record<string, unknown>
  /** An insert's `onConflictDoUpdate`: the target column names, the `set` and the compiled `setWhere`. */
  conflict?: {
    target: string[]
    set: Record<string, unknown>
    setWhere?: { sql: string; params: unknown[] }
  }
  /** The compiled SQL of every computed (`sql` template) column the `select` named. */
  expressions?: Record<string, string>
  inTransaction: boolean
}

const dialect = new PgDialect()

export function fakeRunDb(results: unknown[][]) {
  const log: LoggedQuery[] = []
  const queue = [...results]
  const handle = (inTransaction: boolean) => {
    const query = (op: LoggedQuery['op'], cols?: object) => {
      const q: LoggedQuery = { op, locked: false, inTransaction }
      if (cols) {
        q.columns = Object.keys(cols)
        for (const [name, col] of Object.entries(cols)) {
          if (is(col, SQL)) (q.expressions ??= {})[name] = dialect.sqlToQuery(col).sql
        }
      }
      const chain = {
        set(values: Record<string, unknown>) {
          q.set = values
          return chain
        },
        from: () => chain,
        leftJoin: () => chain,
        limit: () => chain,
        values(values: Record<string, unknown>) {
          q.values = values
          return chain
        },
        onConflictDoUpdate(cfg: {
          target: { name: string }[]
          set: Record<string, unknown>
          setWhere?: SQL
        }) {
          q.conflict = { target: cfg.target.map((c) => c.name), set: cfg.set }
          if (cfg.setWhere) q.conflict.setWhere = dialect.sqlToQuery(cfg.setWhere)
          return chain
        },
        returning(returned?: object) {
          if (returned) q.columns = Object.keys(returned)
          return chain
        },
        where(cond: SQL | undefined) {
          if (cond) q.where = dialect.sqlToQuery(cond)
          return chain
        },
        for(mode: string) {
          q.locked = mode === 'update'
          q.lock = mode
          return chain
        },
        then<T>(resolve: (rows: unknown[]) => T, reject?: (err: unknown) => T) {
          log.push(q)
          return Promise.resolve(queue.shift() ?? []).then(resolve, reject)
        },
      }
      return chain
    }
    return {
      update: (_table: unknown) => query('update'),
      select: (cols?: object) => query('select', cols),
      insert: (_table: unknown) => query('insert'),
    }
  }
  const db = {
    ...handle(false),
    transaction: async <T>(fn: (tx: ReturnType<typeof handle>) => Promise<T>) => fn(handle(true)),
  }
  return { log, service: { db } as never }
}
