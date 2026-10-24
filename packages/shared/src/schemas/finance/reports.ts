import { z } from 'zod'
import {
  mySalaryAggregateStateSchema,
  mySalaryStateSchema,
  mySalaryStatusSchema,
} from '../interviews'

// ---------------------------------------------------------------------------
// Drop role - phase 1 (task-drop-1-backend). Self-only DROP summary.
// ---------------------------------------------------------------------------
//
// Returned by `GET /api/finance/drop/me/summary` — DROP-only (every other role
// gets 403). This is the drop-facing slice of the admin/accountant
// `financeSummarySchema.dropBalances` aggregate, computed ONLY for the
// authenticated drop. It NEVER carries any other drop's figures.
//
// Fields:
//   - balance              — accrued drop share: Σ PAYOUT_DROP received − sent
//                            (the slice the drop keeps; same math as
//                            dropBalances[].balance in getSummary).
//   - dropSharePercent     — the drop's configured share % (?? default 5).
//   - pendingIncomesCount  — DROP_INCOME rows for this drop still in
//                            PENDING|VALIDATED status (= dropBalances[].pendingCount).
//   - debtToCompany        — amount the drop still owes the company for
//                            VALIDATED-but-unsettled incomes. Formula (see
//                            transactions.service `computeDropAggregate`):
//                            Σ over PAYOUT rows where senderId = drop AND
//                            status = 'PENDING_PAYMENT' of `amount`
//                            (= income × (1 − dropSharePercent/100) per income,
//                            booked at validation, cleared on company payment).
//   - pendingObligationAmount — task-drop-sees-own-obligations. The REVERSE
//                            direction of debtToCompany: money the COMPANY
//                            owes THIS drop that has been booked but not yet
//                            paid out. Σ over DROP_PENDING_PAYOUT rows where
//                            receiverId = drop AND status = 'PENDING_PAYMENT'
//                            of `amount` (booked by bookCompanyObligations on
//                            the admin-USDT declare path and the drop-payout
//                            cascade — see transactions.service). Deliberately
//                            NOT folded into `balance`: balance is money
//                            already paid (PAID PAYOUT_DROP); this is money
//                            accrued but still owed — conflating the two would
//                            make a drop with a large pending obligation and
//                            zero payouts believe nothing is owed to them.
//   - pendingObligationCount — count of the DROP_PENDING_PAYOUT rows behind
//                            `pendingObligationAmount` (mirrors pendingCount).
export const dropSelfSummarySchema = z.object({
  balance: z.number(),
  dropSharePercent: z.number().int().min(0).max(100),
  pendingIncomesCount: z.number().int().min(0),
  debtToCompany: z.number(),
  pendingObligationAmount: z.number(),
  pendingObligationCount: z.number().int().min(0),
})
export type DropSelfSummaryDto = z.infer<typeof dropSelfSummarySchema>

// ── Drop self-view DTOs (Drop role - phase 2, task-drop-2-backend) ──────────
//
// Three read-only, DROP-only data contracts consumed by the drop "My routing"
// hub + finance cabinet (design spec docs/design/drop-role-ux.md §10). Every
// endpoint behind them is self-scoped (drop sees only their own rows); these
// schemas only describe the wire shape — RBAC lives in the service.

/**
 * Drop income status — the four states the FE renders for a DROP_INCOME row.
 * Derived from the DB `transaction_status` enum (PENDING|VALIDATED|PAID|REJECTED);
 * the other DB statuses (PENDING_PAYMENT / LOCKED / PENDING_CASH_CONFIRM) never
 * apply to a DROP_INCOME income row, so they are intentionally excluded here.
 */
export const dropIncomeStatusSchema = z.enum(['pending', 'validated', 'paid', 'rejected'])
export type DropIncomeStatus = z.infer<typeof dropIncomeStatusSchema>

// GET /api/finance/drop/me/incomes — one row of the drop's income feed.
// `companyName` is the client company that paid (sourced from the income's
// senderLabel / project.companyName). `amount` is the gross income before the
// drop's share is split out.
//
// task-drop-sees-own-obligations: the feed now covers TWO income models a
// drop can carry, discriminated by `model`:
//   - 'declared'  — the old self-declared DROP_INCOME row (drop registers the
//                   income themselves; PENDING → VALIDATED → PAID lifecycle).
//   - 'obligation' — a company-booked IOU (DROP_PENDING_PAYOUT, PENDING_PAYMENT
//                   → settles IN PLACE to PAYOUT_DROP, PAID) from the
//                   admin-USDT declare path or the drop-payout cascade — see
//                   `bookCompanyObligations` in transactions.service. `status`
//                   is still one of the same four values (obligation rows only
//                   ever produce 'pending'/'paid'/'rejected' — never
//                   'validated', which is exclusively a DROP_INCOME state).
export const dropIncomeDtoSchema = z.object({
  id: z.string().uuid(),
  companyName: z.string(),
  amount: z.number(),
  currency: z.string(),
  createdAt: z.string(), // ISO date — when the row was ENTERED
  /**
   * CR-809-M-6. The operator-chosen BUSINESS date of the income, `null` for a
   * row that predates #809 (or whose author did not pick one). Since #809 this
   * — not `createdAt` — is the date the row belongs to: the feed is ordered by
   * `coalesce(tx_date, created_at)` and the from/to window filters on it, so
   * without this field the client would be sorting and bucketing by a key it
   * cannot read, and a backdated row would show a date that contradicts the
   * period it was returned for. Render `txDate ?? createdAt`.
   *
   * Masking: this feed is self-scoped — `GET /finance/drop/me/incomes` is
   * DROP-only and the query binds `receiverId = <caller>` — so the field is a
   * property of the viewer's OWN row. `createdAt` of the same row is already
   * returned here and is strictly more precise (a full timestamp, versus UTC
   * midnight for a chosen date), so exposing this adds no information class
   * the drop could not already see. The service mapper remains an explicit
   * allow-list rather than a row spread.
   */
  txDate: z.string().nullable(),
  status: dropIncomeStatusSchema,
  model: z.enum(['declared', 'obligation']),
})
export type DropIncomeDto = z.infer<typeof dropIncomeDtoSchema>

// Paginated envelope for the incomes feed. Mirrors the established
// `auditLogListSchema` shape (items + total + page + limit). `total` is the
// count BEFORE pagination so the FE can render "N income items" and page controls.
export const paginatedDropIncomesSchema = z.object({
  items: z.array(dropIncomeDtoSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
})
export type PaginatedDropIncomes = z.infer<typeof paginatedDropIncomesSchema>

// Query filters for GET /api/finance/drop/me/incomes. All optional; status/type
// narrow the feed, from/to bound the BUSINESS-date window — `coalesce(tx_date,
// created_at)`, not `created_at` (CR-809-M-6: a backdated row used to land in
// the bucket for the month it was entered) — as ISO date strings, and
// page/limit drive pagination (defaults 1 / 20). `from` is inclusive from that
// day's 00:00:00 UTC, `to` inclusive through its 23:59:59.999.
export const dropIncomesQuerySchema = z.object({
  status: dropIncomeStatusSchema.optional(),
  // task-drop-sees-own-obligations (security-review PR #523 round 1, LOW):
  // widened from `z.literal('DROP_INCOME')` — that literal became misleading
  // the moment the feed started returning DROP_PENDING_PAYOUT/PAYOUT_DROP
  // rows too (see dropIncomeDtoSchema's `model`); a caller reading this type
  // would have concluded the feed still carries one type only. `type` is
  // still not consulted in the WHERE clause — the mapped `status` filter
  // (+ the DTO's `model`) is the established narrowing knob for the FE
  // table — kept as an explicit (unused) filter field for forward-
  // compatibility, now accurately describing the three types the feed can
  // actually return instead of only the oldest one.
  type: z.enum(['DROP_INCOME', 'DROP_PENDING_PAYOUT', 'PAYOUT_DROP']).optional(),
  // SR-M-1 (security review of CR-809-M-6): `.date()`, not a bare string.
  //
  // These were unvalidated while the window was a JS filter, and a malformed
  // value was harmless there: `Date.parse('oops')` is NaN, every NaN
  // comparison is false, so the row simply fell through and the endpoint
  // answered 200. Pushing the window into SQL changes the failure mode —
  // `new Date(NaN)` becomes a bound parameter, `pg` serializes it to
  // "0NaN-NaN-NaNTNaN:NaN:NaN.NaN+NaN:NaN", and Postgres rejects the statement,
  // so the caller gets a 500 where they used to get a 200. Rejecting at the
  // boundary keeps that a 400 with a validation message.
  //
  // `z.string().date()` is exactly the YYYY-MM-DD shape both bounds already
  // assume (`Date.parse` of that string is the day's midnight UTC, and the `to`
  // bound extends it by 86_399_999 ms) — so this narrows the contract to what
  // the code always meant, rather than adding a new one.
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().max(100).optional().default(20),
})
export type DropIncomesQuery = z.infer<typeof dropIncomesQuerySchema>

// GET /api/projects/drop/me — drop-project with its income aggregate.
// `seniorDisplayName` is the senior's REAL display name (the drop coordinates
// directly with the senior — NOT masked, unlike the JUNIOR legend persona).
// `incomesCount` = number of DROP_INCOME rows the drop owns on this project.
// `status` maps project archival: active = not archived, closed = archived.
export const dropProjectDtoSchema = z.object({
  id: z.string().uuid(),
  companyName: z.string(),
  seniorDisplayName: z.string(),
  incomesCount: z.number().int().nonnegative(),
  status: z.enum(['active', 'closed']),
})
export type DropProjectDto = z.infer<typeof dropProjectDtoSchema>

/**
 * Drop payment status — the three states the FE renders for an outgoing
 * PAYOUT (drop → company). Derived from the DB `transaction_status` enum:
 * PENDING_PAYMENT → pending, PAID → confirmed, REJECTED → failed.
 */
export const dropPaymentStatusSchema = z.enum(['pending', 'confirmed', 'failed'])
export type DropPaymentStatus = z.infer<typeof dropPaymentStatusSchema>

// GET /api/finance/drop/me/payments — one outgoing payment (drop → company).
// `txHash` present only for crypto payments; omitted otherwise.
export const dropPaymentDtoSchema = z.object({
  id: z.string().uuid(),
  amount: z.number(),
  currency: z.string(),
  txHash: z.string().optional(),
  status: dropPaymentStatusSchema,
  createdAt: z.string(), // ISO date — when the row was ENTERED
  /**
   * CR-809-M-6, same contract and same masking argument as
   * `dropIncomeDtoSchema.txDate` above (this feed is scoped to
   * `senderId = <caller>`). Present because the payments feed is ordered by
   * `coalesce(tx_date, created_at)` as well, and a list must not be sorted by
   * a date its reader cannot see. Render `txDate ?? createdAt`.
   */
  txDate: z.string().nullable(),
})
export type DropPaymentDto = z.infer<typeof dropPaymentDtoSchema>

export const financeSummarySchema = z.object({
  totalIncome: z.number(),
  totalExpenses: z.number(),
  totalSalaries: z.number(),
  netBalance: z.number(),
  adminBalances: z.array(
    z.object({
      userId: z.string().uuid(),
      displayName: z.string(),
      balance: z.number(),
    }),
  ),
  // Drop role - phase 2. Aggregated PAYOUT_DROP credit minus debit per DROP
  // user — surfaced on the DROP user's profile / finance overview. Empty array
  // when there are no DROP users in the system. Existing UIs that ignore this
  // field stay unaffected.
  //
  // Redesign (feat/drop-balances-panel):
  //   dropSharePercent — always a number; backend applies ?? DEFAULT_DROP_SHARE_PERCENT
  //                      before returning, so null never reaches the client.
  //   pendingCount     — number of DROP_INCOME rows in PENDING|VALIDATED
  //                      status for this drop. Used by the "N pending" badge.
  dropBalances: z
    .array(
      z.object({
        userId: z.string().uuid(),
        displayName: z.string(),
        balance: z.number(),
        dropSharePercent: z.number().int().min(0).max(100),
        pendingCount: z.number().int().min(0),
      }),
    )
    .default([]),
  monthly: z.array(
    z.object({
      month: z.string(),
      income: z.number(),
      expenses: z.number(),
      salaries: z.number(),
      profit: z.number(),
    }),
  ),
})
export type FinanceSummaryDto = z.infer<typeof financeSummarySchema>

// ---------------------------------------------------------------------------
// Accountant summary DTO (ACCOUNTANT Sprint 1)
// ---------------------------------------------------------------------------
//
// KPI snapshot for the ACCOUNTANT financial hub dashboard (and ADMIN, who sees
// the same financial scope). Surfaced by GET /api/finance/accountant-summary —
// RBAC: ACCOUNTANT + ADMIN only; every other role gets 403 (the endpoint would
// otherwise leak company-wide payment-validation figures).
//
// All amounts are USD-equivalent (numeric → JS number, scaled-integer accumulation
// in the service to avoid float drift). Counts are non-negative integers.
//
// Fields:
//   pendingValidation   — income rows (SENIOR_INCOME + DROP_INCOME) still in
//                         PENDING status, i.e. awaiting accountant validation.
//                         { count, amount }.
//   validatedThisMonth  — rows the accountant VALIDATED in the current calendar
//                         month (by `validatedAt`). { count, amount }.
//   paidThisMonth       — income/payout money settled (status PAID) whose
//                         `createdAt` falls in the current month. { amount }.
//   recipientCount      — number of distinct income parties (seniors / drops)
//                         whose finances the accountant oversees.
export const accountantSummarySchema = z.object({
  pendingValidation: z.object({
    count: z.number().int().nonnegative(),
    amount: z.number(),
  }),
  validatedThisMonth: z.object({
    count: z.number().int().nonnegative(),
    amount: z.number(),
  }),
  paidThisMonth: z.object({
    amount: z.number(),
  }),
  recipientCount: z.number().int().nonnegative(),
})
export type AccountantSummaryDto = z.infer<typeof accountantSummarySchema>

// ---------------------------------------------------------------------------
// Senior summary DTO (SENIOR dashboard / senior hub dashboard)
// ---------------------------------------------------------------------------
//
// KPI snapshot for the SENIOR role dashboard (and ADMIN, for debugging — they
// see the SAME self-scoped figures the SENIOR they impersonate would see; the
// endpoint is STRICTLY scoped to currentUser.id, so a senior can NEVER read
// another senior's projects / income / payouts). Surfaced by
// GET /api/finance/senior-summary — RBAC: SENIOR + ADMIN only; every other role
// (JUNIOR / HR / ACCOUNTANT / DROP) gets 403.
//
// Content chosen by USER (only this — no "team" / "interviews"):
//   1. "My projects + income"  → activeProjects + seniorShareIncome.
//   2. "Status of my payouts"  → pendingPayouts + mySalaryStatus.
//
// Fields:
//   activeProjects     — the caller's OWN active (archivedAt IS NULL) senior-
//                        projects (seniorId === self), each with the effective
//                        senior share % resolved from the project override →
//                        user default. `count` is the list length (convenience
//                        for the KPI card).
//   seniorShareIncome  — the caller's senior SHARE of PAID SENIOR_INCOME on
//                        their own projects (amount * sharePercent/100), summed
//                        over all time (`total`) and the current calendar month
//                        (`thisMonth`, by `txDate ?? createdAt`). Mirrors the
//                        getTotalEarned SENIOR gate (PAID SENIOR_INCOME) but
//                        reports the senior's NET share, not the gross income.
//   pendingPayouts     — the caller's own `payout_requests` still in PENDING
//                        status. { count, amount } where amount = Σ payableAmount
//                        (what the senior still owes / is queued to settle).
//   mySalaryStatus     — the caller's OWN SALARY transaction for the current
//                        month (receiver = self), or null. Same shape/semantics
//                        as the HR dashboard's mySalaryStatus.
export const seniorActiveProjectSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  companyName: z.string(),
  sharePercent: z.number().int().min(0).max(100),
})

// task-senior-stats-block — "Earnings statistics" block on the SENIOR dashboard.
// One `{ month, amount }` point per recent calendar month for the "Total
// earned" sparkline. `month` is the UTC `YYYY-MM` key (oldest → newest);
// `amount` is the senior's NET SHARE of PAID SENIOR_INCOME credited that month
// (same snapshot-share math as `seniorShareIncome` — reuses the same rows). A
// month with no income contributes a 0 point so the sparkline keeps a stable
// length / x-axis (no gaps).
export const seniorMonthlyEarningSchema = z.object({
  month: z.string(), // 'YYYY-MM' (UTC)
  amount: z.number(),
})

// task-senior-stats-block — "Earnings statistics". Self-scoped earnings stats
// surfaced ALONGSIDE the existing KPI fields (additive — every #234/#235 field
// is preserved). Intentionally carries NO money "expected" figure: the real
// arriving amount depends on each company's payment method / FOP-tax handling /
// the junior's worked days, so only the per-company arrival PROGRESS (X/N) is
// reported (USER decision). All figures are the senior's NET share in USD (same
// `currency: 'USD'` display label as `seniorShareIncome`, no conversion).
export const seniorEarningsStatsSchema = z.object({
  // Senior's NET share of PAID SENIOR_INCOME for the PREVIOUS calendar month.
  lastMonthIncome: z.number(),
  // ~6-8 most-recent months (oldest → newest) for the "Total" sparkline.
  monthlyHistory: z.array(seniorMonthlyEarningSchema),
  // Per-company arrival progress for the CURRENT month — NOT money. `total` =
  // active own projects (each = a company paying monthly); `received` = how many
  // of them ALREADY have ≥1 PAID SENIOR_INCOME dated this month. Render as "X/N
  // companies reporting income". `received` ≤ `total`.
  companyIncomeProgress: z.object({
    received: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
})

export const seniorSummarySchema = z.object({
  activeProjects: z.object({
    count: z.number().int().nonnegative(),
    items: z.array(seniorActiveProjectSchema),
  }),
  seniorShareIncome: z.object({
    total: z.number(),
    thisMonth: z.number(),
    currency: z.literal('USD'),
  }),
  pendingPayouts: z.object({
    count: z.number().int().nonnegative(),
    amount: z.number(),
  }),
  // DEPRECATED — see the module comment on `mySalaryStatusSchema` in
  // interviews.ts (security-review MED-3, task-salary-month-gap-and-status):
  // kept byte-identical to the pre-E-6 shape so an already-loaded old client
  // bundle does not crash on today's response. Use `mySalaryState` instead.
  mySalaryStatus: mySalaryStatusSchema,
  // task-salary-month-gap-and-status (E-6) — the actual, disambiguated field.
  // See the module comment on `mySalaryStateSchema` in interviews.ts.
  mySalaryState: mySalaryStateSchema,
  // Multipart details are additive so stale pre-multipart clients can keep
  // parsing the byte-compatible mySalaryState field above. Optional on the
  // client schema also tolerates a rollback to an older API during deployment.
  mySalaryAggregateState: mySalaryAggregateStateSchema.optional(),
  // task-senior-stats-block — earnings statistics ("Earnings statistics").
  earningsStats: seniorEarningsStatsSchema,
})

export type SeniorActiveProjectDto = z.infer<typeof seniorActiveProjectSchema>
export type SeniorMonthlyEarningDto = z.infer<typeof seniorMonthlyEarningSchema>
export type SeniorEarningsStatsDto = z.infer<typeof seniorEarningsStatsSchema>
export type SeniorSummaryDto = z.infer<typeof seniorSummarySchema>

// ---------------------------------------------------------------------------
// Income compliance overview DTO ("Income control" — task-income-compliance)
// ---------------------------------------------------------------------------
//
// Company-wide control surface for ADMIN + ACCOUNTANT: "which income
// receivers have NOT yet reported income for the month". Surfaced by
// GET /api/finance/income-compliance?month=YYYY-MM — RBAC: ADMIN + ACCOUNTANT
// only; every other role (SENIOR / JUNIOR / HR / DROP) gets 403. This is an
// AGGREGATE over MANY income receivers (NOT self-scoped), so it must never reach
// a non-privileged caller — both a @Roles gate AND a service-side role check
// guard it (defense-in-depth, same pattern as getAccountantSummary).
//
// Receivers = SENIOR + ADMIN-as-senior (projects.seniorId) AND DROP
// (projects.dropId). Only receivers with ≥1 active (archivedAt IS NULL) project
// appear (a drop with no active drop-projects has N=0 → excluded, R5).
//
// "Income reported for a project" (owner decision, task-file) = at least one
// income row of the matching type (SENIOR_INCOME / ADMIN_INCOME / DROP_INCOME)
// exists for the project with status VALIDATED|PAID and `(txDate ?? createdAt)`
// within the target month (UTC). PENDING does NOT count as reported — but a
// project whose only row this month is PENDING is flagged `pendingValidation: true`
// (a small "pending validation" badge). REJECTED is ignored.
//
// task-compliance-overview-pending-types (2026-08-16, owner decision — see the
// task file's "live symptom from prod"). On the current USDT admin-declare path
// a SENIOR/DROP never submits SENIOR_INCOME/DROP_INCOME themselves — the ADMIN's
// declaration atomically books the company's OBLIGATION to them instead
// (`SENIOR_PENDING_PAYOUT` / `DROP_PENDING_PAYOUT`, status PENDING_PAYMENT).
// That obligation later settles IN PLACE — `settleByCompany` flips the SAME row
// to `SENIOR_INCOME`/PAID for a senior (already covered by the original
// criterion) or to `PAYOUT_DROP`/PAID for a drop (a THIRD type, never covered
// before this task — see `pending-settlement.service.ts`). A widget that only
// ever looked for the three self-declare types therefore judged this entire
// (majority, USDT) path as "nothing submitted, forever" for both the in-flight
// obligation AND its settled/paid outcome — flagging a person who did nothing
// wrong, and never able to fix it (`DROP_INCOME` cannot even be created on a
// USDT project — `createDropIncome` rejects it).
//
// Owner decision on what an in-flight (booked, not yet paid) obligation means
// for this widget: NOT `submitted` (it is a debt, not received money — AC2,
// "accrued and received are distinguishable") and NOT `lagging` either (false alarm
// on someone who did nothing wrong is worse than omission — see the task file).
// It gets its OWN third state, `accrued`, tracked in separate counters
// (`accruedCount` / `totals.accruedProjects`) so it is never silently folded
// into either `submitted` or `pendingCount` (which keeps meaning exactly what
// it always meant: a self-declared income still awaiting accountant
// validation — a DIFFERENT wait, on a DIFFERENT party).

// Role label on a receiver row — drives the UI sub-label (senior / admin-as-
// senior / drop). 'ADMIN_SENIOR' = an ADMIN user who owns projects as their
// senior (income type ADMIN_INCOME, written PAID immediately).
export const incomeComplianceRoleSchema = z.enum(['SENIOR', 'ADMIN_SENIOR', 'DROP'])
export type IncomeComplianceRole = z.infer<typeof incomeComplianceRoleSchema>

// One project under a receiver. `submitted` = has a VALIDATED|PAID income (or a
// SETTLED obligation — SENIOR_INCOME/PAYOUT_DROP, PAID) this month. Also
// `submitted` when a self-declare SENIOR_INCOME/DROP_INCOME row is already
// VALIDATED but currently flipped to PENDING_PAYMENT by `createPayoutRequest`
// (a payout was requested — the income itself was already earned; see the
// type-aware classification in `getIncomeComplianceOverview`, security-review
// PR #531 MED-2 — PENDING_PAYMENT is NOT exclusive to a booked obligation).
// `pendingValidation` = has ONLY a self-declared PENDING income this month
// (awaiting the ACCOUNTANT). `accrued` = has ONLY a company-booked obligation
// (SENIOR_PENDING_PAYOUT/DROP_PENDING_PAYOUT — never a self-declare type)
// still PENDING_PAYMENT this month (awaiting the COMPANY's payout — nothing for
// this receiver to do). A project is `submitted`, OR `accrued`, OR
// `pendingValidation`, OR none of the three (genuinely missing) — never two at
// once.
// security-review PR #531 (LOW-2): `accrued` is `.default(false)` — see the
// matching note on `incomeComplianceReceiverSchema.accruedCount` below for the
// full reasoning (identical for both: `.parse()` INPUT tolerance, not a
// producer-contract change).
export const incomeComplianceProjectSchema = z.object({
  projectId: z.string().uuid(),
  name: z.string(),
  companyName: z.string(),
  submitted: z.boolean(),
  pendingValidation: z.boolean(),
  accrued: z.boolean().default(false),
})
export type IncomeComplianceProjectDto = z.infer<typeof incomeComplianceProjectSchema>

// One income receiver. `expected` (N) = active projects; `submitted` (X) =
// projects with a counted (VALIDATED|PAID, or settled-obligation PAID) income
// this month. `missingProjects` = the projects WITHOUT a counted income (for
// the expand drawer), each flagged whether it is merely pending validation or
// merely an unpaid accrued obligation. `pendingCount` = how many of the
// missing projects await accountant validation (self-declared PENDING).
// `accruedCount` = how many of the missing projects have an unpaid
// company-booked obligation instead (PENDING_PAYMENT) — kept as its OWN counter,
// never summed into `submitted` or `pendingCount` (AC2).
//
// security-review PR #531 (LOW-2, owner decision): `accruedCount` is
// `.default(0)` — and so is `totals.accruedProjects` below. This is an
// INPUT-side (`.parse()`) tolerance, not a change to what the PRODUCER
// (this API endpoint) sends — it always populates all three fields, so the
// OUTPUT type (`z.infer`, what every call site's TypeScript works against)
// stays exactly as strict as it was: a plain `number`/`boolean`, never
// `| undefined`. What it buys: if `.parse()` is ever run against a response
// that predates this field (a rolling-deploy version-mismatch window, or any
// future defensive re-parse of a cached/stale payload), the missing field
// resolves to the SAFE reading — "no accrual information available" reads as
// 0/false, not a hard validation crash that blanks the whole widget. That is
// the same "absence over false alarm" principle the rest of this task is
// built on, applied to the wire contract itself. `submitted`/`pendingCount`/
// the pre-existing `totals` fields are deliberately LEFT without a default —
// they predate this task and changing their strictness is out of scope here.
export const incomeComplianceReceiverSchema = z.object({
  userId: z.string().uuid(),
  displayName: z.string(),
  role: incomeComplianceRoleSchema,
  expected: z.number().int().nonnegative(),
  submitted: z.number().int().nonnegative(),
  pendingCount: z.number().int().nonnegative(),
  accruedCount: z.number().int().nonnegative().default(0),
  missingProjects: z.array(incomeComplianceProjectSchema),
})
export type IncomeComplianceReceiverDto = z.infer<typeof incomeComplianceReceiverSchema>

// The full overview. `month` is the resolved target month (UTC 'YYYY-MM').
// `totals` is the company roll-up for the KPI strip. `receivers` is sorted
// laggards-first (least coverage on top) by the service.
export const incomeComplianceOverviewSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/, "Expected 'YYYY-MM' format"), // 'YYYY-MM' (UTC)
  totals: z.object({
    // Σ expected projects across all receivers (the denominator of "X/N reported").
    expectedProjects: z.number().int().nonnegative(),
    // Σ submitted (VALIDATED|PAID, or settled-obligation PAID) projects this month.
    submittedProjects: z.number().int().nonnegative(),
    // Receivers who have ≥1 missing project (X < N).
    laggingReceivers: z.number().int().nonnegative(),
    // Receivers whose every active project has a counted income (X === N).
    completeReceivers: z.number().int().nonnegative(),
    // Projects whose only income this month is still PENDING (pending validation).
    pendingProjects: z.number().int().nonnegative(),
    // Projects whose only evidence this month is an unpaid, company-booked
    // obligation (accrued — "booked, awaiting payout"). Never folded into
    // `submittedProjects` or `pendingProjects` (AC2). `.default(0)` — see the
    // matching note on `incomeComplianceReceiverSchema.accruedCount`.
    accruedProjects: z.number().int().nonnegative().default(0),
  }),
  receivers: z.array(incomeComplianceReceiverSchema),
})
export type IncomeComplianceOverviewDto = z.infer<typeof incomeComplianceOverviewSchema>

// Query schema for the optional ?month=YYYY-MM param. Defaults handled in the
// service (current UTC month) when absent.
export const incomeComplianceQuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month must be YYYY-MM')
    .optional(),
})

export type IncomeComplianceQuery = z.infer<typeof incomeComplianceQuerySchema>
