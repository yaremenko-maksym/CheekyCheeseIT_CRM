import { z } from 'zod'

export const teamMemberSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  displayName: z.string(),
  email: z.string().email(),
  /** Avatar fallback URL (Google / dicebear). Renamed from `avatar` in 0013. */
  avatarUrl: z.string().url().nullable(),
  /** FK → documents.id for AVATAR uploads (null when user uses fallback). */
  avatarDocumentId: z.string().uuid().nullable(),
  role: z.enum(['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT', 'DROP']),
  techStack: z.array(z.string()).nullable(),
  phone: z.string().nullable().optional(),
  telegram: z.string().nullable().optional(),
  joinedAt: z.string().or(z.date()),
  // Soft-delete of membership (NULL = active; timestamp = left)
  leftAt: z.string().datetime().nullable().optional(),
})

/**
 * Telegram channel handle stored on `teams.telegram_channel`.
 *
 * Shape mirrors the user-level `telegram` regex so both fields validate
 * identically (no separate parser branch). Accepts:
 *   - empty / null (column is nullable; field is optional)
 *   - `@channel` or `channel` (leading @ is normalised by the form layer)
 * 5–32 latin chars / digits / `_`.
 */
export const teamTelegramChannelSchema = z
  .string()
  .regex(/^@?[a-zA-Z0-9_]{5,32}$/, 'Некорректный канал (5–32 латинских символов или _, опц. @)')
  .nullable()
  .optional()

/**
 * Team type — discriminator between the legacy senior-team (SENIOR) and the
 * new drop-team (DROP). Senior-teams keep all existing behavior; drop-teams
 * carry a DROP owner + optional active SENIOR + HR(s) + accountant.
 */
export const teamTypeSchema = z.enum(['SENIOR', 'DROP'])
export type TeamType = z.infer<typeof teamTypeSchema>

export const teamSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  /**
   * `'SENIOR'` for the legacy senior-team (default; spec invariant), or
   * `'DROP'` for the drop-team (always paired with a DROP user).
   */
  type: teamTypeSchema.default('SENIOR'),
  telegram: z.string().nullable().optional(),
  telegramChannel: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  /**
   * Team-level senior share percent override (0-100, integer). NULL means
   * "no team override — fall back to project override → user default".
   * Hierarchy (highest priority first): project override > team override >
   * user default. Snapshotted into `transactions.seniorSharePercent` +
   * `transactions.seniorSharePercentSource` at SENIOR_INCOME / DROP_INCOME
   * creation time so historical rows keep their value even after edits.
   * task-team-senior-share-override.
   */
  seniorSharePercentOverride: z.number().int().min(0).max(100).nullable().optional(),
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
  'team_updated',
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
  telegramChannel: teamTelegramChannelSchema,
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
  telegramChannel: teamTelegramChannelSchema,
  notes: z.string().nullable().optional(),
  /**
   * Team-level senior share percent override. Integer 0-100 or null (clear).
   * Optional — only included in PATCH bodies that touch the field.
   * Resolver hierarchy: project override > team override > user default.
   * RBAC: ADMIN + HR (HR only when owner of the team) per task AC3.
   */
  seniorSharePercentOverride: z.number().int().min(0).max(100).nullable().optional(),
})

export const addTeamMemberSchema = z.object({
  userId: z.string().uuid(),
})

/**
 * Rotate an active senior within a drop-team. Replaces the currently
 * active senior (if any) with `newSeniorId`. Backend enforces:
 *  - target team has `type='DROP'`
 *  - `newSeniorId.role === 'SENIOR'` and has no other active team membership
 */
export const rotateSeniorSchema = z.object({
  newSeniorId: z.string().uuid(),
})

/**
 * Attach an existing SENIOR (with no active team membership) to a drop-team
 * that has no active senior. Used by both the create-senior flow with
 * `teamMode='JOIN_DROP_TEAM'` and the standalone rotation UI.
 */
export const addSeniorToDropTeamSchema = z.object({
  seniorId: z.string().uuid(),
})

export type TeamMemberDto = z.infer<typeof teamMemberSchema>
export type TeamDto = z.infer<typeof teamSchema>
export type CreateTeamDto = z.infer<typeof createTeamSchema>

export type UpdateTeamDto = z.infer<typeof updateTeamSchema>
export type AddTeamMemberDto = z.infer<typeof addTeamMemberSchema>
export type TeamAuditAction = z.infer<typeof teamAuditActionSchema>
export type TeamAuditLogEntry = z.infer<typeof teamAuditLogEntrySchema>
export type TeamAuditLogList = z.infer<typeof teamAuditLogListSchema>
export type RotateSeniorDto = z.infer<typeof rotateSeniorSchema>
export type AddSeniorToDropTeamDto = z.infer<typeof addSeniorToDropTeamSchema>
