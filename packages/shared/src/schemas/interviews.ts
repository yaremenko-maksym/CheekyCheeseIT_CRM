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

// DEPRECATED — kept BYTE-IDENTICAL to the pre-E-6 shape (nullable, no `state`
// key) for backward compatibility with an already-loaded OLD frontend bundle.
//
// task-salary-month-gap-and-status security-review MED-3: the client does a
// STRICT `seniorSummarySchema.parse()` (use-senior-summary.ts) — a shape
// mismatch on ANY field throws and fails the WHOLE query, not just this one.
// An open browser tab running yesterday's JS still parses TODAY's API
// response the moment it refetches; changing this field's TYPE (not just
// adding to it) would crash that tab's entire SENIOR dashboard the instant
// the backend deploys, for every SENIOR without `monthlySalary` set (i.e.
// nearly all of them — see `mySalaryStateSchema` below for why). Reusing the
// SAME field name for the new shape was tried first and rejected for exactly
// this reason. Instead: this field stays computed EXACTLY as before (null
// unless a valid row exists), and the disambiguation this task set out to
// fix lives on the NEW, ADDITIVE `mySalaryState` field — an old client that
// doesn't know about `mySalaryState` simply ignores it (Zod objects here are
// not `.strict()`; unknown keys are dropped, not rejected).
//
// Not removed outright either: removing a REQUIRED key an old client's
// schema still expects fails it exactly the same way as reshaping it. Safe
// to delete once no stale client is a plausible concern (a later, separate
// cleanup task — this file is not the place to decide that clock).
export const mySalaryStatusSchema = z
  .object({
    amount: z.number(),
    currency: currencySchema,
    status: salaryStatusSchema,
  })
  .nullable()

// task-salary-month-gap-and-status (E-6) — the actual fix, additive (see the
// deprecation note on `mySalaryStatusSchema` above for why it is a NEW field
// rather than a reshape of the old one). A bare `.nullable()` collapsed
// several different truths into the same wire value — "this role never gets
// a salary" (no `monthlySalary` configured), "this role IS configured but
// the monthly cron does not process it at all" (SENIOR/DROP — see
// `SALARY_ELIGIBLE_ROLES`: they CAN receive a manually-created salary, but
// `createMonthlySalaries` never auto-accrues one for them), and "a salary IS
// configured for a cron-processed role but this month's row has not been
// created yet" (cron gap, see E-5) — all three read back as `null` before
// this task. A person investigating "why is this null" on a live incident
// could not tell them apart from the API response alone (see
// project_salary_cron_prod_config_gap memory — the exact same ambiguity, one
// level up, cost a live investigation). Replaced with an explicit
// discriminated union so every state is distinguishable BY SHAPE:
//   - NOT_CONFIGURED     — `users.monthlySalary` is not set for this person.
//   - NOT_CRON_ELIGIBLE  — `monthlySalary` IS set, but this person's ROLE is
//                          not one `createMonthlySalaries` processes at all
//                          (only HR/ACCOUNTANT/JUNIOR are cron-eligible —
//                          SENIOR/DROP can only ever get a MANUALLY created
//                          salary). Distinct from AWAITING_CREATION: there is
//                          no cron run, past or future, that will ever fill
//                          this in on its own.
//   - AWAITING_CREATION  — `monthlySalary` IS set AND the role IS cron-
//                          eligible, but no SALARY row exists yet for the
//                          requested month (cron has not run yet this month,
//                          or the month was missed — see E-5's gap report for
//                          making that visible company-wide).
//   - EXISTS             — the row exists; same fields as the deprecated
//                          field above (`currency`, task-senior-dashboard-
//                          enhance: the salary row carries its own
//                          transaction currency (USDT / USD / EUR / UAH) so
//                          the client formats the amount in its OWN currency,
//                          no hard-coded `$`).
// Stryker disable next-line ArrayDeclaration: this array literal is evaluated ONCE at module-import time (schema construction), before any test's per-test coverage window opens, so Stryker's vitest-runner falls back to a single whole-suite run for this "static" mutant and reports 0 tests completed. Verified independently outside Stryker's sandbox (plain node, this repo's exact zod@4.3.6): `z.discriminatedUnion('state', [])` throws synchronously inside `new ZodDiscriminatedUnion` the instant the module is imported — every test file importing anything from interviews.ts would fail to even load (reproduced: `TypeError: Cannot read properties of undefined (reading '_zod')` inside zod's own core.js, before a single test in this file runs). Not an equivalent mutant (it deletes all 4 states, a severe regression); real behavioural tests exist for all 4 variants in interviews.spec.ts — they just cannot register as "covering" a construction-time literal, the same tool blind spot documented for the sibling `z.union([])` case in finance.ts.
export const mySalaryStateSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('NOT_CONFIGURED') }),
  z.object({ state: z.literal('NOT_CRON_ELIGIBLE') }),
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
export type MySalaryStateDto = z.infer<typeof mySalaryStateSchema>
export type HrSummaryDto = z.infer<typeof hrSummarySchema>
