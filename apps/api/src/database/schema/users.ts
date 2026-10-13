/**
 * Identity: users, their emails/invites, teams and team membership.
 */
import { relations, sql, type SQL } from 'drizzle-orm'
import {
  boolean,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  type AnyPgColumn,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { userAuditLog } from './audit'
import { currencyEnum, paymentMethodEnum, roleEnum, teamTypeEnum, userLocaleEnum } from './enums'
import { payoutRequests } from './finance'
import {
  interviewRecordings,
  interviews,
  meetingRecorderAuditLog,
  meetingRecorderConnections,
} from './interviews'
import { projectMembers, projects } from './projects'
import { transactions } from './transactions'

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  displayName: varchar('display_name', { length: 255 }).notNull(),
  // Google / dicebear fallback URL — used when the user has no custom upload.
  // Renamed from `avatar` in migration 0013 for semantic clarity.
  avatarUrl: varchar('avatar_url', { length: 1000 }),
  // FK to documents (category = AVATAR). When set, takes priority over
  // `avatarUrl` everywhere on the front-end. ON DELETE SET NULL so a hard-
  // deleted document naturally reverts to the Google fallback. The actual
  // FK constraint is declared in migration 0013 — keeping the Drizzle column
  // metadata-only here avoids the circular import with `documents` (defined
  // further down in this file).
  avatarDocumentId: uuid('avatar_document_id'),
  role: roleEnum().notNull().default('JUNIOR'),
  // task-i18n-stage2 (Task 3) — interface language. Every existing user gets
  // 'uk' (default); see the migration file's own header for why nothing is
  // rewritten/backfilled.
  // Stryker disable next-line StringLiteral: the explicit 'locale' name arg
  // is provably unobservable — verified empirically: Drizzle falls back to
  // the JS property key ('locale') whenever the given name is falsy, so
  // mutating this literal to '' produces an IDENTICAL `getTableConfig`
  // column name and cannot be told apart by any unit test (the 'uk' DEFAULT
  // on this same line has no such fallback and IS pinned, by
  // user-locale-schema.spec.ts).
  locale: userLocaleEnum('locale').notNull().default('uk'),
  googleId: varchar('google_id', { length: 255 }).unique(),
  telegram: varchar('telegram', { length: 100 }),
  phone: varchar('phone', { length: 30 }),
  // Tech stack — array of strings (chip-input on frontend)
  techStack: text('tech_stack').array(),
  // Payment requisites
  paymentMethod: paymentMethodEnum('payment_method'),
  walletUsdtErc20: text('wallet_usdt_erc20'),
  walletUsdtLabel: text('wallet_usdt_label'),
  bankUahRecipient: text('bank_uah_recipient'),
  bankUahIban: text('bank_uah_iban'),
  bankUahRnokpp: text('bank_uah_rnokpp'),
  bankUahBankName: text('bank_uah_bank_name'),
  // For SENIOR and ADMIN: percentage they keep from project income (0-100)
  seniorSharePercent: integer('senior_share_percent').notNull().default(26),
  // task-pending-share (position 5 of docs/superpowers/specs/2026-09-01-
  // notifications-and-confirmations-design.md §4.3). A proposed NEW base
  // share % sits here, next to the active column, while the affected SENIOR
  // has not yet confirmed it (see `approvals`, subjectType
  // 'USER_SENIOR_SHARE', subjectId = this user's id). `seniorSharePercent`
  // above is NEVER written while a proposal is live — `UsersService`'s
  // propose helpers write ONLY this column; `approveSeniorShareChange` swaps
  // the two in one transaction, `rejectSeniorShareChange` clears this column
  // and leaves the active one untouched. NULL both when nothing is pending
  // AND is itself a legitimate "clear" outcome is not possible here (the
  // active column is NOT NULL, so there is nothing to "clear" — every
  // proposal carries a concrete percent). "Is something pending" is decided
  // by `ApprovalsService.getStatus()`, never by this column's null-ness
  // alone (see that service's own subject-agnostic status contract).
  // Stryker disable next-line StringLiteral: the SQL column name is a
  // DB-level fact, unobservable from a mocked unit double — a `vi.fn()`
  // select/update chain does not care what string a real Postgres column is
  // named. Any query that selects the whole `users` row against a REAL
  // database would fail loudly ("column does not exist") if this diverged
  // from the migration, which is exactly what
  // `salary-meta.realdb.integration.spec.ts` and
  // `archived-entitlement.realdb.integration.spec.ts` do on every run.
  pendingSeniorSharePercent: integer('pending_senior_share_percent'),
  // For DROP: percentage the drop keeps from project income (0-100, default 5).
  // Nullable for non-DROP roles. Drop role - phase 1.
  dropSharePercent: integer('drop_share_percent').default(5),
  // For JUNIOR/HR/ACCOUNTANT: fixed monthly salary (currency set separately)
  monthlySalary: numeric('monthly_salary', { precision: 10, scale: 2 }),
  salaryCurrency: currencyEnum('salary_currency').default('USD'),
  // Legal full name (Cyrillic, order: Surname First Patronymic).
  // Set by ADMIN at user creation / edit. Used in MSA contract instead of displayName.
  // NULL = not set → interpolateVariables falls back to displayName.
  legalFullName: text('legal_full_name'),
  // ФОП registration address (адреса реєстрації ФОП).
  // Used in contract templates via {{registrationAddress}}. Nullable.
  registrationAddress: text('registration_address'),
  // Soft delete (archived users hidden from main UI, restorable)
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  // Admin note (single overwriteable text field)
  adminNote: text('admin_note'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

// ---------------------------------------------------------------------------
// User emails — notifications-and-confirmations spec §4.4
//
// A user can log in through TWO addresses: a WORK address (ours, always a
// login method) and a PERSONAL address (entered by ADMIN at creation, a
// login method only after the holder accepts an invite — separate task).
//
// Why a TABLE and not a second column on `users`. A per-column UNIQUE
// constraint (like `users.email` above) can only guarantee "work addresses
// don't repeat" and, separately, "personal addresses don't repeat" — it
// cannot express "no personal address equals anyone else's work address",
// because the two values live in two different columns Postgres never
// compares against each other. That gap is a direct account-takeover path
// (log in with an address you were only ever handed as someone ELSE's
// personal contact). A single table with ONE unique index across every row
// — both kinds, every user — makes that guarantee a property of the schema
// instead of a property of every caller remembering to check two places.
//
// `userId` + `kind` is also unique: exactly one WORK row and at most one
// PERSONAL row per user, matching the mental model the admin form and the
// profile page are built around (`UsersService.upsertWorkEmail` relies on
// this for its find-then-update-or-insert path).
// ---------------------------------------------------------------------------

export const userEmailKindEnum = pgEnum('user_email_kind', ['WORK', 'PERSONAL'])

/**
 * security-review PR #623 (SR-H-1, HIGH): mail is case-insensitive,
 * Postgres varchar equality is not. A plain unique index on `email` let
 * `Alice@corp.com` and `alice@corp.com` coexist as two different rows —
 * one address, reachable through two case variants, landing on two
 * different accounts. Wrap every column reference to `email` used for
 * comparison/uniqueness through this so the DB index and every app-level
 * check fold case the SAME way — see the Drizzle-documented pattern for a
 * case-insensitive unique email column (case-insensitive-email guide).
 * The column itself keeps the CASE the admin/OAuth provider typed
 * (unchanged for display); only comparisons fold.
 */
export function lowerEmail(email: AnyPgColumn): SQL {
  return sql`lower(${email})`
}

export const userEmails = pgTable(
  'user_emails',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    email: varchar('email', { length: 255 }).notNull(),
    kind: userEmailKindEnum('kind').notNull(),
    // NULL = never confirmed. WORK rows are stamped at insert time (mirrors
    // the trust we already place in `users.email` today); PERSONAL rows stay
    // NULL until the invite-accept flow (next task) sets it.
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    // Whether THIS address can be used to sign in. WORK defaults true (it is
    // already how everyone logs in today — the migration backfill mirrors
    // that). PERSONAL defaults false — "the address exists, mail goes to it,
    // it does not open the door" (spec §5) — flipped true only once the
    // invite-accept flow exists.
    canLogin: boolean('can_login').notNull().default(false),
    // task-user-emails-invite (position 2, continued): the Google `sub` that
    // proved ownership of THIS row's address. WORK rows never use this
    // column — WORK identity binding continues to use `users.googleId`
    // unchanged (three security-review rounds already covered that path;
    // touching it would re-litigate already-approved code for no reason).
    // PERSONAL rows use it INSTEAD of `users.googleId`, because a personal
    // address is, by construction, a DIFFERENT Google account than the
    // corporate WORK one — reusing a single `users.googleId` for both would
    // permanently lock out whichever address logs in second (its `sub`
    // would never match the first-bound one). Set exactly once, at
    // invite-accept time (UsersService.acceptPersonalEmailInvite), in the
    // SAME transaction that flips `canLogin` — see that method. Nullable:
    // every WORK row and every not-yet-accepted PERSONAL row has no `sub`
    // to record yet.
    googleId: varchar('google_id', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // The structural guarantee this whole table exists for — see module
    // comment above. Global across every user and both kinds, CASE-FOLDED
    // (SR-H-1) — replaces a plain `.on(t.email)` unique index, which is
    // strictly weaker (case-insensitive uniqueness implies case-sensitive
    // uniqueness, never the other way). Every app-level query MUST go
    // through `lowerEmail(...)` too (see UsersService.assertEmailAvailable /
    // findLoginableUserByEmail / upsertWorkEmail) — an index alone does not
    // make a `.where(eq(userEmails.email, rawEmail))` case-insensitive.
    uniqueIndex('idx_user_emails_email_lower').on(lowerEmail(t.email)),
    // One WORK + one PERSONAL row per user. Also the index `upsertWorkEmail`'s
    // find-by-(userId,kind) lookup rides on.
    uniqueIndex('idx_user_emails_user_kind').on(t.userId, t.kind),
    // A given Google account may bind to at most one row, same anti-
    // takeover invariant `users.googleId`'s own unique constraint already
    // enforces for WORK — see the column comment above. Postgres treats
    // every NULL as distinct, so this never conflicts across the many rows
    // that have not bound a Google identity yet.
    uniqueIndex('idx_user_emails_google_id').on(t.googleId),
  ],
)

/**
 * task-user-emails-invite (position 2, continued): one-time invite token for
 * a PERSONAL `user_emails` row — see spec §5 ("Приглашение вместо экрана
 * верификации"). Only a PERSONAL row ever gets one (WORK is already a login
 * method, unconditionally, from the moment it is created).
 *
 * Stores a HASH of the token, never the token itself (mirrors
 * `invoice-pdf.utils.ts` / `resume-typst.service.ts`'s existing
 * `createHash('sha256')` convention in this codebase) — a DB read (backup,
 * replica, compromised credential) must not be enough to mint a working
 * invite link on its own.
 *
 * One row per `user_email_id` (unique index below): resending an invite
 * OVERWRITES `tokenHash`/`expiresAt`/`usedAt` in place rather than
 * appending a new row — "новый токен гасит старый" (task spec) means the
 * OLD raw token, wherever it is (an old email, a browser tab left open),
 * can never match anything in the DB again the instant a new one is
 * issued, not just "eventually, once it expires".
 */
export const userEmailInvites = pgTable(
  'user_email_invites',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userEmailId: uuid('user_email_id')
      .notNull()
      .references(() => userEmails.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    // NULL = not yet accepted. Set once, at accept time — a used token is
    // never valid again (checked BEFORE this is set, in the same
    // transaction that sets it — see acceptPersonalEmailInvite).
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // One active invite per address row — see module comment above.
    uniqueIndex('idx_user_email_invites_user_email').on(t.userEmailId),
    // The accept-flow lookup key. A hash collision here would let one
    // token accept a DIFFERENT invite — sha256 (64 hex chars, matching the
    // column width) makes that cryptographically unreachable.
    uniqueIndex('idx_user_email_invites_token_hash').on(t.tokenHash),
  ],
)

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

export const teams = pgTable('teams', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  // Discriminator: 'SENIOR' = legacy senior-team (default), 'DROP' = drop-team.
  // Mapping logic in TeamsService.mapTeam early-returns to mapDropTeam when
  // type='DROP'. Drop role - phase 1.
  type: teamTypeEnum('type').notNull().default('SENIOR'),
  telegram: varchar('telegram', { length: 500 }),
  // Optional Telegram channel handle (5–32 latin chars / digits / _, optional @).
  // Edited from the SENIOR's Edit dialog and propagates here via UsersService.adminUpdateUser.
  telegramChannel: text('telegram_channel'),
  notes: text('notes'),
  // task-team-senior-share-override. Team-level override for the SENIOR's
  // share percent (0-100). NULL = no team override → fall through to the
  // legacy resolver (project override → user default). Editable by ADMIN
  // and by HR (when owner of the team). Snapshotted into
  // `transactions.seniorSharePercent` + `seniorSharePercentSource` at
  // SENIOR_INCOME / DROP_INCOME creation time, so historical rows keep
  // their value after edits.
  seniorSharePercentOverride: integer('senior_share_percent_override'),
  // Soft delete (archived teams hidden from main UI, restorable)
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

export const teamMembers = pgTable('team_members', {
  id: uuid('id').defaultRandom().primaryKey(),
  teamId: uuid('team_id')
    .notNull()
    .references(() => teams.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
  // Soft delete of membership (NULL = active, timestamp = left)
  leftAt: timestamp('left_at', { withTimezone: true }),
})

export const usersRelations = relations(users, ({ many }) => ({
  teamMemberships: many(teamMembers),
  projects: many(projects, { relationName: 'projectSenior' }),
  dropProjects: many(projects, { relationName: 'projectDrop' }),
  projectMemberships: many(projectMembers),
  seniorInterviews: many(interviews, { relationName: 'seniorInterviews' }),
  hrInterviews: many(interviews, { relationName: 'hrInterviews' }),
  sentTransactions: many(transactions, { relationName: 'sentTransactions' }),
  receivedTransactions: many(transactions, { relationName: 'receivedTransactions' }),
  validatedTransactions: many(transactions, { relationName: 'validatedTransactions' }),
  createdTransactions: many(transactions, { relationName: 'createdTransactions' }),
  payoutRequests: many(payoutRequests),
  auditLogAsActor: many(userAuditLog, { relationName: 'auditLogAsActor' }),
  auditLogAsTarget: many(userAuditLog, { relationName: 'auditLogAsTarget' }),
  createdMeetingRecorderConnections: many(meetingRecorderConnections, {
    relationName: 'meetingRecorderConnectionCreator',
  }),
  linkedInterviewRecordings: many(interviewRecordings, {
    relationName: 'interviewRecordingLinker',
  }),
  meetingRecorderAuditEntries: many(meetingRecorderAuditLog, {
    relationName: 'meetingRecorderAuditActor',
  }),
}))

export const teamsRelations = relations(teams, ({ many }) => ({
  members: many(teamMembers),
}))

export const teamMembersRelations = relations(teamMembers, ({ one }) => ({
  team: one(teams, { fields: [teamMembers.teamId], references: [teams.id] }),
  user: one(users, { fields: [teamMembers.userId], references: [users.id] }),
}))

export type User = typeof users.$inferSelect

export type NewUser = typeof users.$inferInsert

export type UserEmail = typeof userEmails.$inferSelect

export type NewUserEmail = typeof userEmails.$inferInsert

export type UserEmailInvite = typeof userEmailInvites.$inferSelect

export type NewUserEmailInvite = typeof userEmailInvites.$inferInsert

export type Team = typeof teams.$inferSelect

export type NewTeam = typeof teams.$inferInsert

export type TeamMember = typeof teamMembers.$inferSelect

export type NewTeamMember = typeof teamMembers.$inferInsert
