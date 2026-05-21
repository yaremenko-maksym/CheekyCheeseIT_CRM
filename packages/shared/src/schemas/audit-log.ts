import { z } from 'zod'

export const auditActionSchema = z.enum([
  'profile_created',
  'profile_edit',
  'requisites_edit',
  'role_change',
  'salary_change',
  'note_set',
  'team_membership',
  'project_reassignment',
  'user_archived',
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
