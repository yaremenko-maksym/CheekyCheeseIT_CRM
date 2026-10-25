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
 * registered later is refused `TRANSPORT_NOT_WIRED` until T6 gives it `allowedHosts`.
 */
export function createProductionWorker(
  db: MeterDb,
  registry: JobSourceRegistry,
  config: ConfigService<Env, true> | undefined,
  options: Partial<Omit<WorkerOptions, 'owner'>> = {},
): JobRunWorker {
  const requireConfig = (): ConfigService<Env, true> => {
    if (config === undefined) throw new Error('the run worker needs ConfigService to run')
    return config
  }
  const catalog = productionLedgerCatalog()
  const ledger = new JobRunLedger(db, registry, catalog)
  let heartbeatPool: Pool | null = null
  let heartbeatLedger: JobRunLedger | null = null
  const heartbeats = (): JobRunLedger => {
    if (heartbeatLedger === null) {
      heartbeatPool = new Pool({
        // Stryker disable next-line ObjectLiteral,BooleanLiteral: `infer` only types the value; the URL read is asserted by the port-1 refusal in production-worker.spec
        connectionString: requireConfig().get('DATABASE_URL', { infer: true }),
        max: 1,
      })
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
    },
    { owner: `api-${process.pid}`, ...options },
  )
}
