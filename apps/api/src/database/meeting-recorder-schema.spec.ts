import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core'
import {
  One,
  createTableRelationsHelpers,
  extractTablesRelationalConfig,
  type Relation,
} from 'drizzle-orm/relations'
import { describe, expect, it } from 'vitest'

import {
  interviewRecordings,
  interviewRecordingsRelations,
  interviews,
  interviewsRelations,
  meetingRecorderAuditLog,
  meetingRecorderAuditLogRelations,
  meetingRecorderConnections,
  meetingRecorderConnectionsRelations,
  meetingRecorderWebhookReceipts,
  meetingRecorderWebhookReceiptsRelations,
  recordingMediaArtifacts,
  recordingMediaUploads,
  users,
  usersRelations,
} from './schema'

const phase1Migration = readFileSync(
  join(__dirname, '../../drizzle/manual/2026-10-07_meeting_recorder_integration.sql'),
  'utf8',
)
const mediaMigration = readFileSync(
  join(__dirname, '../../drizzle/manual/2026-10-08_meeting_recorder_media.sql'),
  'utf8',
)
const migration = `${phase1Migration}\n${mediaMigration}`

function fkFor(table: Parameters<typeof getTableConfig>[0], columnName: string) {
  return getTableConfig(table).foreignKeys.find((fk) =>
    fk.reference().columns.some((column) => column.name === columnName),
  )
}

function normalizedSql(value: Parameters<PgDialect['sqlToQuery']>[0]): string {
  return new PgDialect().sqlToQuery(value).sql.replace(/"/g, '').replace(/\s+/g, ' ').trim()
}

const relationalConfig = extractTablesRelationalConfig(
  {
    users,
    usersRelations,
    interviews,
    interviewsRelations,
    meetingRecorderConnections,
    meetingRecorderConnectionsRelations,
    meetingRecorderWebhookReceipts,
    meetingRecorderWebhookReceiptsRelations,
    interviewRecordings,
    interviewRecordingsRelations,
    meetingRecorderAuditLog,
    meetingRecorderAuditLogRelations,
  },
  createTableRelationsHelpers,
).tables

function relationShape(relation: Relation) {
  const oneConfig = relation instanceof One ? relation.config : undefined
  return {
    referencedTable: relation.referencedTableName,
    relationName: relation.relationName,
    fields: oneConfig?.fields.map((column) => column.name) ?? [],
    references: oneConfig?.references.map((column) => column.name) ?? [],
  }
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

    expect(config.indexes.map((item) => item.config.name)).toEqual([
      'uq_interview_recordings_connection_external',
      'idx_interview_recordings_interview',
      'idx_interview_recordings_connection',
      'idx_interview_recordings_meeting_id',
      'idx_interview_recordings_started_at',
      'idx_interview_recordings_unmatched_created_at',
    ])

    const matchedByCheck = config.checks.find(
      (item) => item.name === 'ck_interview_recordings_matched_by',
    )
    expect(normalizedSql(matchedByCheck!.value)).toContain(
      "interview_recordings.matched_by IN ('meeting-id', 'meeting-url', 'manual', 'unmatched')",
    )
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

    expect(config.indexes.map((item) => item.config.name)).toEqual([
      'idx_meeting_recorder_audit_log_created_at',
      'idx_meeting_recorder_audit_log_connection',
      'idx_meeting_recorder_audit_log_recording',
    ])
    expect(config.checks.map((item) => item.name)).toEqual(['ck_meeting_recorder_audit_log_action'])
    expect(normalizedSql(config.checks[0]!.value)).toContain(
      "meeting_recorder_audit_log.action IN ('connection-created', 'connection-renamed', 'connection-enabled', 'connection-disabled', 'secret-replaced', 'token-issued', 'pairing-reset', 'recording-linked', 'recording-unlinked', 'recording-purged', 'media-purged')",
    )
  })

  it('pins the meeting-recorder relation graph used by Drizzle relational queries', () => {
    expect(
      relationShape(relationalConfig.users!.relations.createdMeetingRecorderConnections!),
    ).toEqual({
      referencedTable: 'meeting_recorder_connections',
      relationName: 'meetingRecorderConnectionCreator',
      fields: [],
      references: [],
    })
    expect(relationShape(relationalConfig.users!.relations.linkedInterviewRecordings!)).toEqual({
      referencedTable: 'interview_recordings',
      relationName: 'interviewRecordingLinker',
      fields: [],
      references: [],
    })
    expect(relationShape(relationalConfig.users!.relations.meetingRecorderAuditEntries!)).toEqual({
      referencedTable: 'meeting_recorder_audit_log',
      relationName: 'meetingRecorderAuditActor',
      fields: [],
      references: [],
    })

    expect(relationShape(relationalConfig.interviews!.relations.recordings!)).toEqual({
      referencedTable: 'interview_recordings',
      relationName: undefined,
      fields: [],
      references: [],
    })

    expect(relationShape(relationalConfig.meetingRecorderConnections!.relations.creator!)).toEqual({
      referencedTable: 'users',
      relationName: 'meetingRecorderConnectionCreator',
      fields: ['created_by'],
      references: ['id'],
    })
    expect(relationShape(relationalConfig.meetingRecorderConnections!.relations.receipts!)).toEqual(
      {
        referencedTable: 'meeting_recorder_webhook_receipts',
        relationName: undefined,
        fields: [],
        references: [],
      },
    )
    expect(
      relationShape(relationalConfig.meetingRecorderConnections!.relations.recordings!),
    ).toEqual({
      referencedTable: 'interview_recordings',
      relationName: undefined,
      fields: [],
      references: [],
    })
    expect(
      relationShape(relationalConfig.meetingRecorderConnections!.relations.auditEntries!),
    ).toEqual({
      referencedTable: 'meeting_recorder_audit_log',
      relationName: undefined,
      fields: [],
      references: [],
    })

    expect(
      relationShape(relationalConfig.meetingRecorderWebhookReceipts!.relations.connection!),
    ).toEqual({
      referencedTable: 'meeting_recorder_connections',
      relationName: undefined,
      fields: ['connection_id'],
      references: ['id'],
    })

    expect(relationShape(relationalConfig.interviewRecordings!.relations.interview!)).toEqual({
      referencedTable: 'interviews',
      relationName: undefined,
      fields: ['interview_id'],
      references: ['id'],
    })
    expect(relationShape(relationalConfig.interviewRecordings!.relations.connection!)).toEqual({
      referencedTable: 'meeting_recorder_connections',
      relationName: undefined,
      fields: ['connection_id'],
      references: ['id'],
    })
    expect(relationShape(relationalConfig.interviewRecordings!.relations.linkedByUser!)).toEqual({
      referencedTable: 'users',
      relationName: 'interviewRecordingLinker',
      fields: ['linked_by_user_id'],
      references: ['id'],
    })
    expect(relationShape(relationalConfig.interviewRecordings!.relations.auditEntries!)).toEqual({
      referencedTable: 'meeting_recorder_audit_log',
      relationName: undefined,
      fields: [],
      references: [],
    })

    expect(relationShape(relationalConfig.meetingRecorderAuditLog!.relations.actor!)).toEqual({
      referencedTable: 'users',
      relationName: 'meetingRecorderAuditActor',
      fields: ['actor_user_id'],
      references: ['id'],
    })
    expect(relationShape(relationalConfig.meetingRecorderAuditLog!.relations.connection!)).toEqual({
      referencedTable: 'meeting_recorder_connections',
      relationName: undefined,
      fields: ['connection_id'],
      references: ['id'],
    })
    expect(relationShape(relationalConfig.meetingRecorderAuditLog!.relations.recording!)).toEqual({
      referencedTable: 'interview_recordings',
      relationName: undefined,
      fields: ['interview_recording_id'],
      references: ['id'],
    })
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

  it('pins the additive media migration chain, foreign keys and transfer uniqueness', () => {
    expect(phase1Migration).toContain('CREATE TABLE IF NOT EXISTS meeting_recorder_connections')
    expect(phase1Migration).not.toContain('recording_media_artifacts')
    expect(mediaMigration).toMatch(
      /ALTER TABLE meeting_recorder_connections\s+ADD COLUMN IF NOT EXISTS media_token_hash text,\s+ADD COLUMN IF NOT EXISTS media_token_updated_at timestamptz/i,
    )
    expect(mediaMigration).toMatch(/CREATE TABLE IF NOT EXISTS recording_media_artifacts/i)
    expect(mediaMigration).toMatch(/CREATE TABLE IF NOT EXISTS recording_media_uploads/i)
    expect(mediaMigration).not.toMatch(/CREATE (?:UNIQUE )?INDEX (?!IF NOT EXISTS)/i)

    const connection = getTableConfig(meetingRecorderConnections)
    for (const name of ['media_token_hash', 'media_token_updated_at']) {
      expect(connection.columns.find((column) => column.name === name)?.notNull).toBe(false)
      expect(mediaMigration).toContain(name)
    }

    for (const table of [recordingMediaArtifacts, recordingMediaUploads]) {
      const config = getTableConfig(table)
      expect(mediaMigration).toContain(`CREATE TABLE IF NOT EXISTS ${config.name}`)
      for (const column of config.columns) expect(mediaMigration).toContain(column.name)
      for (const index of config.indexes) expect(mediaMigration).toContain(index.config.name)
      for (const constraint of config.checks) expect(mediaMigration).toContain(constraint.name)
    }

    const artifacts = getTableConfig(recordingMediaArtifacts)
    const transferIndex = artifacts.indexes.find(
      (index) => index.config.name === 'uq_recording_media_artifact_connection_transfer',
    )
    expect(transferIndex?.config.unique).toBe(true)
    expect(
      transferIndex?.config.columns.map((column) => (column as { name?: string }).name),
    ).toEqual(['connection_id', 'client_transfer_id'])
    expect(fkFor(recordingMediaArtifacts, 'connection_id')?.onDelete).toBe('restrict')
    expect(fkFor(recordingMediaArtifacts, 'connection_id')?.reference().foreignTable).toBe(
      meetingRecorderConnections,
    )
    expect(fkFor(recordingMediaUploads, 'artifact_id')?.onDelete).toBe('cascade')
    expect(fkFor(recordingMediaUploads, 'artifact_id')?.reference().foreignTable).toBe(
      recordingMediaArtifacts,
    )
    expect(mediaMigration).toMatch(/CHECK \(bytes > 0\)/i)
    expect(mediaMigration).toMatch(/CHECK \(part_size BETWEEN 5242880 AND 268435456\)/i)
    expect(mediaMigration).toMatch(
      /CHECK \(status IN \('uploading', 'completing', 'ready', 'failed'\)\)/i,
    )
    expect(mediaMigration).toMatch(
      /CHECK \(status IN \('uploading', 'completing', 'ready', 'expired', 'aborted'\)\)/i,
    )
  })
})
