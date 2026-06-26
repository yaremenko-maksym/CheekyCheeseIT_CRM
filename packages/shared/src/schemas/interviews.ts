import { z } from 'zod'
import { currencySchema, itDomainSchema } from './projects'

export const interviewStageSchema = z.enum([
  'HR_SCREEN',
  'ENGLISH_CHECK',
  'TECH_INTERVIEW',
  'FINAL_INTERVIEW',
  'CLIENT_INTERVIEW',
  'OFFER_RECEIVED',
  'HIRED',
  'REJECTED',
  'ARCHIVED',
])

export const interviewSchema = z.object({
  id: z.string().uuid(),
  seniorId: z.string().uuid(),
  seniorName: z.string(),
  hrId: z.string().uuid().nullable(),
  hrName: z.string().nullable(),
  companyName: z.string(),
  vacancyUrl: z.string().nullable(),
  callUrl: z.string().nullable(),
  stage: interviewStageSchema,
  notesDomain: itDomainSchema.nullable(),
  notesTechStack: z.string().nullable(),
  notesTeamSize: z.string().nullable(),
  notesBenefits: z.string().nullable(),
  notesPaymentType: z.string().nullable(),
  notesSalaryReview: z.string().nullable(),
  notesCorpTech: z.string().nullable(),
  notesGeneral: z.string().nullable(),
  position: z.number(),
  createdProjectId: z.string().uuid().nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})

export const createInterviewSchema = z.object({
  seniorId: z.string().uuid(),
  companyName: z.string().min(1).max(255),
  vacancyUrl: z.string().url().nullable().optional(),
  callUrl: z.string().url().nullable().optional(),
})

// Audit (HIGH): `stage` is intentionally NOT updatable through this schema.
// Stage transitions are owned exclusively by `move()` (PATCH /interviews/:id/move),
// which holds the transition logic + the HIRED → auto-create-project side-effect.
// Allowing `stage` here let a client set HIRED directly (bypassing project
// creation) or roll back a terminal HIRED. Zod strips the unknown `stage` key on
// `.parse()`, so a stray `stage` in an update payload is silently dropped, never
// written. Pinned by interviews-rbac.integration.spec.ts (PATCH stage → ignored).
export const updateInterviewSchema = z.object({
  companyName: z.string().min(1).max(255).optional(),
  vacancyUrl: z.string().url().nullable().optional(),
  callUrl: z.string().url().nullable().optional(),
  notesDomain: itDomainSchema.nullable().optional(),
  notesTechStack: z.string().max(500).nullable().optional(),
  notesTeamSize: z.string().max(100).nullable().optional(),
  notesBenefits: z.string().max(500).nullable().optional(),
  notesPaymentType: z.string().max(100).nullable().optional(),
  notesSalaryReview: z.string().max(255).nullable().optional(),
  notesCorpTech: z.string().max(255).nullable().optional(),
  notesGeneral: z.string().max(1000).nullable().optional(),
})

export const moveInterviewSchema = z.object({
  stage: interviewStageSchema,
  position: z.number().int().min(0),
})

export type InterviewStage = z.infer<typeof interviewStageSchema>
export type InterviewDto = z.infer<typeof interviewSchema>
export type CreateInterviewDto = z.infer<typeof createInterviewSchema>
export type UpdateInterviewDto = z.infer<typeof updateInterviewSchema>
export type MoveInterviewDto = z.infer<typeof moveInterviewSchema>

// ---------------------------------------------------------------------------
// HR summary DTO (HR dashboard / HR-хаб)
// ---------------------------------------------------------------------------
//
// KPI snapshot for the HR рекрутинг хаб-дашборд (and ADMIN, who sees the same
// recruiting scope). Surfaced by GET /api/interviews/hr-summary — RBAC: HR +
// ADMIN only; every other role gets 403 (the endpoint would otherwise leak
// team-scoped recruiting figures).
//
// Fields:
//   openInterviews  — number of interview cards still in an ACTIVE stage (every
//                     stage except the terminal HIRED / REJECTED / ARCHIVED),
//                     scoped to the boards the HR can access (own teams' seniors
//                     via getAccessibleSeniorIds; ADMIN sees all).
//   hiredThisMonth  — number of interviews that reached the HIRED stage during
//                     the current calendar month (UTC boundary, by updatedAt),
//                     within the same team-scope.
//   activeProjects  — number of non-archived projects whose seniorId belongs to
//                     the HR's accessible seniors (HR-scoped; ADMIN sees all).
//                     Uses the same team-scope logic as openInterviews.
export const salaryStatusSchema = z.enum(['PENDING', 'PAID', 'LOCKED'])

// Single source of truth for the «my salary status» payload, shared by BOTH the
// HR summary (interviews/hr-summary) and the SENIOR summary (finance/senior-
// summary) — they surface the SAME current-month SALARY row of the caller.
//
// `currency` (task-senior-dashboard-enhance): the salary row carries its own
// transaction currency (USDT / USD / EUR / UAH). The previous DTO omitted it,
// so the dashboards hard-coded a `$` and showed e.g. a 50 000 UAH salary as
// $50 000. Surfacing the real currency lets the client format the amount in its
// OWN currency with NO conversion (50 000,00 UAH). Defined here (next to
// `salaryStatusSchema`) so both summary schemas reuse the identical shape and
// can never drift apart.
export const mySalaryStatusSchema = z
  .object({
    amount: z.number(),
    currency: currencySchema,
    status: salaryStatusSchema,
  })
  .nullable()

export const hrSummarySchema = z.object({
  openInterviews: z.number().int().nonnegative(),
  hiredThisMonth: z.number().int().nonnegative(),
  activeProjects: z.number().int().nonnegative(),
})

export type SalaryStatus = z.infer<typeof salaryStatusSchema>
export type MySalaryStatusDto = z.infer<typeof mySalaryStatusSchema>
export type HrSummaryDto = z.infer<typeof hrSummarySchema>
