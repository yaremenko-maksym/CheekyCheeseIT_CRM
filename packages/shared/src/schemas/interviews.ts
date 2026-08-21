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

// Single source of truth for the «my salary status» payload. Currently
// surfaced ONLY by the SENIOR summary (finance/senior-summary) — the HR
// summary field of the same name was removed (see hr-summary.integration.spec
// «schema has no mySalaryStatus field»). Kept here (not inlined in finance.ts)
// so a future re-add for HR reuses the identical shape instead of drifting.
//
// task-salary-month-gap-and-status (E-6): a bare `.nullable()` collapsed TWO
// different truths into the same wire value — "this role never gets a salary"
// (no `monthlySalary` configured) and "a salary IS configured but this
// month's row has not been created yet" (cron gap, see E-5) both read back as
// `null`. A person investigating "why is this null" on a live incident could
// not tell the two apart from the API response alone (see
// project_salary_cron_prod_config_gap memory — the exact same ambiguity, one
// level up, cost a live investigation). Replaced with an explicit
// discriminated union so the three states are distinguishable BY SHAPE, not
// by re-deriving them from other endpoints:
//   - NOT_CONFIGURED     — `users.monthlySalary` is not set for this person;
//                          no SALARY row will ever be created for them by the
//                          monthly cron.
//   - AWAITING_CREATION  — `monthlySalary` IS set, but no SALARY row exists
//                          yet for the requested month (cron has not run yet
//                          this month, or the month was missed — see E-5's
//                          gap report for making that visible company-wide).
//   - EXISTS             — the row exists; same fields as before (`currency`,
//                          task-senior-dashboard-enhance: the salary row
//                          carries its own transaction currency (USDT / USD /
//                          EUR / UAH) so the client formats the amount in its
//                          OWN currency, no hard-coded `$`).
export const mySalaryStatusSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('NOT_CONFIGURED') }),
  z.object({ state: z.literal('AWAITING_CREATION') }),
  z.object({
    state: z.literal('EXISTS'),
    amount: z.number(),
    currency: currencySchema,
    status: salaryStatusSchema,
  }),
])

export const hrSummarySchema = z.object({
  openInterviews: z.number().int().nonnegative(),
  hiredThisMonth: z.number().int().nonnegative(),
  activeProjects: z.number().int().nonnegative(),
})

export type SalaryStatus = z.infer<typeof salaryStatusSchema>
export type MySalaryStatusDto = z.infer<typeof mySalaryStatusSchema>
export type HrSummaryDto = z.infer<typeof hrSummarySchema>
