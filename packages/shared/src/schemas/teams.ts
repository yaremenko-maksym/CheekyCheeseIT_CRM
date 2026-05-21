import { z } from 'zod'

export const teamMemberSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  displayName: z.string(),
  email: z.string().email(),
  avatar: z.string().url().nullable(),
  role: z.enum(['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT']),
  techStack: z.array(z.string()).nullable(),
  phone: z.string().nullable().optional(),
  telegram: z.string().nullable().optional(),
  joinedAt: z.string().or(z.date()),
  // Soft-delete of membership (NULL = active; timestamp = left)
  leftAt: z.string().datetime().nullable().optional(),
})

export const teamSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  telegram: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  archivedAt: z.string().datetime().nullable(),
  members: z.array(teamMemberSchema),
})

// Action types for team audit log (mirror of user_audit_log).
export const teamAuditActionSchema = z.enum([
  'team_created',
  'team_renamed',
  'team_archived',
  'team_unarchived',
  'team_member_added',
  'team_member_removed',
])

export const teamAuditLogEntrySchema = z.object({
  id: z.string().uuid(),
  actorId: z.string().uuid().nullable(),
  targetId: z.string().uuid(),
  action: teamAuditActionSchema,
  changes: z.record(z.string(), z.object({ before: z.unknown(), after: z.unknown() })),
  createdAt: z.coerce.date(),
})

export const teamAuditLogListSchema = z.object({
  entries: z.array(teamAuditLogEntrySchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
})

export const createTeamSchema = z.object({
  name: z.string().min(1).max(255),
  seniorId: z.string().uuid(),
  hrIds: z.array(z.string().uuid()).min(1),
  accountantId: z.string().uuid().nullable(),
})

export const updateTeamSchema = z.object({
  name: z.string().min(1).max(255),
  telegram: z
    .string()
    .max(500)
    .refine(
      (val) => !val || val.startsWith('https://t.me/'),
      'Ссылка должна начинаться с https://t.me/',
    )
    .nullable()
    .optional(),
  notes: z.string().nullable().optional(),
})

export const addTeamMemberSchema = z.object({
  userId: z.string().uuid(),
})

export type TeamMemberDto = z.infer<typeof teamMemberSchema>
export type TeamDto = z.infer<typeof teamSchema>
export type CreateTeamDto = z.infer<typeof createTeamSchema>

export type UpdateTeamDto = z.infer<typeof updateTeamSchema>
export type AddTeamMemberDto = z.infer<typeof addTeamMemberSchema>
export type TeamAuditAction = z.infer<typeof teamAuditActionSchema>
export type TeamAuditLogEntry = z.infer<typeof teamAuditLogEntrySchema>
export type TeamAuditLogList = z.infer<typeof teamAuditLogListSchema>
