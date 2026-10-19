import { Logger } from '@nestjs/common'
import type { ConfigService } from '@nestjs/config'
import { sql } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Env } from '../config/env'
import { hasDatabaseUrl } from '../test/require-real-db'
import { DatabaseService } from './database.service'

/**
 * Pool-listener guarantee against a REAL Postgres: when the server terminates a backend
 * that the API's pool holds idle, the process survives, the event is logged with its
 * SQLSTATE, and the next query is served.
 *
 * What this is NOT: a full server restart. A spec cannot stop and start the Postgres it
 * is wired to without taking every sibling spec's database away, so the termination is
 * `pg_terminate_backend` of the pool's own backend, issued from a second connection. The
 * server emits the same `57P01` (admin_shutdown) to the idle client that a `pg_ctl
 * restart` does, and that is the event the pool listener exists for. The full-restart
 * run was done by hand against a throwaway server and is described in the PR.
 *
 * Reads and kills only — no DDL, no data writes; runs against any scratch DATABASE_URL.
 */
describe.skipIf(!hasDatabaseUrl())(
  'DatabaseService survives a terminated backend (pg_terminate_backend, NOT a full restart)',
  () => {
    const url = process.env.DATABASE_URL
    const config = { get: () => url } as unknown as ConfigService<Env>
    const service = new DatabaseService(config)
    const admin = new Pool({ connectionString: url, max: 1 })
    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)

    beforeAll(async () => {
      await service.onModuleInit()
    })

    afterAll(async () => {
      await service.onModuleDestroy()
      await admin.end()
      errorSpy.mockRestore()
    })

    it('logs 57P01 for the killed idle client and serves the next query on a fresh backend', async () => {
      const first = await service.db.execute(sql`select pg_backend_pid() as pid`)
      const killedPid = Number(first.rows[0].pid)

      const killed = await admin.query('select pg_terminate_backend($1) as ok', [killedPid])
      expect(killed.rows[0].ok).toBe(true)

      await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledTimes(1), {
        timeout: 5000,
        interval: 50,
      })
      expect(errorSpy.mock.calls[0][0]).toBe(
        'Postgres pool idle-client error sqlstate=57P01: terminating connection due to administrator command',
      )

      const next = await service.db.execute(sql`select pg_backend_pid() as pid`)
      expect(Number(next.rows[0].pid)).not.toBe(killedPid)
    })
  },
)
