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
  locked: boolean
  inTransaction: boolean
}

const dialect = new PgDialect()

export function fakeRunDb(results: unknown[][]) {
  const log: LoggedQuery[] = []
  const queue = [...results]
  const handle = (inTransaction: boolean) => {
    const query = (op: LoggedQuery['op']) => {
      const q: LoggedQuery = { op, locked: false, inTransaction }
      const chain = {
        set(values: Record<string, unknown>) {
          q.set = values
          return chain
        },
        from: () => chain,
        limit: () => chain,
        returning: () => chain,
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
      select: (_cols?: unknown) => query('select'),
    }
  }
  const db = {
    ...handle(false),
    transaction: async <T>(fn: (tx: ReturnType<typeof handle>) => Promise<T>) => fn(handle(true)),
  }
  return { log, service: { db } as never }
}
