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
  endDate: z.string().datetime().nullable(),
  seniorId: z.string().uuid(),
  seniorName: z.string(),
  rate: z.number(),
  currency: currencySchema,
  status: z.enum(['ACTIVE', 'CLOSED']),
  members: z.array(projectMemberSchema),
  techStack: z.string().nullable(),
  teamSize: z.string().nullable(),
  benefits: z.string().nullable(),
  paymentType: z.string().nullable(),
  salaryReview: z.string().nullable(),
  corpTech: z.string().nullable(),
  notesGeneral: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
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
  endDate: z.string().datetime().optional().nullable(),
  rate: z.number().int().positive().optional(),
  currency: currencySchema.optional(),
  status: z.enum(['ACTIVE', 'CLOSED']).optional(),
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
