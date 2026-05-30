import { z } from 'zod'

export const IT_DOMAINS = [
  'AI / ML',
  'FinTech',
  'EdTech',
  'E-Commerce',
  'HealthTech',
  'SaaS',
  'DevTools',
  'Cybersecurity',
  'Web3 / Crypto',
  'GameDev',
  'AdTech',
  'HRTech',
  'LegalTech',
  'PropTech',
  'Logistics',
  'Social Media',
  'Data & Analytics',
  'Cloud Infrastructure',
  'Embedded / IoT',
  'Gambling',
  'Adult',
  'Other',
] as const

export type ItDomain = (typeof IT_DOMAINS)[number]
export const itDomainSchema = z.enum(IT_DOMAINS)

export const projectMemberSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  displayName: z.string(),
  email: z.string().email(),
  /** Avatar fallback URL (Google / dicebear). Renamed from `avatar` in 0013. */
  avatarUrl: z.string().url().nullable(),
  /** FK → documents.id for AVATAR uploads (null when user uses fallback). */
  avatarDocumentId: z.string().uuid().nullable(),
  role: z.enum(['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT', 'DROP']),
  joinedAt: z.string().datetime(),
  leftAt: z.string().datetime().nullable(),
})

export const currencySchema = z.enum(['USDT', 'USD', 'EUR', 'UAH'])

/**
 * Refinement enforcing XOR between the two logo columns (mirrors the
 * `chk_logo_xor` DB CHECK constraint). Both null is allowed (no logo).
 */
function refineLogoXor(
  data: { logoDocumentId?: string | null | undefined; logoExternalUrl?: string | null | undefined },
  ctx: z.RefinementCtx,
): void {
  if (data.logoDocumentId && data.logoExternalUrl) {
    ctx.addIssue({
      code: 'custom',
      message: 'Только один из logoDocumentId / logoExternalUrl может быть задан',
      path: ['logoExternalUrl'],
    })
  }
}

export const projectSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  companyName: z.string(),
  domain: itDomainSchema,
  /** FK → documents.id for LOGO uploads (S3-backed). XOR with logoExternalUrl. */
  logoDocumentId: z.string().uuid().nullable(),
  /** External logo URL (e.g. https://company.com/logo.svg). XOR with logoDocumentId. */
  logoExternalUrl: z.string().url().nullable(),
  startDate: z.string().datetime(),
  seniorId: z.string().uuid(),
  seniorName: z.string(),
  /**
   * Drop-only: when set, the project's income flows through the DROP user
   * and the finance distribution includes the drop's share (Phase 2).
   * `null` = legacy senior-project (no drop) — finance behavior unchanged.
   */
  dropId: z.string().uuid().nullable(),
  rate: z.number(),
  currency: currencySchema,
  // Per-project SENIOR share % override (0-100). NULL = use senior's
  // global default (see `seniorSharePercentDefault` below). Editable only
  // by ADMIN and ACCOUNTANT (enforced in projects.service.ts).
  seniorSharePercentOverride: z.number().int().min(0).max(100).nullable(),
  // Computed on the backend: snapshot of `users.seniorSharePercent` for the
  // project's senior. Used by the UI as a hint ("default X%") when the
  // override is null. Not persisted on the project row.
  seniorSharePercentDefault: z.number().int().min(0).max(100),
  members: z.array(projectMemberSchema),
  techStack: z.string().nullable(),
  teamSize: z.string().nullable(),
  benefits: z.string().nullable(),
  paymentType: z.string().nullable(),
  salaryReview: z.string().nullable(),
  corpTech: z.string().nullable(),
  notesGeneral: z.string().nullable(),
  archivedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})

// Computed `effectiveTeam` returned by GET /projects/:id — see spec §5.2
// HR/Accountant pulled dynamically from senior's current team_members (not snapshot at archive).
//
// IMPORTANT: `effectiveTeam` is exposed on the DETAIL endpoint only (GET /projects/:id) —
// the list endpoint (GET /projects) returns the base `projectSchema` without this field.
// Frontend consumes the detail shape via `projectDetailSchema` / `ProjectDetailDto`.
export const effectiveTeamSchema = z.object({
  senior: z
    .object({
      id: z.string().uuid(),
      displayName: z.string(),
      email: z.string().email(),
      avatarUrl: z.string().url().nullable(),
      avatarDocumentId: z.string().uuid().nullable(),
      role: z.literal('SENIOR'),
    })
    .nullable(),
  hrs: z.array(
    z.object({
      id: z.string().uuid(),
      userId: z.string().uuid(),
      displayName: z.string(),
      email: z.string().email(),
      avatarUrl: z.string().url().nullable(),
      avatarDocumentId: z.string().uuid().nullable(),
      role: z.literal('HR'),
    }),
  ),
  accountants: z.array(
    z.object({
      id: z.string().uuid(),
      userId: z.string().uuid(),
      displayName: z.string(),
      email: z.string().email(),
      avatarUrl: z.string().url().nullable(),
      avatarDocumentId: z.string().uuid().nullable(),
      role: z.literal('ACCOUNTANT'),
    }),
  ),
  juniors: z.array(projectMemberSchema),
})

// Detail shape returned by `GET /projects/:id`. Extends the base `projectSchema`
// with the computed `effectiveTeam` view. Frontend uses this in detail-page routes
// and in any cascading action UI (admin actions, unarchive modals) where it needs
// the current HR/Accountant pair without a separate fetch.
export const projectDetailSchema = projectSchema.extend({
  effectiveTeam: effectiveTeamSchema.optional(),
})

// Action types for project audit log
export const projectAuditActionSchema = z.enum([
  'project_created',
  'project_edited',
  'project_archived',
  'project_unarchived',
  'project_member_added',
  'project_member_removed',
])

export const projectAuditLogEntrySchema = z.object({
  id: z.string().uuid(),
  actorId: z.string().uuid().nullable(),
  targetId: z.string().uuid(),
  action: projectAuditActionSchema,
  changes: z.record(z.string(), z.object({ before: z.unknown(), after: z.unknown() })),
  createdAt: z.coerce.date(),
})

export const projectAuditLogListSchema = z.object({
  entries: z.array(projectAuditLogEntrySchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
})

// Returned to UI to show warning before archive (cascade impact summary).
export const archiveImpactSchema = z.union([
  // User impact
  z.object({
    type: z.literal('user'),
    role: z.enum(['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT', 'DROP']),
    isPaired: z.boolean().optional(),
    teamName: z.string().nullable().optional(),
    teamsCount: z.number().int().nonnegative().optional(),
    projectsCount: z.number().int().nonnegative().optional(),
    juniorsAffected: z.number().int().nonnegative().optional(),
    hrAccountantsToBeRemoved: z.number().int().nonnegative().optional(),
    noDependencies: z.boolean().optional(),
  }),
  // Team impact (alias for senior's pair OR drop-team standalone)
  z.object({
    type: z.literal('team'),
    isPaired: z.literal(true),
    teamName: z.string(),
    // For SENIOR teams — name of the senior; the confirm input expects this.
    // For DROP teams — name of the senior being detached (informational only;
    // the senior is NOT archived, just unbound). Use `dropName` for the
    // confirm input.
    seniorName: z.string(),
    projectsCount: z.number().int().nonnegative(),
    membersAffected: z.number().int().nonnegative(),
    // Drop-archive round 2 (B2): explicit team-type discriminator + drop
    // metadata. Optional so legacy senior-team responses parse unchanged.
    // `teamType` defaults to 'SENIOR' on the client when absent.
    teamType: z.enum(['SENIOR', 'DROP']).optional(),
    // Drop-team only: name of the drop user that owns this team. The
    // confirmation input asks for this name (not the senior's).
    dropName: z.string().optional(),
    // Drop-team only: true when an active senior is attached and will be
    // detached (not archived) by `archiveDropTeam`. Surfaces in the
    // confirmation dialog so admin knows the senior is released.
    seniorWillBeDetached: z.boolean().optional(),
  }),
  // Project impact (independent)
  z.object({
    type: z.literal('project'),
    activeMembersCount: z.number().int().nonnegative(),
  }),
])

// 409 body shape when project unarchive requires cascade (senior/team archived).
export const cascadeRequiredErrorSchema = z.object({
  requiresCascade: z.literal(true),
  entities: z.array(
    z.object({
      type: z.enum(['user', 'team']),
      id: z.string().uuid(),
      name: z.string(),
    }),
  ),
})

export const createProjectSchema = z
  .object({
    name: z.string().min(1).max(255),
    companyName: z.string().min(1).max(255),
    domain: itDomainSchema,
    logoDocumentId: z.string().uuid().nullable().optional(),
    logoExternalUrl: z.string().url().nullable().optional(),
    startDate: z.string().datetime(),
    seniorId: z.string().uuid(),
    rate: z.number().int().positive(),
    currency: currencySchema,
    // Optional at create time; only ADMIN/ACCOUNTANT may pass this — service
    // throws ForbiddenException for HR/SENIOR/JUNIOR.
    seniorSharePercentOverride: z.number().int().min(0).max(100).nullable().optional(),
    techStack: z.string().max(500).optional().nullable(),
    teamSize: z.string().max(100).optional().nullable(),
    benefits: z.string().max(500).optional().nullable(),
    paymentType: z.string().max(100).optional().nullable(),
    salaryReview: z.string().max(255).optional().nullable(),
    corpTech: z.string().max(255).optional().nullable(),
    notesGeneral: z.string().max(1000).optional().nullable(),
  })
  .superRefine(refineLogoXor)

export const updateProjectSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    companyName: z.string().min(1).max(255).optional(),
    domain: itDomainSchema.optional(),
    logoDocumentId: z.string().uuid().nullable().optional(),
    logoExternalUrl: z.string().url().nullable().optional(),
    rate: z.number().int().positive().optional(),
    currency: currencySchema.optional(),
    // Only ADMIN/ACCOUNTANT may include this field — service throws
    // ForbiddenException for HR/SENIOR/JUNIOR if it is present (even null).
    seniorSharePercentOverride: z.number().int().min(0).max(100).nullable().optional(),
    techStack: z.string().max(500).optional().nullable(),
    teamSize: z.string().max(100).optional().nullable(),
    benefits: z.string().max(500).optional().nullable(),
    paymentType: z.string().max(100).optional().nullable(),
    salaryReview: z.string().max(255).optional().nullable(),
    corpTech: z.string().max(255).optional().nullable(),
    notesGeneral: z.string().max(1000).optional().nullable(),
  })
  .superRefine(refineLogoXor)

export const addProjectMemberSchema = z.object({
  userId: z.string().uuid(),
})

export type ProjectMemberDto = z.infer<typeof projectMemberSchema>
export type ProjectDto = z.infer<typeof projectSchema>
export type CreateProjectDto = z.infer<typeof createProjectSchema>
export type UpdateProjectDto = z.infer<typeof updateProjectSchema>
export type AddProjectMemberDto = z.infer<typeof addProjectMemberSchema>
export type EffectiveTeam = z.infer<typeof effectiveTeamSchema>
export type ProjectDetailDto = z.infer<typeof projectDetailSchema>
export type ProjectAuditAction = z.infer<typeof projectAuditActionSchema>
export type ProjectAuditLogEntry = z.infer<typeof projectAuditLogEntrySchema>
export type ProjectAuditLogList = z.infer<typeof projectAuditLogListSchema>
export type ArchiveImpact = z.infer<typeof archiveImpactSchema>
export type CascadeRequiredError = z.infer<typeof cascadeRequiredErrorSchema>
