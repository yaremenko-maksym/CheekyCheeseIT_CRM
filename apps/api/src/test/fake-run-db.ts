/**
 * A recording double of the Drizzle query builder for the verification run's unit specs (Task 14).
 * Every awaited query is logged with its `set` values, its compiled `where` and whether it took a
 * row lock, and resolves to the next scripted result. The real SQL is pinned by the integration spec.
 */
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'

export type LoggedQuery = {
  op: 'update' | 'select'
  set?: Record<string, unknown>
  where?: { sql: string; params: unknown[] }
  /** The keys of the `select` or `returning` column object; `undefined` when none was passed. */
  columns?: string[]
  locked: boolean
  inTransaction: boolean
}

const dialect = new PgDialect()

export function fakeRunDb(results: unknown[][]) {
  const log: LoggedQuery[] = []
  const queue = [...results]
  const handle = (inTransaction: boolean) => {
    const query = (op: LoggedQuery['op'], cols?: object) => {
      const q: LoggedQuery = { op, locked: false, inTransaction }
      if (cols) q.columns = Object.keys(cols)
      const chain = {
        set(values: Record<string, unknown>) {
          q.set = values
          return chain
        },
        from: () => chain,
        limit: () => chain,
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
    }
  }
  const db = {
    ...handle(false),
    transaction: async <T>(fn: (tx: ReturnType<typeof handle>) => Promise<T>) => fn(handle(true)),
  }
  return { log, service: { db } as never }
}
