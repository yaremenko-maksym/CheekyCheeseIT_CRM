import { randomUUID } from 'node:crypto'
import { Logger } from '@nestjs/common'
import { eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { DocumentAccessLogRetentionCronService } from '../documents/document-access-log-retention.cron'
import { assertRealDbSchema, hasDatabaseUrl } from '../test/require-real-db'
import { describeDbError, safeErrorStack } from './pg-errors'
import { documentAccessLog } from './schema'

/**
 * AC3 — the SQLSTATE reaches the log, proven against a REAL PostgreSQL.
 *
 * A mocked error object cannot prove this: the thing under test is the shape the DRIVER's
 * error has by the time a handler sees it (`DrizzleQueryError` -> `.cause` -> pg's
 * `DatabaseError`). So this suite runs a real cron handler, whose real statement is
 * rejected by a real role that was never granted the table, and reads what the handler
 * handed to the logger.
 *
 * It also asserts the PREMISE on the real driver (drizzle's `message` does not contain the
 * SQLSTATE, `.code` is undefined, and the message DOES contain the parameter value) so the
 * proof cannot pass vacuously: if a future drizzle starts putting `42501` into `message`,
 * this suite says so instead of quietly going green.
 *
 * Run against a scratch DB (NEVER the live crm_db), after `db:push`:
 *   DATABASE_URL=postgresql://<user>:<pw>@localhost:<port>/<scratch> \
 *     pnpm --filter @crm/api test -- pg-errors-log.integration
 * The user must be allowed to CREATE ROLE; the suite creates one NOLOGIN-style probe role,
 * connects as the admin with `SET ROLE` semantics (`options: -c role=...`), and drops it.
 */

const SECRET = 'SECRET-VALUE-123'
const ROLE = `crm_sqlstate_probe_${randomUUID().slice(0, 8).replaceAll('-', '')}`

describe.skipIf(!hasDatabaseUrl())(
  'a database error’s SQLSTATE reaches the log (real PostgreSQL)',
  () => {
    let admin: Pool
    let restricted: Pool

    beforeAll(async () => {
      await assertRealDbSchema([{ table: 'document_access_log', column: 'action' }])
      admin = new Pool({ connectionString: process.env['DATABASE_URL'] })
      const { rows } = await admin.query('SELECT current_database() AS db, version() AS v')
      if (rows[0].db === 'crm_db') throw new Error('refusing to run against the live crm_db')
      // A writing spec states which database it is writing to (two PostgreSQL instances
      // answer on 5432 on the owner's machine).
      console.log(`[pg-errors-log] database=${rows[0].db} ${String(rows[0].v).split(',')[0]}`)

      // A role with the schema visible and NOTHING granted on any table.
      await admin.query(`CREATE ROLE ${ROLE}`)
      await admin.query(`GRANT USAGE ON SCHEMA public TO ${ROLE}`)
      await admin.query(`GRANT ${ROLE} TO CURRENT_USER`)
      restricted = new Pool({
        connectionString: process.env['DATABASE_URL'],
        options: `-c role=${ROLE}`,
      })
      // The premise of every test below, established rather than assumed.
      const who = await restricted.query('SELECT current_user AS u')
      if (who.rows[0].u !== ROLE) {
        throw new Error(`premise failed: connected as ${String(who.rows[0].u)}, expected ${ROLE}`)
      }
    })

    afterAll(async () => {
      await restricted?.end()
      if (admin) {
        await admin.query(`DROP OWNED BY ${ROLE}`)
        await admin.query(`DROP ROLE ${ROLE}`)
        await admin.end()
      }
    })

    it('a real cron handler swallows a real 42501 and logs db_sqlstate=42501', async () => {
      const svc = new DocumentAccessLogRetentionCronService({ db: drizzle(restricted) } as never)
      const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
      try {
        await expect(svc.handleRetention()).resolves.toBeUndefined() // swallowed, not thrown

        expect(errorSpy).toHaveBeenCalledTimes(1)
        const args = errorSpy.mock.calls[0] as unknown[]
        const message = String(args[0])
        expect(message).toContain(
          'Document access log retention cron failed — will retry next cycle',
        )
        expect(message).toContain('db_error db_sqlstate=42501')
        expect(message).toContain('permission denied for table document_access_log')
        expect(message).toContain("db_statement=\"delete from 'document_access_log' where")
        // The stack argument is frames only (the real error's `name` is plain "Error"): it
        // still names the failing call site, and carries no query text.
        expect(String(args[1])).toMatch(/^Error\n\s+at /)
        expect(String(args[1])).toContain(
          'DocumentAccessLogRetentionCronService.purgeExpiredEntries',
        )
        expect(String(args[1])).not.toContain('Failed query')
      } finally {
        errorSpy.mockRestore()
      }
    })

    it('measured premise: drizzle’s own message and stack carry neither the SQLSTATE nor the privilege text — only .cause does', async () => {
      const db = drizzle(restricted)
      const err = await db
        .select()
        .from(documentAccessLog)
        .where(eq(documentAccessLog.action, SECRET))
        .then(
          () => {
            throw new Error('expected the database to refuse the statement')
          },
          (e: unknown) =>
            e as Error & { code?: unknown; cause?: { code?: string; message?: string } },
        )

      expect(err.code).toBeUndefined()
      expect(err.message).not.toContain('42501')
      expect(err.message).not.toContain('permission denied')
      expect(err.stack).not.toContain('42501')
      expect(err.stack).not.toContain('permission denied')
      expect(err.cause?.code).toBe('42501')
      expect(err.cause?.message).toBe('permission denied for table document_access_log')
      // ...and the same message DOES carry the bound value, which is why it cannot be logged.
      expect(err.message).toContain(SECRET)
    })

    it('AC4 on the real driver: the logged fragment and stack contain the SQLSTATE and not the bound value', async () => {
      const db = drizzle(restricted)
      const err = await db
        .select()
        .from(documentAccessLog)
        .where(eq(documentAccessLog.action, SECRET))
        .then(
          () => undefined,
          (e: unknown) => e,
        )

      const fragment = describeDbError(err) ?? ''
      expect(fragment).toContain('db_sqlstate=42501')
      expect(fragment).toContain('db_statement="select')
      // The placeholder, never the value. Drizzle emits "document_access_log"."action"; the
      // contract turns the double quotes into single ones.
      expect(fragment).toContain("'document_access_log'.'action' = $1")
      expect(fragment).not.toContain(SECRET)
      expect(safeErrorStack(err) ?? '').not.toContain(SECRET)
    })

    it('a class-22 error puts the value in the DRIVER’s message; the fragment drops that message', async () => {
      const err = await drizzle(admin)
        .execute(sql`SELECT ${SECRET}::int`)
        .then(
          () => undefined,
          (e: unknown) => e as Error & { cause?: { message?: string } },
        )

      // Premise, real driver: the value is in the cause's own message.
      expect(err?.cause?.message).toContain(SECRET)
      const fragment = describeDbError(err) ?? ''
      expect(fragment).toContain('db_sqlstate=22P02')
      expect(fragment).toContain('db_message=-')
      expect(fragment).not.toContain(SECRET)
      expect(safeErrorStack(err) ?? '').not.toContain(SECRET)
    })

    it('a bare driver error (no drizzle wrapper) is read the same way, and its stack is value-free', async () => {
      const err = await admin.query('SELECT $1::int', [SECRET]).then(
        () => undefined,
        (e: unknown) => e,
      )

      const fragment = describeDbError(err) ?? ''
      expect(fragment).toContain('db_sqlstate=22P02')
      expect(fragment).toContain('db_statement=-')
      expect(fragment).not.toContain(SECRET)
      expect(safeErrorStack(err) ?? '').not.toContain(SECRET)
    })

    it('a class-42 error from a real unknown relation keeps its message', async () => {
      const err = await drizzle(admin)
        .execute(sql`SELECT 1 FROM table_that_does_not_exist_${sql.raw(randomUUID().slice(0, 4))}`)
        .then(
          () => undefined,
          (e: unknown) => e,
        )

      const fragment = describeDbError(err) ?? ''
      expect(fragment).toContain('db_sqlstate=42P01')
      expect(fragment).toMatch(
        /db_message="relation 'table_that_does_not_exist_\w+' does not exist"/,
      )
    })
  },
)
