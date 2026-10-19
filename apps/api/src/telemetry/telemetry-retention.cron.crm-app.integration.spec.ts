import { randomUUID } from 'node:crypto'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  openCrmAppSession,
  sqlstateOfRejection,
  type CrmAppSession,
} from '../database/__test-helpers__/crm-app-session'
import { hasDatabaseUrl } from '../test/require-real-db'
import { TelemetryRetentionCronService } from './telemetry-retention.cron'

/**
 * TelemetryRetentionCronService against a REAL database, AS `crm_app`
 * (ADR 2026-10-17 §4 "What step 4 does not reach", measure 1).
 *
 * The job deletes from three tables — `telemetry_events`, `telemetry_errors`, `csp_reports`, all
 * class A. Its cron spec mocks `DatabaseService`, so a misclassification of any of them would
 * first show as a `42501` on the 03:30 fire. Each table gets its own assertion, because each is
 * a separate grant.
 *
 * Not covered here, deliberately: `enforceEventsCap` / `enforceCspReportsCap` only act above a
 * 1,000,000 / 10,000 row threshold. Their `DELETE` targets the same two tables under the same
 * grant the age-based deletes above already exercise, so the privilege question is answered; the
 * thresholds themselves are the mocked spec's business.
 */

const TAG = 'cron-real-db-spec'
const OLD_DAYS = 400 // past every window (events 90, errors 180, csp reports shorter than that)
const FRESH_DAYS = 1

interface Case {
  table: 'telemetry_events' | 'telemetry_errors' | 'csp_reports'
  /** Inserts one row aged `ageDays`; returns its id as text. */
  insert(session: CrmAppSession, ageDays: number): Promise<string>
}

const CASES: Case[] = [
  {
    table: 'telemetry_events',
    async insert(session, ageDays) {
      const { rows } = await session.admin.query<{ id: string }>(
        `INSERT INTO telemetry_events (session_hash, user_role, event, route, target, created_at)
         VALUES ($1, 'ADMIN', 'route_enter', '/cron-real-db-spec', $2, now() - ($3::int * interval '1 day'))
         RETURNING id::text`,
        [randomUUID(), TAG, ageDays],
      )
      return (rows[0] as { id: string }).id
    },
  },
  {
    table: 'telemetry_errors',
    async insert(session, ageDays) {
      const { rows } = await session.admin.query<{ id: string }>(
        `INSERT INTO telemetry_errors (fingerprint, source, message, meta, last_seen)
         VALUES ($1, 'WEB', $2, '{}'::jsonb, now() - ($3::int * interval '1 day'))
         RETURNING id::text`,
        [`${TAG}-${randomUUID()}`, TAG, ageDays],
      )
      return (rows[0] as { id: string }).id
    },
  },
  {
    table: 'csp_reports',
    async insert(session, ageDays) {
      const { rows } = await session.admin.query<{ id: string }>(
        `INSERT INTO csp_reports (effective_directive, blocked_uri, document_path, last_seen)
         VALUES ('script-src', $1, $2, now() - ($3::int * interval '1 day'))
         RETURNING id::text`,
        [`${TAG}-${randomUUID()}`, `/${TAG}`, ageDays],
      )
      return (rows[0] as { id: string }).id
    },
  },
]

describe.skipIf(!hasDatabaseUrl())(
  'TelemetryRetentionCronService as crm_app (ADR 2026-10-17 measure 1)',
  () => {
    let session: CrmAppSession
    let cron: TelemetryRetentionCronService

    beforeAll(async () => {
      session = await openCrmAppSession()
      cron = new TelemetryRetentionCronService(session.databaseService)
    }, 120_000)

    afterEach(async () => {
      await session?.admin.query(`DELETE FROM telemetry_events WHERE target = $1`, [TAG])
      await session?.admin.query(`DELETE FROM telemetry_errors WHERE message = $1`, [TAG])
      await session?.admin.query(`DELETE FROM csp_reports WHERE document_path = $1`, [`/${TAG}`])
    })

    afterAll(async () => {
      await session?.close()
    })

    async function exists(table: Case['table'], id: string): Promise<boolean> {
      const { rowCount } = await session.admin.query(`SELECT 1 FROM ${table} WHERE id::text = $1`, [
        id,
      ])
      return rowCount === 1
    }

    it('is connected as crm_app — not a superuser, not an owner of anything', async () => {
      expect(await session.identity()).toEqual({
        currentUser: 'crm_app',
        sessionUser: 'crm_app',
        isSuperuser: false,
        bypassesRls: false,
        ownedRelations: 0,
      })
    })

    it('purgeExpired: every DELETE is permitted to crm_app and removes only expired rows', async () => {
      const seeded = await Promise.all(
        CASES.map(async (c) => ({
          c,
          expired: await c.insert(session, OLD_DAYS),
          fresh: await c.insert(session, FRESH_DAYS),
        })),
      )

      const result = await cron.purgeExpired()

      expect(result.eventsDeletedByAge).toBeGreaterThanOrEqual(1)
      expect(result.errorsDeleted).toBeGreaterThanOrEqual(1)
      expect(result.cspReportsDeletedByAge).toBeGreaterThanOrEqual(1)
      for (const { c, expired, fresh } of seeded) {
        expect(await exists(c.table, expired), `${c.table}: expired row`).toBe(false)
        expect(await exists(c.table, fresh), `${c.table}: fresh row`).toBe(true)
      }
    })

    it.each(CASES.map((c) => [c.table, c] as const))(
      'control: with DELETE withdrawn on %s the purge fails with 42501',
      async (_table, c) => {
        const expired = await c.insert(session, OLD_DAYS)

        const state = await session.withPrivilegeWithdrawn('DELETE', c.table, () =>
          sqlstateOfRejection(() => cron.purgeExpired()),
        )

        expect(state).toBe('42501')
        expect(await exists(c.table, expired)).toBe(true)
      },
    )
  },
)
