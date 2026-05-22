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

export type ItDomain = typeof IT_DOMAINS[number]
export const itDomainSchema = z.enum(IT_DOMAINS)

export const projectMemberSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  displayName: z.string(),
  email: z.string().email(),
  avatar: z.string().url().nullable(),
  role: z.enum(['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT']),
  joinedAt: z.string().datetime(),
  leftAt: z.string().datetime().nullable(),
})

export const currencySchema = z.enum(['USDT', 'USD', 'EUR', 'UAH'])

const logoUrlSchema = z.string().refine(
  (v) => v.startsWith('data:') || z.string().url().safeParse(v).success,
  { message: 'Invalid URL' },
).nullable()

export const projectSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  companyName: z.string(),
  domain: itDomainSchema,
  logoUrl: logoUrlSchema,
  startDate: z.string().datetime(),
  seniorId: z.string().uuid(),
  seniorName: z.string(),
  rate: z.number(),
  currency: currencySchema,
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
  senior: z.object({
    id: z.string().uuid(),
    displayName: z.string(),
    email: z.string().email(),
    avatar: z.string().url().nullable(),
    role: z.literal('SENIOR'),
  }).nullable(),
  hrs: z.array(z.object({
    id: z.string().uuid(),
    userId: z.string().uuid(),
    displayName: z.string(),
    email: z.string().email(),
    avatar: z.string().url().nullable(),
    role: z.literal('HR'),
  })),
  accountants: z.array(z.object({
    id: z.string().uuid(),
    userId: z.string().uuid(),
    displayName: z.string(),
    email: z.string().email(),
    avatar: z.string().url().nullable(),
    role: z.literal('ACCOUNTANT'),
  })),
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
    role: z.enum(['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT']),
    isPaired: z.boolean().optional(),
    teamName: z.string().nullable().optional(),
    teamsCount: z.number().int().nonnegative().optional(),
    projectsCount: z.number().int().nonnegative().optional(),
    juniorsAffected: z.number().int().nonnegative().optional(),
    hrAccountantsToBeRemoved: z.number().int().nonnegative().optional(),
    noDependencies: z.boolean().optional(),
  }),
  // Team impact (alias for senior's pair)
  z.object({
    type: z.literal('team'),
    isPaired: z.literal(true),
    teamName: z.string(),
    seniorName: z.string(),
    projectsCount: z.number().int().nonnegative(),
    membersAffected: z.number().int().nonnegative(),
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
  entities: z.array(z.object({
    type: z.enum(['user', 'team']),
    id: z.string().uuid(),
    name: z.string(),
  })),
})

export const createProjectSchema = z.object({
  name: z.string().min(1).max(255),
  companyName: z.string().min(1).max(255),
  domain: itDomainSchema,
  logoUrl: logoUrlSchema.optional(),
  startDate: z.string().datetime(),
  seniorId: z.string().uuid(),
  rate: z.number().int().positive(),
  currency: currencySchema,
  techStack: z.string().max(500).optional().nullable(),
  teamSize: z.string().max(100).optional().nullable(),
  benefits: z.string().max(500).optional().nullable(),
  paymentType: z.string().max(100).optional().nullable(),
  salaryReview: z.string().max(255).optional().nullable(),
  corpTech: z.string().max(255).optional().nullable(),
  notesGeneral: z.string().max(1000).optional().nullable(),
})

export const updateProjectSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  companyName: z.string().min(1).max(255).optional(),
  domain: itDomainSchema.optional(),
  logoUrl: logoUrlSchema.optional(),
  rate: z.number().int().positive().optional(),
  currency: currencySchema.optional(),
  techStack: z.string().max(500).optional().nullable(),
  teamSize: z.string().max(100).optional().nullable(),
  benefits: z.string().max(500).optional().nullable(),
  paymentType: z.string().max(100).optional().nullable(),
  salaryReview: z.string().max(255).optional().nullable(),
  corpTech: z.string().max(255).optional().nullable(),
  notesGeneral: z.string().max(1000).optional().nullable(),
})

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
