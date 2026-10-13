import type { Page } from '@playwright/test'
import { REAL_API_BASE, SEED_EMAILS, withThrottleRetry } from './common'
import { loginViaApi, findUserByEmailViaApi } from './auth'
import { getUserViaAPI } from './drop'

// ---------------------------------------------------------------------------
// Phase 2 real-API helpers (task-drop-phase2-e2e — AC1)
// ---------------------------------------------------------------------------
//
// These helpers extend the Phase 1 real-API surface to cover the Phase 2
// distribution flow:
//   - createDropProjectViaAPI — POST /api/projects with `dropId` set; the
//     backend marks the project as a drop-project and `payPayoutRequest`
//     routes its income through `computeDropDistribution`.
//   - createDropIncomeViaAPI — POST /api/transactions/drop-income; only the
//     DROP user routed by `project.dropId` may call this. Inserts a PENDING
//     DROP_INCOME row.
//   - validateTransactionViaAPI — PATCH /api/transactions/:id/validate;
//     ACCOUNTANT/ADMIN-only. Flips DROP_INCOME→VALIDATED, creates the
//     payout_request + placeholder PAYOUT row. The drop distribution math
//     fires later when `payPayoutRequest` is called.
//
// All helpers expect a real backend (CI seeds + migrations) and the caller
// is responsible for `loginViaApi(page, ...)` before invoking. They throw on
// any non-2xx response so tests fail fast.

/**
 * Confirm a DRAFT project as one of its invited approvers via
 * POST /api/projects/:id/approve — task-project-draft-status. A fresh
 * project starts DRAFT and refuses income (400 «Проект ещё не
 * подтверждён») until EVERY invited approver (the project's senior, and
 * its drop when it has one) confirms — see `projects.service.ts`'s
 * `approveDraft`/`applyApprovalAggregate`.
 *
 * Switches the page's session to `approverEmail` (dev-login cookie swap,
 * same mechanism as `loginViaApi`) because only an INVITED approver may
 * call this — an ADMIN who is not the project's senior/drop gets 404
 * (`ApprovalsService` treats a non-invited caller as "no such approval
 * row", the same existence-oracle contract `assertAccess` uses for
 * visibility). Caller is responsible for restoring whatever session it
 * needs afterward (mirrors `onboardDropViaAPI`'s own contract).
 */
export async function approveProjectViaAPI(
  page: Page,
  projectId: string,
  approverEmail: string,
): Promise<{ id: string; status: string }> {
  await loginViaApi(page, approverEmail)
  const res = await withThrottleRetry(
    () => page.request.post(`${REAL_API_BASE}/api/projects/${projectId}/approve`),
    `approveProjectViaAPI(${approverEmail})`,
  )
  if (res.status() !== 200 && res.status() !== 201) {
    throw new Error(
      `approveProjectViaAPI failed for ${approverEmail}: HTTP ${res.status()} — ${await res.text()}`,
    )
  }
  return (await res.json()) as { id: string; status: string }
}

/**
 * Decline a DRAFT project as one of its invited approvers via
 * POST /api/projects/:id/reject — mirror of `approveProjectViaAPI` for the
 * rejection branch. Voids the WHOLE approval proposal (not just this
 * approver's own row) and the project becomes `REJECTED` — same
 * income-refusal gate as DRAFT (`assertProjectActive` refuses both).
 */
export async function rejectProjectViaAPI(
  page: Page,
  projectId: string,
  approverEmail: string,
  reason: string,
): Promise<{ id: string; status: string }> {
  await loginViaApi(page, approverEmail)
  const res = await withThrottleRetry(
    () =>
      page.request.post(`${REAL_API_BASE}/api/projects/${projectId}/reject`, {
        data: { reason },
      }),
    `rejectProjectViaAPI(${approverEmail})`,
  )
  if (res.status() !== 200 && res.status() !== 201) {
    throw new Error(
      `rejectProjectViaAPI failed for ${approverEmail}: HTTP ${res.status()} — ${await res.text()}`,
    )
  }
  return (await res.json()) as { id: string; status: string }
}

/**
 * Create a project via POST /api/projects with an explicit `dropId`.
 *
 * Caller must be ADMIN-authenticated. The senior referenced by
 * `seniorEmail` and the drop by `dropId` must already exist in DB.
 *
 * Defaults:
 *   - rate: 5000
 *   - currency: 'USDT'
 *   - domain: 'AI / ML'
 *   - startDate: now (ISO)
 *   - companyName: 'Drop Phase 2 Co'
 *
 * Returns the created project id + dropId for downstream assertions.
 *
 * task-project-draft-status: the created project starts DRAFT and refuses
 * income (400 `PROJECT_NOT_ACTIVE`) until both the senior and the
 * drop confirm it. By default this helper drives it through that real
 * confirmation flow (POST /api/projects/:id/approve as each approver, via
 * `approveProjectViaAPI`) before returning, so every EXISTING call site
 * keeps behaving exactly as it did before this column shipped — the
 * returned project is immediately usable for income. Pass
 * `skipApproval: true` when the test itself needs to observe the DRAFT
 * state (see `project-draft-status.spec.ts`).
 */
export async function createDropProjectViaAPI(
  page: Page,
  opts: {
    dropId: string
    seniorEmail?: string
    name?: string
    companyName?: string
    rate?: number
    currency?: 'USDT' | 'USD' | 'EUR' | 'UAH'
    domain?: string
    startDate?: string
    seniorSharePercentOverride?: number | null
    /**
     * task-drop-share-e2e. Optional project payment-type (ADR
     * 2026-07-13-payment-type-income-routing D1). Absent → backend default
     * 'FOP'. Pass 'USDT' to provision an admin-USDT-declaration fixture
     * (paired with `dropSharePercentOverride` below for Flow 4 assertions).
     */
    paymentType?: 'FOP' | 'GIG_CONTRACT' | 'USDT'
    dropSharePercentOverride?: number | null
    /** task-project-draft-status. Leave the project DRAFT — see doc above. */
    skipApproval?: boolean
  },
): Promise<{ projectId: string; dropId: string; seniorId: string }> {
  const seniorEmail = opts.seniorEmail ?? SEED_EMAILS.seniorA
  const senior = await findUserByEmailViaApi(page, seniorEmail)
  if (!senior) throw new Error(`Senior seed user not found: ${seniorEmail}`)

  const payload = {
    name: opts.name ?? `Drop Phase 2 Project ${Date.now()}`,
    companyName: opts.companyName ?? 'Drop Phase 2 Co',
    domain: opts.domain ?? 'AI / ML',
    seniorId: senior.id,
    dropId: opts.dropId,
    rate: opts.rate ?? 5000,
    currency: opts.currency ?? 'USDT',
    startDate: opts.startDate ?? new Date().toISOString(),
    ...(opts.seniorSharePercentOverride !== undefined && {
      seniorSharePercentOverride: opts.seniorSharePercentOverride,
    }),
    ...(opts.paymentType !== undefined && { paymentType: opts.paymentType }),
    ...(opts.dropSharePercentOverride !== undefined && {
      dropSharePercentOverride: opts.dropSharePercentOverride,
    }),
  }

  const res = await page.request.post(`${REAL_API_BASE}/api/projects`, { data: payload })
  if (res.status() !== 201 && res.status() !== 200) {
    throw new Error(`createDropProjectViaAPI failed: HTTP ${res.status()} — ${await res.text()}`)
  }
  const body = (await res.json()) as { id: string; dropId: string | null; seniorId: string }
  if (!body.dropId) {
    throw new Error(`Created project missing dropId: ${JSON.stringify(body)}`)
  }

  if (!opts.skipApproval) {
    const dropUser = await getUserViaAPI(page, body.dropId)
    await approveProjectViaAPI(page, body.id, seniorEmail)
    await approveProjectViaAPI(page, body.id, dropUser.email)
    // Restore ADMIN session — every call site logs in as ADMIN right before
    // calling this helper (same contract `onboardDropViaAPI` uses).
    await loginViaApi(page, SEED_EMAILS.admin)
  }

  return { projectId: body.id, dropId: body.dropId, seniorId: body.seniorId }
}

/**
 * Create a regular SENIOR project (no dropId) via POST /api/projects.
 *
 * Mirror of `createDropProjectViaAPI` but omits `dropId` entirely — the
 * backend treats this as a regression-safe senior-project. Used by the
 * regression spec to assert that NO PAYOUT_DROP rows are produced.
 *
 * task-project-draft-status: same DRAFT-then-auto-confirm contract as
 * `createDropProjectViaAPI` (there being no drop here, only the senior's
 * own confirmation is needed) — see that function's doc for the full
 * reasoning and the `skipApproval` escape hatch.
 */
export async function createSeniorProjectViaAPI(
  page: Page,
  opts: {
    seniorEmail?: string
    name?: string
    companyName?: string
    rate?: number
    currency?: 'USDT' | 'USD' | 'EUR' | 'UAH'
    domain?: string
    startDate?: string
    /** task-project-draft-status. Leave the project DRAFT. */
    skipApproval?: boolean
  } = {},
): Promise<{ projectId: string; seniorId: string }> {
  const seniorEmail = opts.seniorEmail ?? SEED_EMAILS.seniorA
  const senior = await findUserByEmailViaApi(page, seniorEmail)
  if (!senior) throw new Error(`Senior seed user not found: ${seniorEmail}`)

  const payload = {
    name: opts.name ?? `Senior Regression Project ${Date.now()}`,
    companyName: opts.companyName ?? 'Senior Regression Co',
    domain: opts.domain ?? 'AI / ML',
    seniorId: senior.id,
    rate: opts.rate ?? 5000,
    currency: opts.currency ?? 'USDT',
    startDate: opts.startDate ?? new Date().toISOString(),
  }

  const res = await page.request.post(`${REAL_API_BASE}/api/projects`, { data: payload })
  if (res.status() !== 201 && res.status() !== 200) {
    throw new Error(`createSeniorProjectViaAPI failed: HTTP ${res.status()} — ${await res.text()}`)
  }
  const body = (await res.json()) as { id: string; seniorId: string }

  if (!opts.skipApproval) {
    await approveProjectViaAPI(page, body.id, seniorEmail)
    // Restore ADMIN session — every call site logs in as ADMIN right before
    // calling this helper (same contract `onboardDropViaAPI` uses).
    await loginViaApi(page, SEED_EMAILS.admin)
  }

  return { projectId: body.id, seniorId: body.seniorId }
}
