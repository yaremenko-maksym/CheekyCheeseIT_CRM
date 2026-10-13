import type { Page } from '@playwright/test'
import { REAL_API_BASE } from './common'

/**
 * Create a payout_request for a set of VALIDATED SENIOR_INCOME transactions
 * via POST /api/payout-requests.
 *
 * feat/finance-payout-flow (#7): validateTransaction for SENIOR_INCOME no
 * longer auto-creates a payout_request. The SENIOR must call this endpoint
 * manually (or via the UI PayoutDialog) to batch one or more VALIDATED incomes
 * into a single payout. This helper replaces the implicit assumption that
 * validateTransactionViaAPI returns a non-null payoutRequestId for
 * SENIOR_INCOME flows.
 *
 * Caller must be SENIOR. Returns the new payout_request id.
 */
export async function createPayoutRequestViaAPI(
  page: Page,
  transactionIds: string[],
): Promise<{ payoutRequestId: string }> {
  const res = await page.request.post(`${REAL_API_BASE}/api/payout-requests`, {
    data: { transactionIds },
  })
  if (res.status() !== 201) {
    throw new Error(`createPayoutRequestViaAPI failed: HTTP ${res.status()} — ${await res.text()}`)
  }
  const body = (await res.json()) as { id: string }
  return { payoutRequestId: body.id }
}

/**
 * Mark a PENDING payout_request as PAID via PATCH /api/payout-requests/:id/pay.
 *
 * Caller must be SENIOR or DROP (the seniorId/dropId on the payout_request
 * must match the caller). The backend books the distribution obligations:
 * for a drop-project, SENIOR_PENDING_PAYOUT + DROP_PENDING_PAYOUT (both
 * COMPANY debts, pending settle-with-receipt — task-drop-share-pending-parity,
 * 2026-07-27); a senior-project books nothing extra (the PAYOUT credit alone
 * is the whole settlement). No PAYOUT_ADMIN rows on either branch.
 *
 * Uses the dev simulate=success path so we don't need a real on-chain hash.
 */
export async function payPayoutRequestViaAPI(
  page: Page,
  payoutRequestId: string,
): Promise<{ status: string; txHash: string | null }> {
  // The pay endpoint runs the distribution cascade inside a long-running
  // transaction (multiple INSERTs + UPDATEs). Bump the per-request timeout
  // so we don't trip Playwright's default 30s/8s deadlines on busy CI.
  const res = await page.request.patch(
    `${REAL_API_BASE}/api/payout-requests/${payoutRequestId}/pay`,
    { data: { simulateResult: 'success' }, timeout: 60_000 },
  )
  // Backlog AC4 fix: the `payPayoutRequest` endpoint now returns 200 for
  // both SENIOR and DROP — `findPayoutRequest` was widened to let DROP read
  // their OWN payout_request (matching the SENIOR rule). Anything other
  // than 200 here is a real error.
  if (res.status() !== 200) {
    throw new Error(
      `payPayoutRequestViaAPI failed for ${payoutRequestId}: HTTP ${res.status()} — ${await res.text()}`,
    )
  }
  const body = (await res.json()) as { status: string; txHash: string | null }
  return { status: body.status, txHash: body.txHash }
}

/**
 * List a payout_request's transactions (full join) via
 * GET /api/payout-requests/:id. The payout_request endpoint surfaces every
 * transaction linked via `payout_request_id`, which is what tests need for
 * distribution assertions.
 *
 * Historical context (backlog AC5): PAYOUT_ADMIN rows for senior-projects
 * used to be inserted WITHOUT `projectId`, which meant a `?projectId=` filter
 * missed them — this helper was the workaround. The cascade now sets
 * `projectId` on every PAYOUT_ADMIN row (both drop and senior branches), so
 * `listTransactionsByProjectViaAPI` is also viable. This helper stays around
 * because it's still the simplest path to fetch a single payout's rows in
 * deterministic order.
 *
 * Caller must be ADMIN/ACCOUNTANT to view another user's payout request.
 * SENIOR/DROP callers can fetch their OWN payout requests (per
 * `findPayoutRequest` RBAC widened in backlog AC4).
 */
export async function listPayoutRequestTransactionsViaAPI(
  page: Page,
  payoutRequestId: string,
): Promise<
  Array<{
    id: string
    type: string
    status: string
    amount: string
    // `currency` was undeclared here even though `mapTx` has always returned
    // it (same class of gap as the `payoutRequestId` note above) — backlog
    // item 139 needed it to read the placeholder PAYOUT row's currency
    // without a second request.
    currency: string
    receiverId: string | null
    recipientId: string | null
    projectId: string | null
  }>
> {
  const res = await page.request.get(`${REAL_API_BASE}/api/payout-requests/${payoutRequestId}`)
  if (res.status() !== 200) {
    throw new Error(
      `listPayoutRequestTransactionsViaAPI failed for ${payoutRequestId}: HTTP ${res.status()} — ${await res.text()}`,
    )
  }
  const body = (await res.json()) as {
    transactions: Array<{
      id: string
      type: string
      status: string
      amount: string
      currency: string
      receiverId: string | null
      recipientId: string | null
      projectId: string | null
    }>
  }
  return body.transactions
}

/**
 * List ALL transactions for a project via GET /api/transactions?projectId=
 * — used by Phase 2 specs to assert the post-payout transaction set
 * (PAYOUT/PAYOUT_DROP/PAYOUT_ADMIN amounts and types).
 *
 * The caller must be authenticated as ADMIN or ACCOUNTANT for the full
 * unfiltered list — SENIOR/DROP-scoped callers will receive a subset
 * (their own send/receive only) per the RBAC rules in TransactionsService.
 *
 * Backlog AC5 (resolved): PAYOUT_ADMIN rows for senior-projects now carry
 * `projectId` (cascade was updated to insert it explicitly), so the
 * `?projectId=` filter captures them on both drop and senior flows.
 *
 * Backlog 144 (resolved): the placeholder PAYOUT row `createPayoutRequest`
 * inserts — and the PAYOUT_CONFIRMED row `confirmPayout` snapshots from it —
 * now ALSO carry `projectId` (see `TransactionsService.createPayoutRequest`),
 * so this filter finds those too. The legacy workaround
 * (`listPayoutRequestTransactionsViaAPI`) is still useful when you want a
 * single payout's rows in deterministic order regardless of project.
 */
export async function listTransactionsByProjectViaAPI(
  page: Page,
  projectId: string,
): Promise<
  Array<{
    id: string
    type: string
    status: string
    amount: string
    // backlog 144: same undeclared-field gap as `payoutRequestId` below —
    // `mapTx` has always returned `currency`, the shape here just never said
    // so. drop-confirm-payout.spec.ts needs it now that it reads the PAYOUT
    // / PAYOUT_CONFIRMED rows straight off this helper (the `?projectId=`
    // filter finds them directly — see the fixed TRAP note above).
    currency: string
    senderId: string | null
    receiverId: string | null
    recipientId: string | null
    projectId: string | null
    // `TransactionsService.mapTx` has always returned this (transactions.service.ts
    // — `payoutRequestId: tx.payoutRequestId`); the shape above just never
    // declared it. senior-payout-no-dup.spec.ts asserts on it to prove a
    // SENIOR_INCOME is linked to the payout request that settled it — the
    // regression this whole spec exists for. Undeclared, that assertion was a
    // TS2339 nobody ran, so the link went unchecked. (task-lint-teeth)
    payoutRequestId: string | null
  }>
> {
  const res = await page.request.get(`${REAL_API_BASE}/api/transactions?projectId=${projectId}`)
  if (res.status() !== 200) {
    throw new Error(
      `listTransactionsByProjectViaAPI failed for ${projectId}: HTTP ${res.status()} — ${await res.text()}`,
    )
  }
  return (await res.json()) as Awaited<ReturnType<typeof listTransactionsByProjectViaAPI>>
}

/**
 * Update a user's senior_share_percent or drop_share_percent via PATCH
 * /api/users/:id. ADMIN-only — callers must `loginViaApi(page, admin)` first.
 *
 * Used by AC3 edge-case tests to flip a seed senior to e.g. 50% / 60% / 0%
 * for distribution math assertions. Pass `dropSharePercent` to override
 * the drop's share simultaneously.
 *
 * NOTE: This mutates a seed user! Tests that use this helper should either
 *   (a) restore the original percent in a finally{} block, or
 *   (b) use a freshly-created throwaway senior — best for parallel runs.
 * AC3 picks (b) where possible by using a different seed senior per test.
 */
export async function patchUserSharePercentViaAPI(
  page: Page,
  userId: string,
  opts: { seniorSharePercent?: number; dropSharePercent?: number },
): Promise<void> {
  const data: Record<string, number> = {}
  if (opts.seniorSharePercent !== undefined) data.seniorSharePercent = opts.seniorSharePercent
  if (opts.dropSharePercent !== undefined) data.dropSharePercent = opts.dropSharePercent
  const res = await page.request.patch(`${REAL_API_BASE}/api/users/${userId}`, { data })
  if (res.status() !== 200) {
    throw new Error(
      `patchUserSharePercentViaAPI failed for ${userId}: HTTP ${res.status()} — ${await res.text()}`,
    )
  }
}

/**
 * task-pending-share fix-round-1 (CR-H-2). Confirms a PENDING base-share
 * proposal (opened by `patchUserSharePercentViaAPI` above, which now only
 * proposes — it doesn't apply `seniorSharePercent` immediately any more) on
 * behalf of the SENIOR whose share it is.
 *
 * `POST /users/:id/senior-share/approve` requires the caller to BE the
 * invited approver — `ApprovalsService.approveInTx` matches the live row on
 * `approverUserId` taken from the SESSION, not from the request body — so
 * the caller of this helper must already be logged in (`loginViaApi`) as
 * that same senior before calling it. Default NestJS POST status is 201
 * (no `@HttpCode` override on this route, same as its `approveDraft`
 * sibling), asserted here rather than left implicit so a future
 * `@HttpCode(200)` change fails loudly instead of silently.
 */
export async function approveUserSeniorShareViaAPI(page: Page, userId: string): Promise<void> {
  const res = await page.request.post(`${REAL_API_BASE}/api/users/${userId}/senior-share/approve`)
  if (res.status() !== 201) {
    throw new Error(
      `approveUserSeniorShareViaAPI failed for ${userId}: HTTP ${res.status()} — ${await res.text()}`,
    )
  }
}

/**
 * task-pending-share fix-round-4. The PROJECT twin of
 * `approveUserSeniorShareViaAPI` above — round 1 (CR-H-2) added the user half
 * because `patchUserSharePercentViaAPI` had stopped applying immediately, and
 * the project half needed the same helper for the same reason. It was missed
 * because the ONE spec that PATCHes a project override against the real API
 * (`team-share-override.spec.ts`) is unsharded debt: CI has never executed it
 * (`scripts/devops/check-e2e-shard-coverage.py`, "Known unsharded"), so the
 * regression stayed green all the way to round 4 and only a local run found
 * it.
 *
 * Same session rule as its user-half twin: `ApprovalsService.approveInTx`
 * matches the live row on `approverUserId` taken from the SESSION, so the
 * caller must already be logged in as the project's SENIOR. 201 is asserted
 * rather than assumed, so a future `@HttpCode(200)` fails loudly.
 */
export async function approveProjectSeniorShareViaAPI(
  page: Page,
  projectId: string,
): Promise<void> {
  const res = await page.request.post(
    `${REAL_API_BASE}/api/projects/${projectId}/senior-share/approve`,
  )
  if (res.status() !== 201) {
    throw new Error(
      `approveProjectSeniorShareViaAPI failed for ${projectId}: HTTP ${res.status()} — ${await res.text()}`,
    )
  }
}

/**
 * Fetch a single transaction by id via GET /api/transactions/:id. Used
 * by helpers that need to read the status mutation after validation/pay.
 */
export async function getTransactionViaAPI(
  page: Page,
  txId: string,
): Promise<{
  id: string
  type: string
  status: string
  amount: string
  payoutRequestId: string | null
}> {
  const res = await page.request.get(`${REAL_API_BASE}/api/transactions/${txId}`)
  if (res.status() !== 200) {
    throw new Error(
      `getTransactionViaAPI failed for ${txId}: HTTP ${res.status()} — ${await res.text()}`,
    )
  }
  return (await res.json()) as Awaited<ReturnType<typeof getTransactionViaAPI>>
}

// ---------------------------------------------------------------------------
// Phase 3 real-API helpers (task-drop-phase3-e2e — AC1)
// ---------------------------------------------------------------------------
//
// Manual payout confirmation flow — ACCOUNTANT/ADMIN selects which admin
// partner actually received the off-platform PAYOUT. Backend (spec §8.4):
//   1) Flips PAYOUT row PENDING_PAYMENT → PAID + records validatedBy/At.
//   2) Inserts a fresh PAYOUT_CONFIRMED row crediting the chosen admin.
//
// Phase 2 auto-50/50 PAYOUT_ADMIN distribution is NOT replaced — the manual
// flow runs in parallel as a safety-net / audit-trail for the actual on-chain
// recipient. These helpers let tests trigger the endpoint without UI clicks
// (for RBAC sweeps and edge-case probes).

/**
 * Confirm a PAYOUT via POST /api/transactions/:id/confirm-payout.
 *
 * Pre-conditions:
 *   - Caller is ADMIN or ACCOUNTANT (anyone else → 403).
 *   - `payoutTxId` references a row with type=PAYOUT, status=PENDING_PAYMENT.
 *   - `recipientAdminId` is an active (non-archived) ADMIN — pass
 *     `MAKSYM_ID` or `KOSTYA_ID` for the seed partners.
 *
 * Returns the parsed `{ payout, confirmed }` body (matches the controller
 * response shape — `confirmed` may be `null` if the post-write lookup races
 * a transaction commit, but the cascade itself is atomic).
 *
 * Throws on any non-2xx response so tests surface backend regressions loudly.
 * Use `confirmPayoutRawViaAPI` below when the spec needs to assert a specific
 * non-2xx status (RBAC 403, validation 400).
 */
export async function confirmPayoutViaAPI(
  page: Page,
  payoutTxId: string,
  recipientAdminId: string,
): Promise<{
  payout: { id: string; status: string; validatedBy: string | null; validatedAt: string | null }
  confirmed: {
    id: string
    type: string
    status: string
    amount: string
    recipientId: string | null
    receiverId: string | null
    projectId: string | null
  } | null
}> {
  // Phase 4 refactor (AC4): confirmPayout now requires a payment method.
  // Tests don't care about the method semantics, so default to CASH which
  // doesn't need a real txHash. RBAC/edge specs override status assertions
  // anyway.
  const res = await page.request.post(
    `${REAL_API_BASE}/api/transactions/${payoutTxId}/confirm-payout`,
    { data: { recipientAdminId, method: 'CASH' } },
  )
  if (res.status() !== 200 && res.status() !== 201) {
    throw new Error(
      `confirmPayoutViaAPI failed for ${payoutTxId}: HTTP ${res.status()} — ${await res.text()}`,
    )
  }
  return (await res.json()) as Awaited<ReturnType<typeof confirmPayoutViaAPI>>
}

/**
 * Raw variant of `confirmPayoutViaAPI` — does NOT throw on non-2xx.
 *
 * Returns the HTTP status + parsed body (best-effort, falls back to text).
 * Used by RBAC + edge-case specs that need to assert "this role gets 403"
 * or "wrong tx type → 400 with backend message".
 */
export async function confirmPayoutRawViaAPI(
  page: Page,
  payoutTxId: string,
  recipientAdminId: string,
): Promise<{ status: number; body: unknown }> {
  // Phase 4 refactor (AC4): same method=CASH default as above so RBAC tests
  // still hit the RBAC branch (which runs before the method check).
  const res = await page.request.post(
    `${REAL_API_BASE}/api/transactions/${payoutTxId}/confirm-payout`,
    { data: { recipientAdminId, method: 'CASH' } },
  )
  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = await res.text()
  }
  return { status: res.status(), body }
}

/**
 * Find PENDING_PAYMENT PAYOUT rows for a given project via
 * GET /api/transactions?projectId=. Returns the filtered array — empty if no
 * payouts are pending (e.g. the cascade hasn't fired yet, or the row was
 * already confirmed).
 *
 * The endpoint returns the full transaction shape; we re-read raw JSON here
 * (instead of casting `listTransactionsByProjectViaAPI`'s narrower type) so
 * the spec assertions get `payoutRequestId` + `currency` directly, which the
 * Phase 3 helpers actually use.
 *
 * Caller must be ADMIN or ACCOUNTANT to see the full unfiltered list. Other
 * roles get a partial slice per RBAC and may miss PAYOUT rows.
 *
 * TRAP (backlog item 139, found while de-flaking the drop specs) — FIXED
 * 2026-08 (backlog item 144, `TransactionsService.createPayoutRequest`,
 * apps/api/src/finance/transactions.service.ts). The placeholder PAYOUT row
 * `createPayoutRequest` inserts (and later flips to PAID in
 * `applyPayoutPaidCascade`) used to be inserted WITHOUT `projectId` — unlike
 * PAYOUT_ADMIN / SENIOR_PENDING_PAYOUT / DROP_PENDING_PAYOUT, which the same
 * cascade DOES stamp (see `bookCompanyObligations` in
 * transactions.service.ts) — so this helper's `?projectId=` filter (same one
 * `listTransactionsByProjectViaAPI` uses) never returned it, at any status,
 * before or after payment. `createPayoutRequest` now stamps `projectId` on
 * that row (the batch's "primary project" — first linked income's project,
 * same convention `applyPayoutPaidCascade` already used), and `confirmPayout`
 * inherits it onto PAYOUT_CONFIRMED via its existing `projectId:
 * payoutTx.projectId` snapshot, so both are found by this filter (and by
 * `listTransactionsByProjectViaAPI`) directly now. `listPayoutRequestTransactionsViaAPI(page,
 * payoutRequestId)` (joins on `payoutRequestId`, not `projectId`) remains a
 * valid alternative when you want a single payout's rows in deterministic
 * order regardless of project — it was never REQUIRED for this, just the
 * only thing that worked before the fix.
 */
export async function findPendingPayoutsForProjectViaAPI(
  page: Page,
  projectId: string,
): Promise<
  Array<{
    id: string
    type: string
    status: string
    amount: string
    currency: string
    senderId: string | null
    receiverId: string | null
    recipientId: string | null
    projectId: string | null
    payoutRequestId: string | null
  }>
> {
  const res = await page.request.get(`${REAL_API_BASE}/api/transactions?projectId=${projectId}`)
  if (res.status() !== 200) {
    throw new Error(
      `findPendingPayoutsForProjectViaAPI failed for ${projectId}: HTTP ${res.status()} — ${await res.text()}`,
    )
  }
  const rows = (await res.json()) as Array<{
    id: string
    type: string
    status: string
    amount: string
    currency: string
    senderId: string | null
    receiverId: string | null
    recipientId: string | null
    projectId: string | null
    payoutRequestId: string | null
  }>
  return rows.filter((t) => t.type === 'PAYOUT' && t.status === 'PENDING_PAYMENT')
}
