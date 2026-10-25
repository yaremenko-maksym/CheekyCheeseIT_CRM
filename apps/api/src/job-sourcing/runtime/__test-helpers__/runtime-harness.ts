import { randomUUID } from 'node:crypto'
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { JobSourceType } from '@crm/shared'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import type { CrmAppSession } from '../../../database/__test-helpers__/crm-app-session'
import * as schema from '../../../database/schema'
import { LedgerFixtures, SpecCatalog } from '../../../test/ledger-fixtures'
import type { MeterDb } from '../../metering/account-meter.store'
import { JobRunLedger } from '../../ownership/job-run-ledger'
import type { LedgerCatalogEntry } from '../../ownership/ledger-catalog'
import type { ReportingJobSourceProvider } from '../../providers/reporting-provider'
import { JobSourceRegistry } from '../../registry/job-source-registry'
import type { RunHandle } from '../../ownership/run-ownership'
import { type RegisteredAdapter, ReportingAdapter } from '../../registry/registered-adapter'
import type { HostPolicy } from '../../scheduling/host-policy'
import { type HostBan, recordHostBan } from '../../scheduling/host-state'
import { JobRunWorker, type WorkerDeps, type WorkerOptions } from '../job-run-worker'

/**
 * Spec-only harness for the T7 real-Postgres suites (excluded from the build by the
 * `__test-helpers__` glob). Two pieces:
 *
 *  - a LOCAL fixture HTTP server, and a `fetch` stub that sends every request the REAL
 *    `boundedFetchText` makes to it (the transport insists on https and public names, so the
 *    stub rewrites the target, and restores the original URL on the response so the transport's
 *    final-URL pin still holds). Nothing leaves the machine;
 *  - a world: the real ledger and worker on the `crm_app` pool, the heartbeat on its own
 *    connection, fixtures on the migration role.
 */

export interface SeenRequest {
  readonly host: string
  readonly path: string
  readonly method: string
}

export type FixtureAnswer =
  { status?: number; body?: unknown; headers?: Record<string, string> } | 'HANG'

export interface FixtureServer {
  readonly port: number
  readonly requests: SeenRequest[]
  answer: (req: SeenRequest) => FixtureAnswer | Promise<FixtureAnswer>
  close(): Promise<void>
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const hanging = new Set<ServerResponse>()
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const seen: SeenRequest = {
      host: String(req.headers['x-fixture-host'] ?? ''),
      path: req.url ?? '',
      method: req.method ?? 'GET',
    }
    fixture.requests.push(seen)
    void Promise.resolve(fixture.answer(seen)).then((a) => {
      if (a === 'HANG') {
        hanging.add(res)
        return
      }
      const body = typeof a.body === 'string' ? a.body : JSON.stringify(a.body ?? {})
      res.writeHead(a.status ?? 200, { 'content-type': 'application/json', ...a.headers })
      res.end(body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const fixture: FixtureServer = {
    port: (server.address() as AddressInfo).port,
    requests: [],
    answer: () => ({ body: {} }),
    close: () =>
      new Promise<void>((resolve) => {
        for (const res of hanging) res.destroy()
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
  return fixture
}

/** Route every `fetch` to the fixture server; returns the restore function. */
export function routeFetchTo(fixture: FixtureServer): () => void {
  const real = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const original = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    )
    const headers = new Headers(init?.headers)
    headers.set('x-fixture-host', original.host)
    const res = await real(
      `http://127.0.0.1:${fixture.port}${original.pathname}${original.search}`,
      {
        ...init,
        headers,
      },
    )
    const out = new Response(res.body, { status: res.status, headers: res.headers })
    Object.defineProperty(out, 'url', { value: original.href })
    return out
  }) as typeof fetch
  return () => {
    globalThis.fetch = real
  }
}

export interface World {
  readonly fx: LedgerFixtures
  readonly catalog: SpecCatalog
  readonly ledger: JobRunLedger
  readonly heartbeatPool: Pool
  readonly db: MeterDb
  readonly admin: Pool
  worker(over?: Partial<WorkerDeps>, options?: Partial<WorkerOptions>): JobRunWorker
  /** Register a real provider for `type`, wired to `hosts`. */
  register(provider: ReportingJobSourceProvider, hosts: readonly string[]): void
  /** Register any adapter as it is (e.g. DOU on the legacy contract). */
  registerAdapter(adapter: RegisteredAdapter): void
  /** The ledger's heartbeat on the reserved connection. */
  heartbeat(h: RunHandle): Promise<boolean>
  /** A reporting source of `type` with a config, a catalog entry and a host policy. */
  source(input: {
    type: JobSourceType
    config: Record<string, unknown>
    hostKey?: string
    accountMeterId?: string | null
    entry?: Partial<LedgerCatalogEntry>
    policy?: HostPolicy
  }): Promise<{ sourceId: string; hostKey: string }>
  cycle(): Promise<string>
  manualCycle(): Promise<string>
  readonly actor: string
  close(): Promise<void>
}

export const SPEC_LEDGER_OPTIONS = { leaseMs: 6_000, runMaxAgeMs: 60_000 } as const

export async function openWorld(session: CrmAppSession, tag: string): Promise<World> {
  const fx = new LedgerFixtures(session.admin, tag)
  const catalog = new SpecCatalog()
  const adapters = new Map<JobSourceType, RegisteredAdapter>()
  // The registry reads the map at every `get`, so adapters registered after the world opens count.
  const registry = new JobSourceRegistry([])
  ;(registry as unknown as { byType: Map<JobSourceType, RegisteredAdapter> }).byType = adapters
  const db = drizzle(session.pool, { schema }) as unknown as MeterDb
  const ledger = new JobRunLedger(db, registry, catalog, SPEC_LEDGER_OPTIONS)
  const heartbeatPool = new Pool({ ...session.pool.options, max: 1 })
  const heartbeatLedger = new JobRunLedger(
    drizzle(heartbeatPool, { schema }) as unknown as MeterDb,
    registry,
    catalog,
    SPEC_LEDGER_OPTIONS,
  )
  const { rows } = await session.admin.query(
    `INSERT INTO users (email, display_name, role) VALUES ($1, 'T7 spec', 'ADMIN') RETURNING id`,
    [`t7spec-${tag}@example.test`],
  )
  const actor = rows[0].id as string
  return {
    fx,
    catalog,
    ledger,
    heartbeatPool,
    db,
    admin: session.admin,
    actor,
    worker: (over = {}, options = {}) =>
      new JobRunWorker(
        {
          ledger,
          heartbeat: (h) => heartbeatLedger.heartbeat(h),
          registry,
          catalog,
          db,
          recordBan: (ban: HostBan) => recordHostBan(db as never, ban),
          secretsFor: () => [],
          ...over,
        },
        {
          owner: 'spec-worker',
          poolSize: 4,
          heartbeatMs: 1_000,
          runDeadlineMs: 20_000,
          deadlineGraceMs: 2_000,
          ...options,
        },
      ),
    registerAdapter: (adapter) => {
      adapters.set(adapter.type, adapter)
    },
    heartbeat: (h) => heartbeatLedger.heartbeat(h),
    register: (provider, hosts) => {
      adapters.set(
        provider.type,
        new ReportingAdapter(provider, {
          adapterVersion: `${provider.type.toLowerCase()}-spec`,
          allowedHosts: [...hosts],
        }),
      )
    },
    source: async (input) => {
      const manifestId = fx.manifestId()
      const hostKey = input.hostKey ?? fx.host(`h-${randomUUID().slice(0, 6)}`)
      catalog.add(manifestId, { type: input.type, ...input.entry })
      catalog.policies.set(hostKey, input.policy ?? { rate: null, floorHours: 0 })
      const sourceId = await fx.source({
        type: input.type,
        manifestId,
        hostKey,
        accountMeterId: input.accountMeterId ?? null,
      })
      await session.admin.query(`UPDATE job_sources SET config = $2::jsonb WHERE id = $1`, [
        sourceId,
        JSON.stringify(input.config),
      ])
      return { sourceId, hostKey }
    },
    cycle: async () =>
      (await ledger.openCycle({ trigger: 'SCHEDULED', triggerKey: fx.cycleKey() })).cycleId,
    manualCycle: async () =>
      (await ledger.openCycle({ trigger: 'MANUAL', triggerKey: fx.cycleKey(), actor })).cycleId,
    close: async () => {
      try {
        await fx.cleanup()
        await session.admin.query(`DELETE FROM users WHERE id = $1`, [actor])
      } finally {
        await heartbeatPool.end()
      }
    },
  }
}

/** A meter row in the shape the free plan / a quota declares. */
export async function meterRow(
  admin: Pool,
  accountKey: string,
  input: { unit: string; window: 'DAY' | 'MONTH'; limit: number | null; used?: number },
): Promise<string> {
  const { rows } = await admin.query(
    `INSERT INTO job_account_meters
       (account_key, unit, window_kind, limit_amount, used, window_started_at, resets_at)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', now() + interval '20 days')
     RETURNING id`,
    [accountKey, input.unit, input.window, input.limit, input.used ?? 0],
  )
  return rows[0].id as string
}

export async function reservationsOf(admin: Pool, runId: string) {
  const { rows } = await admin.query(
    `SELECT status, amount::int AS amount FROM job_account_meter_reservations WHERE run_id = $1 ORDER BY reserved_at`,
    [runId],
  )
  return rows as { status: string; amount: number }[]
}

export async function runRow(admin: Pool, runId: string) {
  const { rows } = await admin.query(
    `SELECT outcome, error_code, error_message, received::int AS received FROM job_collection_runs WHERE id = $1`,
    [runId],
  )
  return rows[0] as {
    outcome: string
    error_code: string | null
    error_message: string | null
    received: number
  }
}

export async function hostPausedForHours(admin: Pool, hostKey: string): Promise<number | null> {
  const { rows } = await admin.query(
    `SELECT extract(epoch FROM paused_until - clock_timestamp())::float8 / 3600 AS h FROM job_source_hosts WHERE host_key = $1`,
    [hostKey],
  )
  return rows[0]?.h ?? null
}
