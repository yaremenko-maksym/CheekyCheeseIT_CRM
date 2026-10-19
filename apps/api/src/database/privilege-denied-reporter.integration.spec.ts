import { randomUUID } from 'node:crypto'
import { Logger } from '@nestjs/common'
import type { ConfigService } from '@nestjs/config'
import { Test, type TestingModule } from '@nestjs/testing'
import { eq } from 'drizzle-orm'
import type { Pool } from 'pg'
import { Pool as PgPool } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DocumentAccessLogRetentionCronService } from '../documents/document-access-log-retention.cron'
import { assertRealDbSchema, hasDatabaseUrl } from '../test/require-real-db'
import { DatabaseService } from './database.service'
import { PrivilegeDeniedReporter } from './privilege-denied-reporter'
import { documentAccessLog } from './schema'

/**
 * The alert's chokepoint, against a REAL PostgreSQL and the REAL `DatabaseModule`.
 *
 * What a mock cannot show, and this does: that wrapping the pool at startup, through
 * Nest's own lifecycle, sees a 42501 on every route a statement can take — a raw
 * `pool.query`, drizzle outside a transaction, and drizzle INSIDE a transaction (which runs
 * on a checked-out client, not on `pool.query`) — and that it fires once per statement,
 * whoever swallows the error afterwards.
 *
 * Run against a scratch DB (NEVER the live crm_db), after `db:push`:
 *   DATABASE_URL=postgresql://<user>:<pw>@localhost:<port>/<scratch> \
 *     pnpm --filter @crm/api test -- privilege-denied-reporter.integration
 */

const SECRET = 'SECRET-VALUE-123'
const ROLE = `crm_privrep_probe_${randomUUID().slice(0, 8).replaceAll('-', '')}`
const CANONICAL = 'db_privilege_denied sqlstate=42501 table=document_access_log'

/** The one `ConfigService` call `DatabaseService` makes. */
const config = (databaseUrl: string): ConfigService<never> =>
  ({ get: () => databaseUrl }) as unknown as ConfigService<never>

describe.skipIf(!hasDatabaseUrl())('the privilege-denied chokepoint (real PostgreSQL)', () => {
  let admin: Pool
  let moduleRef: TestingModule
  let database: DatabaseService
  let errorSpy: ReturnType<typeof vi.spyOn>

  /** Every `Logger.error` first argument that is the canonical line. */
  const canonicalLines = (): string[] =>
    errorSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((m: string) => m.startsWith('db_privilege_denied'))

  beforeAll(async () => {
    await assertRealDbSchema([{ table: 'document_access_log', column: 'action' }])
    admin = new PgPool({ connectionString: process.env['DATABASE_URL'] })
    const { rows } = await admin.query('SELECT current_database() AS db, version() AS v')
    if (rows[0].db === 'crm_db') throw new Error('refusing to run against the live crm_db')
    console.log(
      `[privilege-denied-reporter] database=${rows[0].db} ${String(rows[0].v).split(',')[0]}`,
    )

    await admin.query(`CREATE ROLE ${ROLE}`)
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${ROLE}`)
    await admin.query(`GRANT ${ROLE} TO CURRENT_USER`)

    // The real DatabaseService, connecting as the ungranted role (`options=-c role=…`).
    const url = new URL(process.env['DATABASE_URL'] as string)
    url.searchParams.set('options', `-c role=${ROLE}`)
    // vitest (esbuild) does not emit decorator metadata, so Nest cannot resolve constructor
    // parameters by type here — every spec in this package builds providers by hand. The
    // providers below are the two `DatabaseModule` lists, constructed explicitly; Nest still
    // runs their REAL lifecycle hooks in its own order (`onModuleInit`, then
    // `onApplicationBootstrap`). That `DatabaseModule` lists the reporter is pinned in the
    // unit spec, and the compiled-app container spec resolves the real graph.
    moduleRef = await Test.createTestingModule({
      providers: [
        { provide: DatabaseService, useFactory: () => new DatabaseService(config(url.toString())) },
        {
          provide: PrivilegeDeniedReporter,
          useFactory: (db: DatabaseService) => new PrivilegeDeniedReporter(db),
          inject: [DatabaseService],
        },
      ],
    }).compile()
    await moduleRef.init() // runs the lifecycle hooks: DatabaseService creates the pool, the reporter wraps it
    database = moduleRef.get(DatabaseService)

    const who = await database.db.$client.query('SELECT current_user AS u')
    if (who.rows[0].u !== ROLE) {
      throw new Error(`premise failed: connected as ${String(who.rows[0].u)}, expected ${ROLE}`)
    }
  })

  afterAll(async () => {
    await moduleRef?.close()
    if (admin) {
      await admin.query(`DROP OWNED BY ${ROLE}`)
      await admin.query(`DROP ROLE ${ROLE}`)
      await admin.end()
    }
  })

  beforeEach(() => {
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    errorSpy.mockRestore()
  })

  it('a raw pool.query 42501 emits the canonical line once, ctx=pool', async () => {
    await expect(database.db.$client.query('SELECT * FROM document_access_log')).rejects.toThrow(
      'permission denied for table document_access_log',
    )

    expect(canonicalLines()).toEqual([`${CANONICAL} ctx=pool`])
  })

  it('drizzle outside a transaction: once, ctx=pool', async () => {
    await expect(database.db.select().from(documentAccessLog)).rejects.toThrow()

    expect(canonicalLines()).toEqual([`${CANONICAL} ctx=pool`])
  })

  it('drizzle INSIDE a transaction (a checked-out client): once, ctx=client', async () => {
    await expect(
      database.db.transaction(async (tx) => {
        await tx.select().from(documentAccessLog)
      }),
    ).rejects.toThrow()

    expect(canonicalLines()).toEqual([`${CANONICAL} ctx=client`])
  })

  it('a real swallowing cron handler: the handler resolves and the chokepoint line is still there, once', async () => {
    const svc = new DocumentAccessLogRetentionCronService(database)

    await expect(svc.handleRetention()).resolves.toBeUndefined()

    expect(canonicalLines()).toEqual([`${CANONICAL} ctx=pool`])
  })

  it('carries no bound value and no statement', async () => {
    await expect(
      database.db.select().from(documentAccessLog).where(eq(documentAccessLog.action, SECRET)),
    ).rejects.toThrow()

    const everything = JSON.stringify(errorSpy.mock.calls)
    expect(everything).not.toContain(SECRET)
    expect(canonicalLines()[0]).not.toMatch(/select|from|where/i)
  })

  it('says nothing for a different database error', async () => {
    await expect(database.db.$client.query('SELECT 1/0')).rejects.toThrow('division by zero')

    expect(canonicalLines()).toEqual([])
  })

  it('says nothing for a statement that succeeds', async () => {
    await database.db.$client.query('SELECT 1')

    expect(canonicalLines()).toEqual([])
  })
})
