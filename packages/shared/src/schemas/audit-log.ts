import { z } from 'zod'

export const auditActionSchema = z.enum([
  'profile_created',
  'profile_edit',
  'requisites_edit',
  // Read-access audit: an ACCOUNTANT viewed another user's payment requisites
  // (RNOKPP / IBAN / wallet). The base audit log only tracked *writes*; this
  // closes the gap for the company-wide payroll read scope (pre-deploy MEDIUM).
  'requisites_read',
  'role_change',
  'salary_change',
  'note_set',
  'team_membership',
  'project_reassignment',
  'user_archived',
  'user_unarchived',
  'legal_name_change',
  // security-review PR #623 round 4 (SR-M-12): the resend-invite write had
  // no audit trail at all (the only write endpoint on UsersController
  // without one) — it reissues credentials and sends mail, both auditable
  // actions elsewhere in this file. Recorded directly via
  // `AuditLogService.record()` from `UsersService.resendPersonalEmailInvite`
  // rather than the `@AuditLog` decorator: that decorator's automatic
  // before/after diff (`AuditInterceptor`) compares the `users` TABLE row —
  // a resend touches `user_email_invites` only, which never shows up in
  // that diff, so decorating the controller method alone would silently
  // record nothing.
  'personal_email_invite_resend',
  // security-review PR #623 round 4, owner decision (see
  // `changePersonalEmailSchema`'s doc, packages/shared/src/schemas/users.ts):
  // admin change/removal of a user's personal address — revokes login on
  // whatever address was there before. Same reasoning as the action above:
  // recorded directly via `AuditLogService.record()`, not the `@AuditLog`
  // decorator, because the change lives in `user_emails`, not `users`.
  'personal_email_changed',
])

export const auditChangeSchema = z.object({
  before: z.unknown(),
  after: z.unknown(),
})

export const auditLogEntrySchema = z.object({
  id: z.string().uuid(),
  actorId: z.string().uuid().nullable(),
  targetId: z.string().uuid(),
  action: auditActionSchema,
  changes: z.record(z.string(), auditChangeSchema),
  createdAt: z.coerce.date(),
})

export const auditLogListSchema = z.object({
  entries: z.array(auditLogEntrySchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
})

export type AuditAction = z.infer<typeof auditActionSchema>
export type AuditChange = z.infer<typeof auditChangeSchema>
export type AuditLogEntry = z.infer<typeof auditLogEntrySchema>
export type AuditLogList = z.infer<typeof auditLogListSchema>
