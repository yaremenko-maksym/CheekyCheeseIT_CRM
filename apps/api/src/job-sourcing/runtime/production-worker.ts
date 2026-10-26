import { Logger } from '@nestjs/common'
import type { ConfigService } from '@nestjs/config'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import type { Env } from '../../config/env'
import * as schema from '../../database/schema'
import type { MeterDb } from '../metering/account-meter.store'
import { JobRunLedger } from '../ownership/job-run-ledger'
import { secretsForType } from '../quota-credentials'
import type { JobSourceRegistry } from '../registry/job-source-registry'
import { recordHostBan } from '../scheduling/host-state'
import { JobRunWorker, type WorkerOptions } from './job-run-worker'
import { productionLedgerCatalog } from './production-catalog'

/**
 * The worker the application runs with (r5 Task 2.5 T7): the ledger over the app's pool, its
 * heartbeat on a pool of ONE connection reserved for it (pool `N + 1`, ADR "Lease, heartbeat and
 * page writes"), the generated production catalog, T8's `recordHostBan`, and the types'
 * credentials as secrets.
 *
 * `config` is required to RUN, not to construct: the module builds the worker at boot, and a
 * context without `ConfigService` (a wiring spec) never runs one. The heartbeat pool is opened on
 * the first heartbeat.
 *
 * !! PROVIDING THIS MAKES NO SOURCE RUNNABLE. Nothing calls the worker until T5's handlers; the
 * registry holds DOU only (the ledger refuses it `NOT_ACTIVATABLE`), and a reporting adapter
 * registered later is refused `TRANSPORT_NOT_WIRED` unless it is built with its `REPORTING_WIRING`
 * entry (T6), whose hosts the transport is pinned to.
 */
/**
 * The app's database, read at the moment of each call. `DatabaseService` opens its pool and sets
 * `db` in `onModuleInit`, which Nest runs AFTER every factory provider; a factory that read
 * `database.db` directly captured `undefined` (PR #1162: the admin reset answered 500). Every
 * property is fetched from the live `db` on use, methods bound to it.
 */
export function lateBoundDb(database: { readonly db: unknown }): MeterDb {
  return new Proxy({} as MeterDb, {
    get(_target, property) {
      const db = database.db as Record<PropertyKey, unknown>
      const value = db[property]
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(db)
        : value
    },
  })
}

/**
 * The heartbeat's reserved pool (one connection, pool `N + 1`), with the `'error'` listener
 * `DatabaseService` has for its own pool (T7 CR-H-1 / SR-M-1). Without it, an error on the idle
 * client (a Postgres restart, a terminated backend, a dropped link) is an unhandled `'error'` event
 * and kills the API process. pg discards the broken client and opens a new one on the next query,
 * so the listener only makes the event visible; a missed heartbeat degrades through the local
 * lease (SR-L-22).
 */
export function createHeartbeatPool(connectionString: string, logger: Pick<Logger, 'error'>): Pool {
  const pool = new Pool({ connectionString, max: 1 })
  pool.on('error', (err: Error & { code?: string }) => {
    const sqlstate = err.code ? ` sqlstate=${err.code}` : ''
    logger.error(
      `Run-worker heartbeat pool idle-client error${sqlstate}: ${err.message}`,
      err.stack,
    )
  })
  return pool
}

/** The production ledger: the app's database, the registry, the generated production catalog. */
export function createProductionLedger(db: MeterDb, registry: JobSourceRegistry): JobRunLedger {
  return new JobRunLedger(db, registry, productionLedgerCatalog())
}

export function createProductionWorker(
  ledger: JobRunLedger,
  db: MeterDb,
  registry: JobSourceRegistry,
  config: ConfigService<Env, true> | undefined,
  options: Partial<Omit<WorkerOptions, 'owner'>> = {},
): JobRunWorker {
  const requireConfig = (): ConfigService<Env, true> => {
    if (config === undefined) throw new Error('the run worker needs ConfigService to run')
    return config
  }
  const catalog = ledger.catalog
  const logger = new Logger(JobRunWorker.name)
  let heartbeatPool: Pool | null = null
  let heartbeatLedger: JobRunLedger | null = null
  const heartbeats = (): JobRunLedger => {
    if (heartbeatLedger === null) {
      heartbeatPool = createHeartbeatPool(
        // Stryker disable next-line ObjectLiteral,BooleanLiteral: `infer` only types the value; the URL read is asserted by the port-1 refusal in production-worker.spec
        requireConfig().get('DATABASE_URL', { infer: true }),
        logger,
      )
      // Stryker disable next-line ObjectLiteral: the heartbeat runs one raw SQL statement; the schema option shapes the drizzle type, not the statement
      heartbeatLedger = new JobRunLedger(drizzle(heartbeatPool, { schema }), registry, catalog)
    }
    return heartbeatLedger
  }
  return new JobRunWorker(
    {
      ledger,
      heartbeat: (h) => heartbeats().heartbeat(h),
      registry,
      catalog,
      db,
      recordBan: (ban) => recordHostBan(db, ban),
      secretsFor: (type) =>
        // Stryker disable next-line ObjectLiteral,BooleanLiteral: `infer` only types the value; the key read is asserted in production-worker.spec
        secretsForType(type, (key) => requireConfig().get(key, { infer: true })),
      close: async () => {
        await heartbeatPool?.end()
      },
      logger,
    },
    { owner: `api-${process.pid}`, ...options },
  )
}
