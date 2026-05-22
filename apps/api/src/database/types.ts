import type { ExtractTablesWithRelations } from 'drizzle-orm'
import type { PgTransaction } from 'drizzle-orm/pg-core'
import type { NodePgQueryResultHKT } from 'drizzle-orm/node-postgres'
import type * as schema from './schema'

/**
 * Drizzle transaction handle as exposed by `db.transaction(async (tx) => …)`.
 *
 * Use this type instead of `any` whenever a private helper accepts a `tx`
 * argument and needs to read/write tables. Mirrors the generic Drizzle binds
 * with the project's `schema` so query-builder method signatures (insert,
 * select, update, delete, query) are fully type-safe.
 *
 * Reviewer round 4 nit (PR 33): replaces `tx: any` + `eslint-disable
 * @typescript-eslint/no-explicit-any` comments in private helpers.
 */
export type DrizzleTx = PgTransaction<
  NodePgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>
