/**
 * Interviews and the meeting-recorder integration tables.
 */
import { isNull, relations, sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { interviewStageEnum } from './enums'
import { projects } from './projects'
import { users } from './users'

// ---------------------------------------------------------------------------
// Interviews
// ---------------------------------------------------------------------------

export const interviews = pgTable(
  'interviews',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    seniorId: uuid('senior_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    hrId: uuid('hr_id').references(() => users.id, { onDelete: 'set null' }),
    companyName: varchar('company_name', { length: 255 }).notNull(),
    vacancyUrl: varchar('vacancy_url', { length: 1000 }),
    callUrl: varchar('call_url', { length: 1000 }),
    stage: interviewStageEnum().notNull().default('HR_SCREEN'),
    notesDomain: varchar('notes_domain', { length: 255 }),
    notesTechStack: varchar('notes_tech_stack', { length: 500 }),
    notesTeamSize: varchar('notes_team_size', { length: 100 }),
    notesBenefits: varchar('notes_benefits', { length: 500 }),
    notesPaymentType: varchar('notes_payment_type', { length: 100 }),
    notesSalaryReview: varchar('notes_salary_review', { length: 255 }),
    notesCorpTech: varchar('notes_corp_tech', { length: 255 }),
    notesGeneral: varchar('notes_general', { length: 1000 }),
    position: integer('position').notNull().default(0),
    /**
     * BIZ-07: idempotency guard for HIRED → auto-project creation.
     * Set to the project.id the first time this interview is moved to HIRED.
     * On subsequent HIRED transitions the service checks this field and skips
     * createFromInterview, preventing duplicate projects / project_members.
     *
     * Partial unique index (WHERE created_project_id IS NOT NULL) is the
     * DB-level backstop: even a concurrent race cannot insert a second non-null
     * value for the same interview row because the index enforces uniqueness
     * across the entire table (not just per-interview — effectively each row
     * is unique by PK, so the partial index catches any attempt to set two
     * different project ids via concurrent transactions).
     *
     * ADD COLUMN DDL (apply to dev/prod manually before deploy):
     *   ALTER TABLE interviews ADD COLUMN created_project_id uuid;
     *   CREATE UNIQUE INDEX uq_interviews_created_project_id
     *     ON interviews (created_project_id)
     *     WHERE created_project_id IS NOT NULL;
     */
    createdProjectId: uuid('created_project_id').references(() => projects.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // BIZ-07: partial unique index — each created project can be linked to at
    // most one interview. Prevents duplicate project creation on repeated HIRED.
    uniqueIndex('uq_interviews_created_project_id')
      .on(t.createdProjectId)
      .where(sql`${t.createdProjectId} IS NOT NULL`),
  ],
)

export type InterviewRecordingMatchedBy = 'meeting-id' | 'meeting-url' | 'manual' | 'unmatched'

export type MeetingRecorderAuditAction =
  | 'connection-created'
  | 'connection-renamed'
  | 'connection-enabled'
  | 'connection-disabled'
  | 'secret-replaced'
  | 'token-issued'
  | 'pairing-reset'
  | 'recording-linked'
  | 'recording-unlinked'
  | 'recording-purged'
  | 'media-purged'

export const meetingRecorderConnections = pgTable('meeting_recorder_connections', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  signingSecretCiphertext: text('signing_secret_ciphertext'),
  expectedSource: text('expected_source'),
  signingSecretUpdatedAt: timestamp('signing_secret_updated_at', { withTimezone: true }),
  lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
  lastEventAt: timestamp('last_event_at', { withTimezone: true }),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

export const meetingRecorderWebhookReceipts = pgTable(
  'meeting_recorder_webhook_receipts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => meetingRecorderConnections.id, { onDelete: 'cascade' }),
    webhookId: text('webhook_id').notNull(),
    eventType: text('event_type').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('uq_meeting_recorder_webhook_receipts_connection_webhook').on(
      t.connectionId,
      t.webhookId,
    ),
    index('idx_meeting_recorder_webhook_receipts_received_at').on(t.receivedAt),
  ],
)

export const interviewRecordings = pgTable(
  'interview_recordings',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    interviewId: uuid('interview_id').references(() => interviews.id, { onDelete: 'set null' }),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => meetingRecorderConnections.id, { onDelete: 'restrict' }),
    externalRecordingId: text('external_recording_id').notNull(),
    revision: bigint('revision', { mode: 'number' }).notNull(),
    source: text('source').notNull(),
    title: text('title').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    durationMs: doublePrecision('duration_ms'),
    provider: text('provider'),
    meetingId: text('meeting_id'),
    meetingUrl: text('meeting_url'),
    stageAtLink: interviewStageEnum('stage_at_link'),
    matchedBy: text('matched_by')
      .$type<InterviewRecordingMatchedBy>()
      .notNull()
      .default('unmatched'),
    autoMatchSuppressed: boolean('auto_match_suppressed').notNull().default(false),
    readiness: jsonb('readiness').notNull(),
    snapshot: jsonb('snapshot').notNull(),
    linkedByUserId: uuid('linked_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    linkedAt: timestamp('linked_at', { withTimezone: true }),
    lastEventAt: timestamp('last_event_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('uq_interview_recordings_connection_external').on(
      t.connectionId,
      t.externalRecordingId,
    ),
    index('idx_interview_recordings_interview').on(t.interviewId),
    index('idx_interview_recordings_connection').on(t.connectionId),
    index('idx_interview_recordings_meeting_id').on(t.meetingId),
    index('idx_interview_recordings_started_at').on(t.startedAt),
    index('idx_interview_recordings_unmatched_created_at')
      .on(t.createdAt.desc())
      .where(isNull(t.interviewId)),
    check('ck_interview_recordings_revision_positive', sql`${t.revision} > 0`),
    check(
      'ck_interview_recordings_matched_by',
      sql`${t.matchedBy} IN ('meeting-id', 'meeting-url', 'manual', 'unmatched')`,
    ),
  ],
)

export const meetingRecorderAuditLog = pgTable(
  'meeting_recorder_audit_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    action: text('action').$type<MeetingRecorderAuditAction>().notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    connectionId: uuid('connection_id').references(() => meetingRecorderConnections.id, {
      onDelete: 'set null',
    }),
    interviewRecordingId: uuid('interview_recording_id').references(() => interviewRecordings.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('idx_meeting_recorder_audit_log_created_at').on(t.createdAt),
    index('idx_meeting_recorder_audit_log_connection').on(t.connectionId),
    index('idx_meeting_recorder_audit_log_recording').on(t.interviewRecordingId),
    check(
      'ck_meeting_recorder_audit_log_action',
      sql`${t.action} IN ('connection-created', 'connection-renamed', 'connection-enabled', 'connection-disabled', 'secret-replaced', 'token-issued', 'pairing-reset', 'recording-linked', 'recording-unlinked', 'recording-purged', 'media-purged')`,
    ),
  ],
)

export const interviewsRelations = relations(interviews, ({ one, many }) => ({
  senior: one(users, {
    fields: [interviews.seniorId],
    references: [users.id],
    relationName: 'seniorInterviews',
  }),
  hr: one(users, {
    fields: [interviews.hrId],
    references: [users.id],
    relationName: 'hrInterviews',
  }),
  recordings: many(interviewRecordings),
}))

export const meetingRecorderConnectionsRelations = relations(
  meetingRecorderConnections,
  ({ one, many }) => ({
    creator: one(users, {
      fields: [meetingRecorderConnections.createdBy],
      references: [users.id],
      relationName: 'meetingRecorderConnectionCreator',
    }),
    receipts: many(meetingRecorderWebhookReceipts),
    recordings: many(interviewRecordings),
    auditEntries: many(meetingRecorderAuditLog),
  }),
)

export const meetingRecorderWebhookReceiptsRelations = relations(
  meetingRecorderWebhookReceipts,
  ({ one }) => ({
    connection: one(meetingRecorderConnections, {
      fields: [meetingRecorderWebhookReceipts.connectionId],
      references: [meetingRecorderConnections.id],
    }),
  }),
)

export const interviewRecordingsRelations = relations(interviewRecordings, ({ one, many }) => ({
  interview: one(interviews, {
    fields: [interviewRecordings.interviewId],
    references: [interviews.id],
  }),
  connection: one(meetingRecorderConnections, {
    fields: [interviewRecordings.connectionId],
    references: [meetingRecorderConnections.id],
  }),
  linkedByUser: one(users, {
    fields: [interviewRecordings.linkedByUserId],
    references: [users.id],
    relationName: 'interviewRecordingLinker',
  }),
  auditEntries: many(meetingRecorderAuditLog),
}))

export const meetingRecorderAuditLogRelations = relations(meetingRecorderAuditLog, ({ one }) => ({
  actor: one(users, {
    fields: [meetingRecorderAuditLog.actorUserId],
    references: [users.id],
    relationName: 'meetingRecorderAuditActor',
  }),
  connection: one(meetingRecorderConnections, {
    fields: [meetingRecorderAuditLog.connectionId],
    references: [meetingRecorderConnections.id],
  }),
  recording: one(interviewRecordings, {
    fields: [meetingRecorderAuditLog.interviewRecordingId],
    references: [interviewRecordings.id],
  }),
}))

export type Interview = typeof interviews.$inferSelect

export type NewInterview = typeof interviews.$inferInsert

export type MeetingRecorderConnection = typeof meetingRecorderConnections.$inferSelect

export type NewMeetingRecorderConnection = typeof meetingRecorderConnections.$inferInsert

export type MeetingRecorderWebhookReceipt = typeof meetingRecorderWebhookReceipts.$inferSelect

export type NewMeetingRecorderWebhookReceipt = typeof meetingRecorderWebhookReceipts.$inferInsert

export type InterviewRecording = typeof interviewRecordings.$inferSelect

export type NewInterviewRecording = typeof interviewRecordings.$inferInsert

export type MeetingRecorderAuditLogEntry = typeof meetingRecorderAuditLog.$inferSelect

export type NewMeetingRecorderAuditLogEntry = typeof meetingRecorderAuditLog.$inferInsert
