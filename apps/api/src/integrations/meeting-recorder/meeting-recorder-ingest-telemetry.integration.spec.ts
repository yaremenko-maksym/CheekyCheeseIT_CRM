/**
 * SR-865-M-1 / CR-865-H-4 (retro review of PR #865) — real Postgres.
 *
 * A database failure during webhook ingestion rejects with a drizzle error whose
 * `message` and `stack` embed the bound parameters: the recording `snapshot`, i.e. a
 * candidate's transcript. `TelemetryExceptionFilter` used to store both verbatim in
 * `telemetry_errors`, from where the digest files issues.
 *
 * The failure here is real, not a hand-built error: the snapshot validation is
 * bypassed (a stand-in for any validation gap) so a `\u0000` reaches Postgres on the real
 * ingest path, and Postgres rejects the jsonb with 22P05 — the finding's own example.
 * The rejection then goes through the real filter into the real `telemetry_errors`, and
 * the assertion is on the recorded row.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ArgumentsHost } from '@nestjs/common'
import type { HttpAdapterHost } from '@nestjs/core'
import { meetingRecorderWebhookEventSchema, type MeetingRecorderSnapshotEvent } from '@crm/shared'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { DatabaseService } from '../../database/database.service'
import * as schema from '../../database/schema'
import type { InterviewAccessPolicyService } from '../../interviews/interview-access-policy.service'
import { TelemetryErrorsService } from '../../telemetry/telemetry-errors.service'
import { TelemetryExceptionFilter } from '../../telemetry/telemetry-exception.filter'
import { assertRealDbSchema, hasDatabaseUrl } from '../../test/require-real-db'
import { MeetingRecorderMatcher } from './meeting-recorder-matcher'
import type { MeetingRecorderSecretCryptoService } from './meeting-recorder-secret-crypto.service'
import { MeetingRecorderService } from './meeting-recorder.service'

vi.mock('@crm/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@crm/shared')>()
  // The validation gap under test: the snapshot reaches the database as received.
  return { ...actual, sanitizeMeetingRecorderRecording: (recording: unknown) => recording }
})

const CONNECTION_ID = '7d000000-0000-4000-a000-000000000001'
const CIPHERTEXT = 'ingest-telemetry-spec-ciphertext'
const ROUTE = `/api/integrations/meeting-recorder/${CONNECTION_ID}/webhook`
const TRANSCRIPT_MARKER = 'candidate-private-transcript-marker-7d'

const READY_FIXTURE = meetingRecorderWebhookEventSchema.parse(
  JSON.parse(
    readFileSync(join(__dirname, '__fixtures__', 'recording-ready-v1.json'), 'utf8'),
  ) as unknown,
) as MeetingRecorderSnapshotEvent

let pool: Pool
let service: MeetingRecorderService
let telemetryErrors: TelemetryErrorsService

async function cleanup(): Promise<void> {
  await pool.query('DELETE FROM telemetry_errors WHERE route = $1', [ROUTE])
  await pool.query('DELETE FROM meeting_recorder_webhook_receipts WHERE connection_id = $1', [
    CONNECTION_ID,
  ])
  await pool.query('DELETE FROM interview_recordings WHERE connection_id = $1', [CONNECTION_ID])
  await pool.query('DELETE FROM meeting_recorder_connections WHERE id = $1', [CONNECTION_ID])
}

function hostFor(url: string): ArgumentsHost {
  const response = {}
  const req = { url }
  return {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => response }),
    getArgByIndex: (index: number) => (index === 1 ? response : req),
  } as unknown as ArgumentsHost
}

function filterWithAdapter(): TelemetryExceptionFilter {
  const filter = new TelemetryExceptionFilter(telemetryErrors)
  // Nest injects this property itself; a hand-built filter needs it set (see the unit spec).
  ;(filter as unknown as { httpAdapterHost: HttpAdapterHost }).httpAdapterHost = {
    httpAdapter: { reply: vi.fn(), getRequestUrl: () => ROUTE, isHeadersSent: () => false },
  } as unknown as HttpAdapterHost
  return filter
}

describe.skipIf(!hasDatabaseUrl())(
  'Meeting Recorder ingest failure → telemetry_errors — real Postgres',
  () => {
    beforeAll(async () => {
      await assertRealDbSchema([
        { table: 'interview_recordings', column: 'snapshot' },
        { table: 'telemetry_errors', column: 'stack' },
      ])
      pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
      await cleanup()
      await pool.query(
        `INSERT INTO meeting_recorder_connections (id, name, enabled, signing_secret_ciphertext)
         VALUES ($1, 'Ingest telemetry spec', true, $2)`,
        [CONNECTION_ID, CIPHERTEXT],
      )

      const dbService = Object.create(DatabaseService.prototype) as DatabaseService
      Object.assign(dbService, { db: drizzle(pool, { schema }) })
      telemetryErrors = new TelemetryErrorsService(dbService)
      service = new MeetingRecorderService(
        dbService,
        {} as MeetingRecorderSecretCryptoService,
        new MeetingRecorderMatcher(),
        { assertUpdateAccess: vi.fn() } as unknown as InterviewAccessPolicyService,
      )
    }, 20_000)

    afterAll(async () => {
      if (!pool) return
      await cleanup()
      await pool.end()
    }, 20_000)

    it('records the SQLSTATE and statement shape, and no transcript text, for a failed ingest', async () => {
      const event = structuredClone(READY_FIXTURE)
      event.data.recording.transcript!.segments[0]!.text = `${TRANSCRIPT_MARKER} \u0000 end`

      const failure = await service.ingestWebhookEvent(CONNECTION_ID, event, CIPHERTEXT).then(
        () => null,
        (reason: unknown) => reason as Error,
      )

      // Precondition: the real failure DOES carry the transcript — otherwise this
      // spec would pass whatever the filter did.
      expect(failure).toBeInstanceOf(Error)
      expect(`${failure!.message}\n${failure!.stack}`).toContain(TRANSCRIPT_MARKER)

      filterWithAdapter().catch(failure, hostFor(ROUTE))

      const row = await vi.waitFor(
        async () => {
          const result = await pool.query<{ message: string; stack: string | null }>(
            'SELECT message, stack FROM telemetry_errors WHERE route = $1',
            [ROUTE],
          )
          expect(result.rows).toHaveLength(1)
          return result.rows[0]!
        },
        { timeout: 5_000, interval: 50 },
      )

      expect(row.message).toContain('db_state=22P05')
      expect(row.message).toContain('db_statement="insert into')
      expect(`${row.message}\n${row.stack ?? ''}`).not.toContain(TRANSCRIPT_MARKER)
      expect(`${row.message}\n${row.stack ?? ''}`).not.toContain('CRM contract review')

      // The ingest transaction rolled back as a whole, so the provider's retry is processed.
      const receipts = await pool.query(
        'SELECT 1 FROM meeting_recorder_webhook_receipts WHERE connection_id = $1',
        [CONNECTION_ID],
      )
      expect(receipts.rowCount).toBe(0)
    })
  },
)
