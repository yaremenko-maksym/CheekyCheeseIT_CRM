import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'

import {
  interviewRecordings,
  interviews,
  meetingRecorderAuditLog,
  meetingRecorderConnections,
  meetingRecorderWebhookReceipts,
  users,
} from './schema'

const migration = readFileSync(
  join(__dirname, '../../drizzle/manual/2026-10-07_meeting_recorder_integration.sql'),
  'utf8',
)

function fkFor(table: Parameters<typeof getTableConfig>[0], columnName: string) {
  return getTableConfig(table).foreignKeys.find((fk) =>
    fk.reference().columns.some((column) => column.name === columnName),
  )
}

function normalizedSql(value: Parameters<PgDialect['sqlToQuery']>[0]): string {
  return new PgDialect().sqlToQuery(value).sql.replace(/"/g, '').replace(/\s+/g, ' ').trim()
}

describe('meeting recorder database foundation', () => {
  it('keeps connection pairing fields nullable and created_by audit ownership nullable/set-null', () => {
    const config = getTableConfig(meetingRecorderConnections)
    const column = (name: string) => config.columns.find((item) => item.name === name)!

    expect(config.name).toBe('meeting_recorder_connections')
    expect(column('signing_secret_ciphertext').notNull).toBe(false)
    expect(column('expected_source').notNull).toBe(false)
    expect(column('signing_secret_updated_at').notNull).toBe(false)
    expect(column('created_by').notNull).toBe(false)

    const createdByFk = fkFor(meetingRecorderConnections, 'created_by')
    expect(createdByFk?.reference().foreignTable).toBe(users)
    expect(createdByFk?.onDelete).toBe('set null')
  })

  it('pins receipt idempotency and the 30-day-prune lookup index', () => {
    const config = getTableConfig(meetingRecorderWebhookReceipts)
    const unique = config.indexes.find(
      (item) => item.config.name === 'uq_meeting_recorder_webhook_receipts_connection_webhook',
    )
    const received = config.indexes.find(
      (item) => item.config.name === 'idx_meeting_recorder_webhook_receipts_received_at',
    )

    expect(unique?.config.unique).toBe(true)
    expect(unique?.config.columns.map((column) => (column as { name?: string }).name)).toEqual([
      'connection_id',
      'webhook_id',
    ])
    expect(received).toBeDefined()
  })

  it('preserves recording link/delete semantics, revision guard, sender text columns, and unmatched index', () => {
    const config = getTableConfig(interviewRecordings)
    const column = (name: string) => config.columns.find((item) => item.name === name)!

    expect(fkFor(interviewRecordings, 'interview_id')?.reference().foreignTable).toBe(interviews)
    expect(fkFor(interviewRecordings, 'interview_id')?.onDelete).toBe('set null')
    expect(fkFor(interviewRecordings, 'connection_id')?.reference().foreignTable).toBe(
      meetingRecorderConnections,
    )
    expect(fkFor(interviewRecordings, 'connection_id')?.onDelete).toBe('restrict')
    expect(fkFor(interviewRecordings, 'linked_by_user_id')?.onDelete).toBe('set null')

    for (const name of [
      'external_recording_id',
      'source',
      'title',
      'provider',
      'meeting_id',
      'meeting_url',
      'matched_by',
    ]) {
      expect(column(name).getSQLType()).toBe('text')
    }

    expect(column('revision').getSQLType()).toBe('bigint')
    expect(column('duration_ms').getSQLType()).toBe('double precision')

    const unmatched = config.indexes.find(
      (item) => item.config.name === 'idx_interview_recordings_unmatched_created_at',
    )
    expect(unmatched).toBeDefined()
    expect(normalizedSql(unmatched!.config.where!)).toContain(
      'interview_recordings.interview_id is null',
    )

    const revisionCheck = config.checks.find(
      (item) => item.name === 'ck_interview_recordings_revision_positive',
    )
    expect(normalizedSql(revisionCheck!.value)).toContain('interview_recordings.revision > 0')
  })

  it('keeps the audit table metadata-only and retains rows when referenced entities disappear', () => {
    const config = getTableConfig(meetingRecorderAuditLog)
    expect(config.columns.map((column) => column.name)).toEqual([
      'id',
      'action',
      'actor_user_id',
      'connection_id',
      'interview_recording_id',
      'created_at',
    ])
    expect(fkFor(meetingRecorderAuditLog, 'actor_user_id')?.onDelete).toBe('set null')
    expect(fkFor(meetingRecorderAuditLog, 'connection_id')?.onDelete).toBe('set null')
    expect(fkFor(meetingRecorderAuditLog, 'interview_recording_id')?.onDelete).toBe('set null')
  })

  it('keeps the manual migration idempotent and aligned with Drizzle names/invariants', () => {
    const tables = [
      meetingRecorderConnections,
      meetingRecorderWebhookReceipts,
      interviewRecordings,
      meetingRecorderAuditLog,
    ]

    for (const table of tables) {
      const config = getTableConfig(table)
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS ${config.name}`)
      for (const column of config.columns) expect(migration).toContain(column.name)
      for (const index of config.indexes) expect(migration).toContain(index.config.name)
      for (const constraint of config.checks) expect(migration).toContain(constraint.name)
    }

    expect(migration).toMatch(/created_by\s+uuid REFERENCES users\(id\) ON DELETE SET NULL/i)
    expect(migration).toMatch(
      /connection_id\s+uuid NOT NULL REFERENCES meeting_recorder_connections\(id\) ON DELETE RESTRICT/i,
    )
    expect(migration).toMatch(/WHERE interview_id IS NULL/i)
    expect(migration).toMatch(/revision\s+bigint NOT NULL/i)
    expect(migration).toMatch(/duration_ms\s+double precision/i)
    expect(migration).not.toMatch(/CREATE (?:UNIQUE )?INDEX (?!IF NOT EXISTS)/i)
  })
})
