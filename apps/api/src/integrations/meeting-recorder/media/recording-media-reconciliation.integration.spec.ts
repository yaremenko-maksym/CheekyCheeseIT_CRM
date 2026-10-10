import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { DatabaseService } from '../../../database/database.service'
import * as schema from '../../../database/schema'
import { assertRealDbSchema, hasDatabaseUrl } from '../../../test/require-real-db'
import { RecordingMediaReconciliationService } from './recording-media-reconciliation.service'
import type { RecordingMediaStorageService } from './recording-media-storage.service'

const CONNECTION_ID = '8d000000-0000-4000-a000-000000000001'
const ARTIFACT_ID = '8d000000-0000-4000-a000-000000000002'
const STALE_UPLOAD_ID = '8d000000-0000-4000-a000-000000000003'
const LIVE_UPLOAD_ID = '8d000000-0000-4000-a000-000000000004'
const NOW = new Date('2026-10-10T12:00:00.000Z')
const EXPIRED_AT = new Date('2026-10-09T12:00:00.000Z')
const LIVE_UNTIL = new Date('2026-10-12T12:00:00.000Z')

let pool: Pool
let service: RecordingMediaReconciliationService

async function cleanup(): Promise<void> {
  await pool.query('DELETE FROM recording_media_artifacts WHERE connection_id = $1', [
    CONNECTION_ID,
  ])
  await pool.query('DELETE FROM meeting_recorder_connections WHERE id = $1', [CONNECTION_ID])
}

async function seedExpiredAttempt(): Promise<void> {
  await pool.query(
    `INSERT INTO meeting_recorder_connections (id, name, enabled)
     VALUES ($1, 'Media reconciliation integration spec', true)`,
    [CONNECTION_ID],
  )
  await pool.query(
    `INSERT INTO recording_media_artifacts
       (id, connection_id, client_transfer_id, external_recording_id, role, filename,
        request_fingerprint, mime_type, bytes, storage_key, status)
     VALUES ($1, $2, 'transfer-stale', 'recording-stale', 'tab-recording', 'stale.webm',
             'fingerprint-stale', 'video/webm', 5, 'meeting-recordings/stale', 'uploading')`,
    [ARTIFACT_ID, CONNECTION_ID],
  )
  await pool.query(
    `INSERT INTO recording_media_uploads
       (id, artifact_id, storage_key, storage_upload_id, part_size, status, expires_at, updated_at)
     VALUES ($1, $2, 'meeting-recordings/stale', 'provider-stale', 5242880,
             'uploading', $3, $3)`,
    [STALE_UPLOAD_ID, ARTIFACT_ID, EXPIRED_AT],
  )
}

async function waitUntilReconcilerIsBlocked(): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    // Observe from a separate, non-transactional session. pg_stat_activity can be
    // transaction-cached; querying it through the blocker transaction can hide a
    // backend that connected after that transaction began.
    const result = await pool.query<{ waiting: string }>(
      `SELECT count(*)::text AS waiting
       FROM pg_stat_activity
       WHERE pid <> pg_backend_pid()
         AND datname = current_database()
         AND wait_event_type = 'Lock'`,
    )
    if (Number(result.rows[0]?.waiting ?? 0) > 0) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const activity = await pool.query<{
    pid: number
    state: string | null
    wait_event_type: string | null
    wait_event: string | null
    query: string
  }>(
    `SELECT pid, state, wait_event_type, wait_event, left(query, 240) AS query
     FROM pg_stat_activity
     WHERE datname = current_database()
     ORDER BY pid`,
  )
  throw new Error(
    `Reconciler did not reach the artifact row lock; pool=${JSON.stringify({
      max: pool.options.max,
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    })}; activity=${JSON.stringify(activity.rows)}`,
  )
}

describe.skipIf(!hasDatabaseUrl())('Recording media reconciliation — real Postgres', () => {
  beforeAll(async () => {
    await assertRealDbSchema([
      { table: 'meeting_recorder_connections', column: 'media_token_hash' },
      { table: 'recording_media_artifacts', column: 'status' },
      { table: 'recording_media_uploads', column: 'updated_at' },
    ])
    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    const dbService = Object.create(DatabaseService.prototype) as DatabaseService
    Object.assign(dbService, { db: drizzle(pool, { schema }) })
    const storage = {
      listOpenMediaUploads: vi.fn().mockResolvedValue([]),
      listMediaObjects: vi.fn().mockResolvedValue([]),
      abort: vi.fn(),
    } as unknown as RecordingMediaStorageService
    service = new RecordingMediaReconciliationService(dbService, storage)
  }, 20_000)

  beforeEach(async () => {
    await cleanup()
    await seedExpiredAttempt()
  })

  afterAll(async () => {
    if (!pool) return
    await cleanup()
    await pool.end()
  }, 20_000)

  it('retires a stale DB attempt and releases its logical artifact quota', async () => {
    await service.reconcile(NOW)

    const artifact = await pool.query<{ status: string }>(
      'SELECT status FROM recording_media_artifacts WHERE id = $1',
      [ARTIFACT_ID],
    )
    const upload = await pool.query<{ status: string }>(
      'SELECT status FROM recording_media_uploads WHERE id = $1',
      [STALE_UPLOAD_ID],
    )
    expect(artifact.rows[0]?.status).toBe('failed')
    expect(upload.rows[0]?.status).toBe('expired')
  })

  it('preserves the artifact when a live attempt commits while reconciliation waits for its row lock', async () => {
    const blocker = await pool.connect()
    try {
      await blocker.query('BEGIN')
      // EXCLUSIVE conflicts with the ROW SHARE table lock required by SELECT ... FOR UPDATE,
      // but it does not conflict with the ACCESS SHARE lock used by the initial candidate
      // SELECT. This gives the test a deterministic barrier after candidate selection and
      // before the artifact row lock without adding a test hook to production code.
      await blocker.query('LOCK TABLE recording_media_artifacts IN EXCLUSIVE MODE')

      const reconcile = service.reconcile(NOW)
      await waitUntilReconcilerIsBlocked()

      // Commit a newly-live attempt while the reconciler is parked between its candidate
      // query and row lock. Once the lock is released, the transaction must re-read this
      // attempt and preserve the logical artifact.
      await blocker.query(
        `INSERT INTO recording_media_uploads
           (id, artifact_id, storage_key, storage_upload_id, part_size, status, expires_at, updated_at)
         VALUES ($1, $2, 'meeting-recordings/live', 'provider-live', 5242880,
                 'uploading', $3, $4)`,
        [LIVE_UPLOAD_ID, ARTIFACT_ID, LIVE_UNTIL, NOW],
      )
      await blocker.query('COMMIT')
      await reconcile

      const artifact = await pool.query<{ status: string }>(
        'SELECT status FROM recording_media_artifacts WHERE id = $1',
        [ARTIFACT_ID],
      )
      const stale = await pool.query<{ status: string }>(
        'SELECT status FROM recording_media_uploads WHERE id = $1',
        [STALE_UPLOAD_ID],
      )
      expect(artifact.rows[0]?.status).toBe('uploading')
      expect(stale.rows[0]?.status).toBe('uploading')
    } finally {
      try {
        await blocker.query('ROLLBACK')
      } catch {
        // COMMIT already ended the transaction on the successful path.
      }
      blocker.release()
    }
  }, 10_000)
})
