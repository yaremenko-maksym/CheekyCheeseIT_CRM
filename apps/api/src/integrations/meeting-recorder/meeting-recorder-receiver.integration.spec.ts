import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  MEETING_RECORDER_INDEXED_IDENTIFIER_MAX_CHARS,
  meetingRecorderWebhookEventSchema,
  type MeetingRecorderSnapshotEvent,
  type SessionUser,
} from '@crm/shared'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { DatabaseService } from '../../database/database.service'
import * as schema from '../../database/schema'
import { assertRealDbSchema, hasDatabaseUrl } from '../../test/require-real-db'
import type { InterviewAccessPolicyService } from '../../interviews/interview-access-policy.service'
import { MeetingRecorderMatcher } from './meeting-recorder-matcher'
import type { MeetingRecorderSecretCryptoService } from './meeting-recorder-secret-crypto.service'
import { MeetingRecorderService } from './meeting-recorder.service'

const USER_ID = '7c000000-0000-4000-a000-000000000001'
const MATCH_INTERVIEW_ID = '7c000000-0000-4000-a000-000000000002'
const MANUAL_INTERVIEW_ID = '7c000000-0000-4000-a000-000000000003'
const CONNECTION_ID = '7c000000-0000-4000-a000-000000000004'
const CIPHERTEXT = 'fixture-signing-secret-ciphertext'
const MATCH_RECORDING_ID = 'recording_contract_fixture_v1'
const UNMATCHED_RECORDING_ID = 'recording_contract_unmatched_v1'

const ADMIN: SessionUser = {
  id: USER_ID,
  email: 'meeting-recorder-integration@test.spec',
  displayName: 'Meeting Recorder Integration Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
  locale: 'en',
  legalFullName: null,
}

const FIXTURE_DIR = join(__dirname, '__fixtures__')
const TEST_FIXTURE = meetingRecorderWebhookEventSchema.parse(
  JSON.parse(readFileSync(join(FIXTURE_DIR, 'integration-test-v1.json'), 'utf8')),
)
const READY_FIXTURE = meetingRecorderWebhookEventSchema.parse(
  JSON.parse(readFileSync(join(FIXTURE_DIR, 'recording-ready-v1.json'), 'utf8')),
) as MeetingRecorderSnapshotEvent
const UPDATED_FIXTURE = meetingRecorderWebhookEventSchema.parse(
  JSON.parse(readFileSync(join(FIXTURE_DIR, 'recording-updated-v1.json'), 'utf8')),
) as MeetingRecorderSnapshotEvent

let pool: Pool
let service: MeetingRecorderService

async function cleanup(): Promise<void> {
  await pool.query('DELETE FROM meeting_recorder_audit_log WHERE connection_id = $1', [
    CONNECTION_ID,
  ])
  await pool.query('DELETE FROM meeting_recorder_webhook_receipts WHERE connection_id = $1', [
    CONNECTION_ID,
  ])
  await pool.query('DELETE FROM interview_recordings WHERE connection_id = $1', [CONNECTION_ID])
  await pool.query('DELETE FROM meeting_recorder_connections WHERE id = $1', [CONNECTION_ID])
  await pool.query('DELETE FROM interviews WHERE id = ANY($1)', [
    [MATCH_INTERVIEW_ID, MANUAL_INTERVIEW_ID],
  ])
  await pool.query('DELETE FROM users WHERE id = $1', [USER_ID])
}

describe.skipIf(!hasDatabaseUrl())('Meeting Recorder receiver semantics — real Postgres', () => {
  beforeAll(async () => {
    await assertRealDbSchema([
      { table: 'meeting_recorder_connections', column: 'expected_source' },
      { table: 'meeting_recorder_webhook_receipts', column: 'webhook_id' },
      { table: 'interview_recordings', column: 'revision' },
      { table: 'interview_recordings', column: 'auto_match_suppressed' },
    ])

    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    await cleanup()

    await pool.query(
      `INSERT INTO users (id, email, display_name, role, locale)
       VALUES ($1, $2, $3, 'ADMIN', 'en')`,
      [USER_ID, ADMIN.email, ADMIN.displayName],
    )
    await pool.query(
      `INSERT INTO interviews (id, senior_id, company_name, call_url, stage)
       VALUES
         ($1, $3, 'Integration Test Ltd', 'https://meet.google.com/abc-defg-hij', 'TECH_INTERVIEW'),
         ($2, $3, 'Manual Link Ltd', 'https://meet.google.com/manual-room', 'FINAL_INTERVIEW')`,
      [MATCH_INTERVIEW_ID, MANUAL_INTERVIEW_ID, USER_ID],
    )
    await pool.query(
      `INSERT INTO meeting_recorder_connections
         (id, name, enabled, signing_secret_ciphertext)
       VALUES ($1, 'Receiver integration spec', true, $2)`,
      [CONNECTION_ID, CIPHERTEXT],
    )

    const db = drizzle(pool, { schema })
    const dbService = Object.create(DatabaseService.prototype) as DatabaseService
    Object.assign(dbService, { db })
    const interviewAccess = {
      assertUpdateAccess: vi.fn().mockResolvedValue(undefined),
    } as unknown as InterviewAccessPolicyService

    service = new MeetingRecorderService(
      dbService,
      {} as MeetingRecorderSecretCryptoService,
      new MeetingRecorderMatcher(),
      interviewAccess,
    )
  }, 20_000)

  afterAll(async () => {
    if (!pool) return
    await cleanup()
    await pool.end()
  }, 20_000)

  it('matches, deduplicates, preserves a manual link, and refuses revision downgrade', async () => {
    await service.ingestWebhookEvent(CONNECTION_ID, TEST_FIXTURE, CIPHERTEXT)
    const verifiedConnection = await pool.query<{
      expected_source: string | null
      last_verified_at: Date | null
    }>(
      `SELECT expected_source, last_verified_at
       FROM meeting_recorder_connections
       WHERE id = $1`,
      [CONNECTION_ID],
    )
    expect(verifiedConnection.rows[0]?.expected_source).toBe(TEST_FIXTURE.source)
    expect(verifiedConnection.rows[0]?.last_verified_at).toBeInstanceOf(Date)

    await service.ingestWebhookEvent(CONNECTION_ID, READY_FIXTURE, CIPHERTEXT)

    const matched = await pool.query<{
      id: string
      interview_id: string | null
      revision: string
      matched_by: string
    }>(
      `SELECT id, interview_id, revision, matched_by
       FROM interview_recordings
       WHERE connection_id = $1 AND external_recording_id = $2`,
      [CONNECTION_ID, MATCH_RECORDING_ID],
    )
    expect(matched.rows).toHaveLength(1)
    expect(matched.rows[0]).toEqual(
      expect.objectContaining({
        interview_id: MATCH_INTERVIEW_ID,
        revision: '1',
        matched_by: 'meeting-id',
      }),
    )

    await service.ingestWebhookEvent(CONNECTION_ID, READY_FIXTURE, CIPHERTEXT)
    const duplicateCounts = await pool.query<{ receipts: string; recordings: string }>(
      `SELECT
         (SELECT count(*) FROM meeting_recorder_webhook_receipts WHERE connection_id = $1 AND webhook_id = $3) AS receipts,
         (SELECT count(*) FROM interview_recordings WHERE connection_id = $1 AND external_recording_id = $2) AS recordings`,
      [CONNECTION_ID, MATCH_RECORDING_ID, READY_FIXTURE.id],
    )
    expect(duplicateCounts.rows[0]).toEqual({ receipts: '1', recordings: '1' })

    const unmatchedReady = structuredClone(READY_FIXTURE)
    unmatchedReady.id = 'event_contract_unmatched_ready_v1'
    unmatchedReady.subject = `recording/${UNMATCHED_RECORDING_ID}`
    unmatchedReady.data.recording.id = UNMATCHED_RECORDING_ID
    unmatchedReady.data.recording.source.meetingId = 'not-in-crm'
    unmatchedReady.data.recording.source.meetingUrl = 'https://meet.google.com/not-in-crm'
    await service.ingestWebhookEvent(CONNECTION_ID, unmatchedReady, CIPHERTEXT)

    const unmatched = await pool.query<{
      id: string
      interview_id: string | null
      matched_by: string
    }>(
      `SELECT id, interview_id, matched_by
       FROM interview_recordings
       WHERE connection_id = $1 AND external_recording_id = $2`,
      [CONNECTION_ID, UNMATCHED_RECORDING_ID],
    )
    expect(unmatched.rows).toHaveLength(1)
    expect(unmatched.rows[0]).toEqual(
      expect.objectContaining({ interview_id: null, matched_by: 'unmatched' }),
    )
    const rowId = unmatched.rows[0]!.id

    await service.linkRecording(rowId, { interviewId: MANUAL_INTERVIEW_ID }, ADMIN)

    const updated = structuredClone(UPDATED_FIXTURE)
    updated.id = 'event_contract_unmatched_updated_v2'
    updated.subject = `recording/${UNMATCHED_RECORDING_ID}`
    updated.data.recording.id = UNMATCHED_RECORDING_ID
    updated.data.recording.source.meetingId = 'abc-defg-hij'
    updated.data.recording.source.meetingUrl = 'https://meet.google.com/abc-defg-hij'
    await service.ingestWebhookEvent(CONNECTION_ID, updated, CIPHERTEXT)

    const afterUpdate = await pool.query<{
      id: string
      interview_id: string | null
      revision: string
      matched_by: string
      linked_by_user_id: string | null
    }>(
      `SELECT id, interview_id, revision, matched_by, linked_by_user_id
       FROM interview_recordings
       WHERE connection_id = $1 AND external_recording_id = $2`,
      [CONNECTION_ID, UNMATCHED_RECORDING_ID],
    )
    expect(afterUpdate.rows).toEqual([
      {
        id: rowId,
        interview_id: MANUAL_INTERVIEW_ID,
        revision: '2',
        matched_by: 'manual',
        linked_by_user_id: USER_ID,
      },
    ])

    await service.linkRecording(rowId, { interviewId: null }, ADMIN)

    const afterUnlinkUpdate = structuredClone(UPDATED_FIXTURE)
    afterUnlinkUpdate.id = 'event_contract_unmatched_updated_v3'
    afterUnlinkUpdate.subject = `recording/${UNMATCHED_RECORDING_ID}`
    afterUnlinkUpdate.data.revision = 3
    afterUnlinkUpdate.data.recording.id = UNMATCHED_RECORDING_ID
    afterUnlinkUpdate.data.recording.source.meetingId = 'abc-defg-hij'
    afterUnlinkUpdate.data.recording.source.meetingUrl = 'https://meet.google.com/abc-defg-hij'
    await service.ingestWebhookEvent(CONNECTION_ID, afterUnlinkUpdate, CIPHERTEXT)

    const afterManualUnlink = await pool.query<{
      interview_id: string | null
      revision: string
      matched_by: string
      auto_match_suppressed: boolean
    }>(
      `SELECT interview_id, revision, matched_by, auto_match_suppressed
       FROM interview_recordings
       WHERE connection_id = $1 AND external_recording_id = $2`,
      [CONNECTION_ID, UNMATCHED_RECORDING_ID],
    )
    expect(afterManualUnlink.rows).toEqual([
      {
        interview_id: null,
        revision: '3',
        matched_by: 'unmatched',
        auto_match_suppressed: true,
      },
    ])

    const lateRevisionOne = structuredClone(unmatchedReady)
    lateRevisionOne.id = 'event_contract_unmatched_late_v1'
    lateRevisionOne.time = '2026-10-07T12:03:00.000Z'
    await service.ingestWebhookEvent(CONNECTION_ID, lateRevisionOne, CIPHERTEXT)

    const finalState = await pool.query<{
      id: string
      interview_id: string | null
      revision: string
      matched_by: string
    }>(
      `SELECT id, interview_id, revision, matched_by
       FROM interview_recordings
       WHERE connection_id = $1 AND external_recording_id = $2`,
      [CONNECTION_ID, UNMATCHED_RECORDING_ID],
    )
    expect(finalState.rows).toEqual([
      {
        id: rowId,
        interview_id: null,
        revision: '3',
        matched_by: 'unmatched',
      },
    ])

    const boundaryId = 'r'.repeat(MEETING_RECORDER_INDEXED_IDENTIFIER_MAX_CHARS)
    const boundaryMeetingId = 'm'.repeat(MEETING_RECORDER_INDEXED_IDENTIFIER_MAX_CHARS)
    const boundaryEvent = structuredClone(READY_FIXTURE)
    boundaryEvent.id = 'e'.repeat(MEETING_RECORDER_INDEXED_IDENTIFIER_MAX_CHARS)
    boundaryEvent.subject = `recording/${boundaryId}`
    boundaryEvent.data.recording.id = boundaryId
    boundaryEvent.data.recording.source.meetingId = boundaryMeetingId
    delete boundaryEvent.data.recording.source.meetingUrl
    await service.ingestWebhookEvent(CONNECTION_ID, boundaryEvent, CIPHERTEXT)

    const boundaryRow = await pool.query<{
      external_recording_id: string
      meeting_id: string | null
    }>(
      `SELECT external_recording_id, meeting_id
       FROM interview_recordings
       WHERE connection_id = $1 AND external_recording_id = $2`,
      [CONNECTION_ID, boundaryId],
    )
    expect(boundaryRow.rows).toEqual([
      { external_recording_id: boundaryId, meeting_id: boundaryMeetingId },
    ])
  }, 20_000)
})
