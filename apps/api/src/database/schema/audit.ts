/**
 * Append-only audit logs (user / team / project / transaction / document access).
 */
import { relations } from 'drizzle-orm'
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { projects } from './projects'
import { teams, users } from './users'

// ---------------------------------------------------------------------------
// User Audit Log
// ---------------------------------------------------------------------------

export const userAuditLog = pgTable(
  'user_audit_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    targetId: uuid('target_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    action: text('action').notNull(),
    changes: jsonb('changes').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('user_audit_log_target_id_idx').on(t.targetId)],
)

// ---------------------------------------------------------------------------
// Team Audit Log — mirrors user_audit_log shape but targets teams.
// ---------------------------------------------------------------------------

export const teamAuditLog = pgTable(
  'team_audit_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    targetId: uuid('target_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    action: text('action').notNull(),
    changes: jsonb('changes').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('team_audit_log_target_id_idx').on(t.targetId),
    index('team_audit_log_created_at_idx').on(t.createdAt),
  ],
)

// ---------------------------------------------------------------------------
// Project Audit Log — mirrors user_audit_log shape but targets projects.
// ---------------------------------------------------------------------------

export const projectAuditLog = pgTable(
  'project_audit_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    targetId: uuid('target_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    action: text('action').notNull(),
    changes: jsonb('changes').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('project_audit_log_target_id_idx').on(t.targetId),
    index('project_audit_log_created_at_idx').on(t.createdAt),
  ],
)

// ---------------------------------------------------------------------------
// Transaction Audit Log — task-receipts-backend. Records receipt attach/replace
// mutations made through the generic PATCH /transactions/:id/receipt endpoint.
//
// Unlike the other *_audit_log tables, targetId is NOT an FK-cascade to
// transactions: an audit trail must OUTLIVE the row it describes (deleting a
// transaction must not erase the record that a receipt was attached/replaced on
// it). actorId → users with ON DELETE SET NULL (keep the audit if the actor is
// removed). action is a plain text discriminator ('ATTACH' | 'REPLACE').
// ---------------------------------------------------------------------------

export const transactionAuditLog = pgTable(
  'transaction_audit_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    // transactions.id — intentionally NO FK reference (audit survives tx delete).
    targetId: uuid('target_id').notNull(),
    action: text('action').notNull(),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('transaction_audit_log_target_id_idx').on(t.targetId),
    index('transaction_audit_log_created_at_idx').on(t.createdAt),
  ],
)

// ---------------------------------------------------------------------------
// Document Access Log — task-file-storage-hardening §7. Mirrors
// transaction_audit_log's shape (no FK-cascade to the referenced row — a
// scan/resume can be hard-deleted or retention-purged and the access trail
// must outlive it). Records WHO fetched a presigned download/preview link
// for a sensitive document (RESUME/SCAN from `documents`, or a vacancy
// application resume) and WHEN — never the URL itself (`metadata` only
// carries the category + a source discriminator). Answers "who downloaded
// this scan" after the fact; write-only from the app's perspective in this
// PR (no read endpoint — an ADMIN can query the table directly for now).
//
// MED-5 (security-review round 1): `actor_id` index added — "who accessed
// what" queries filter by actor at least as often as by target ("what did
// this person download") — and a 365-day retention purge is wired via
// `DocumentAccessLogRetentionCronService` (apps/api/src/documents/
// document-access-log-retention.cron.ts). No OTHER *_audit_log table in this
// schema (user/team/project/transaction) has a retention cron either — this
// is a new, project-local precedent, not a gap relative to an existing
// pattern; 365 days is a reasoned default (audit trails conventionally
// outlive the PII they describe) documented in that cron's own file header,
// not an owner-mandated figure — revisit if the owner wants a different window.
// ---------------------------------------------------------------------------

export const documentAccessLog = pgTable(
  'document_access_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    // documents.id OR vacancy_applications.id — intentionally NO FK
    // reference, same rationale as transaction_audit_log.targetId.
    targetId: uuid('target_id').notNull(),
    action: text('action').notNull(), // 'DOWNLOAD' | 'PREVIEW' | 'THUMBNAIL'
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('document_access_log_target_id_idx').on(t.targetId),
    index('document_access_log_actor_id_idx').on(t.actorId),
    index('document_access_log_created_at_idx').on(t.createdAt),
  ],
)

export const userAuditLogRelations = relations(userAuditLog, ({ one }) => ({
  actor: one(users, {
    fields: [userAuditLog.actorId],
    references: [users.id],
    relationName: 'auditLogAsActor',
  }),
  target: one(users, {
    fields: [userAuditLog.targetId],
    references: [users.id],
    relationName: 'auditLogAsTarget',
  }),
}))

export const teamAuditLogRelations = relations(teamAuditLog, ({ one }) => ({
  actor: one(users, { fields: [teamAuditLog.actorId], references: [users.id] }),
  target: one(teams, { fields: [teamAuditLog.targetId], references: [teams.id] }),
}))

export const projectAuditLogRelations = relations(projectAuditLog, ({ one }) => ({
  actor: one(users, { fields: [projectAuditLog.actorId], references: [users.id] }),
  target: one(projects, { fields: [projectAuditLog.targetId], references: [projects.id] }),
}))

export type UserAuditLogEntry = typeof userAuditLog.$inferSelect

export type NewUserAuditLogEntry = typeof userAuditLog.$inferInsert

export type TeamAuditLogEntry = typeof teamAuditLog.$inferSelect

export type NewTeamAuditLogEntry = typeof teamAuditLog.$inferInsert

export type ProjectAuditLogEntry = typeof projectAuditLog.$inferSelect

export type NewProjectAuditLogEntry = typeof projectAuditLog.$inferInsert
