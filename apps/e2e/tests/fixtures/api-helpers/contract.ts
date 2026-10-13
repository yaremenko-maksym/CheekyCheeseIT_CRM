import type { Page } from '@playwright/test'
import { REAL_API_BASE, SEED_ADMIN_EMAIL, withThrottleRetry } from './common'
import { loginViaApi } from './auth'

// ---------------------------------------------------------------------------
// onboardDropViaAPI
// ---------------------------------------------------------------------------

/**
 * Onboard a DROP user via HTTP so they can call income endpoints.
 *
 * Steps:
 *   1. ADMIN PATCH /api/users/:id {legalFullName} — required for contract signature
 *   2. ADMIN POST /api/users/:id/contract/ready — WITHOUT Content-Type:json (Fastify quirk)
 *   3. DROP POST /api/contracts/sign {typedName} — bypass-listed in OnboardingGuard
 *   4. DROP POST /api/tos/accept — bypass-listed in OnboardingGuard
 *
 * Restores ADMIN session on exit.
 * Safe to call multiple times — onboarding endpoints are idempotent on an
 * already-onboarded user (they return 200/201 regardless).
 */
export async function onboardDropViaAPI(
  page: Page,
  opts: { dropId: string; dropEmail: string },
): Promise<void> {
  // Step 1: ADMIN sets legalFullName (required for contract PDF generation)
  const patchRes = await withThrottleRetry(
    () =>
      page.request.patch(`${REAL_API_BASE}/api/users/${opts.dropId}`, {
        data: { legalFullName: 'Test Drop Onboarded Testovych' },
      }),
    'PATCH legalFullName',
  )
  if (patchRes.status() !== 200) {
    throw new Error(
      `onboardDropViaAPI: PATCH legalFullName failed: HTTP ${patchRes.status()} — ${await patchRes.text()}`,
    )
  }

  // Step 1b: ADMIN GET /api/users/:id/contract — lazy-creates the DRAFT contract row.
  // markReady (step 2) requires a non-CANCELLED contract row to already exist.
  const draftRes = await withThrottleRetry(
    () => page.request.get(`${REAL_API_BASE}/api/users/${opts.dropId}/contract`),
    'GET /contract draft',
  )
  if (draftRes.status() !== 200 && draftRes.status() !== 201) {
    throw new Error(
      `onboardDropViaAPI: GET /contract (draft create) failed: HTTP ${draftRes.status()} — ${await draftRes.text()}`,
    )
  }

  // Step 2: ADMIN marks user's contract as ready
  // IMPORTANT: must NOT send Content-Type: application/json with empty body —
  // Fastify returns 400 "Body cannot be empty when content-type is set to 'application/json'"
  const readyRes = await withThrottleRetry(
    () => page.request.post(`${REAL_API_BASE}/api/users/${opts.dropId}/contract/ready`),
    'POST /contract/ready',
  )
  if (readyRes.status() !== 200 && readyRes.status() !== 201) {
    throw new Error(
      `onboardDropViaAPI: POST /contract/ready failed: HTTP ${readyRes.status()} — ${await readyRes.text()}`,
    )
  }

  // Step 3 & 4: Switch to DROP session, sign contract and accept ToS
  await loginViaApi(page, opts.dropEmail)

  const signRes = await withThrottleRetry(
    () =>
      page.request.post(`${REAL_API_BASE}/api/contracts/sign`, {
        data: { typedName: 'Test Drop Onboarded Testovych' },
      }),
    'POST /contracts/sign',
  )
  if (signRes.status() !== 200 && signRes.status() !== 201) {
    throw new Error(
      `onboardDropViaAPI: POST /contracts/sign failed: HTTP ${signRes.status()} — ${await signRes.text()}`,
    )
  }

  const tosRes = await withThrottleRetry(
    () => page.request.post(`${REAL_API_BASE}/api/tos/accept`),
    'POST /tos/accept',
  )
  if (tosRes.status() !== 200 && tosRes.status() !== 201) {
    throw new Error(
      `onboardDropViaAPI: POST /tos/accept failed: HTTP ${tosRes.status()} — ${await tosRes.text()}`,
    )
  }

  // Restore ADMIN session so subsequent calls use ADMIN credentials
  await loginViaApi(page, SEED_ADMIN_EMAIL)
}

/**
 * Sign an ALREADY-READY-TO-SIGN contract for `email` + accept the current
 * ToS — the tail half of `onboardDropViaAPI` (its steps 3-4), for a user
 * whose contract is already `READY_TO_SIGN` and must NOT receive the
 * PATCH-legalFullName / mark-ready steps first.
 *
 * Needed for seed users deliberately left at `READY_TO_SIGN` for the
 * onboarding-wizard specs (`dmytro.marchenko` / `SEED_EMAILS.seniorB` —
 * apps/api/src/database/seed.ts: "dmytro.marchenko — READY_TO_SIGN (wizard
 * test)"). `onboardDropViaAPI` cannot be reused on them as-is: its
 * `POST /contract/ready` step 409s (`Cannot mark ready: contract is
 * READY_TO_SIGN, expected DRAFT`) because that transition is DRAFT-only —
 * seniorB is deliberately parked one step past it, forever, for that other
 * spec's own purposes.
 *
 * task-project-draft-status: `POST /api/projects/:id/approve` requires the
 * caller to have completed onboarding (OnboardingGuard) — so a test that
 * uses seniorB as an approving senior (e.g. to exercise a specific
 * `seniorSharePercent` override) needs this BEFORE `createDropProjectViaAPI`
 * / `createSeniorProjectViaAPI` auto-approves for them.
 *
 * `typedName` is ignored server-side (resolved from the user's
 * `legalFullName` — see `SignedContractsService.sign`'s own `@deprecated`
 * note), so any non-empty value is fine here.
 *
 * Restores ADMIN session on exit, same contract as `onboardDropViaAPI`.
 */
export async function signContractAndAcceptTosViaAPI(page: Page, email: string): Promise<void> {
  await loginViaApi(page, email)

  const signRes = await withThrottleRetry(
    () =>
      page.request.post(`${REAL_API_BASE}/api/contracts/sign`, {
        data: { typedName: 'E2E Contract Sign' },
      }),
    `signContractAndAcceptTosViaAPI(${email}): sign`,
  )
  if (signRes.status() !== 200 && signRes.status() !== 201) {
    throw new Error(
      `signContractAndAcceptTosViaAPI: POST /contracts/sign failed for ${email}: HTTP ${signRes.status()} — ${await signRes.text()}`,
    )
  }

  const tosRes = await withThrottleRetry(
    () => page.request.post(`${REAL_API_BASE}/api/tos/accept`),
    `signContractAndAcceptTosViaAPI(${email}): tos`,
  )
  if (tosRes.status() !== 200 && tosRes.status() !== 201) {
    throw new Error(
      `signContractAndAcceptTosViaAPI: POST /tos/accept failed for ${email}: HTTP ${tosRes.status()} — ${await tosRes.text()}`,
    )
  }

  await loginViaApi(page, SEED_ADMIN_EMAIL)
}

// ---------------------------------------------------------------------------
// task-drop-share-e2e — admin-USDT income declaration + obligation settle
// ---------------------------------------------------------------------------
//
// ADR docs/architecture/2026-07-13-payment-type-income-routing.md (D3/D4/D5).
// `declareUsdtIncomeViaAPI` hits the NEW ADMIN-only endpoint directly (used by
// gate/regression specs that don't need the full dialog UI). The happy-path
// spec drives the dialog through the UI instead (purpose statement: E2E
// proves the user path, not just the endpoint contract already covered by
// backend integration tests AC9-AC16).

/**
 * Declare USDT project income via POST /api/finance/usdt-income.
 * Caller must be ADMIN-authenticated (`loginViaApi(page, SEED_ADMIN_EMAIL)` or
 * another seed ADMIN). `receiverId` is either an ADMIN uuid (personal credit)
 * or the `'COMPANY_ACCOUNT'` sentinel (shared pool credit).
 *
 * task-receipts-e2e: `createUsdtIncomeSchema` now requires a mandatory,
 * explorer-only receipt (currency is always the `'USDT'` literal for this
 * flow) — defaults to a valid etherscan.io link so existing/future callers
 * that don't care about the receipt don't need to know about this invariant.
 */
export async function declareUsdtIncomeViaAPI(
  page: Page,
  opts: {
    projectId: string
    amount: number
    receiverId: string
    idempotencyKey?: string
    notes?: string | null
    txDate?: string | null
    receiptExternalUrl?: string
  },
): Promise<{ id: string; status: string; amount: string; receiverId: string | null }> {
  const payload = {
    projectId: opts.projectId,
    amount: opts.amount,
    currency: 'USDT' as const,
    receiverId: opts.receiverId,
    idempotencyKey: opts.idempotencyKey ?? crypto.randomUUID(),
    receiptExternalUrl: opts.receiptExternalUrl ?? 'https://etherscan.io/tx/0xusdtincome0000001',
    ...(opts.notes !== undefined && { notes: opts.notes }),
    ...(opts.txDate !== undefined && { txDate: opts.txDate }),
  }
  const res = await page.request.post(`${REAL_API_BASE}/api/finance/usdt-income`, {
    data: payload,
  })
  if (res.status() !== 201 && res.status() !== 200) {
    throw new Error(`declareUsdtIncomeViaAPI failed: HTTP ${res.status()} — ${await res.text()}`)
  }
  return (await res.json()) as Awaited<ReturnType<typeof declareUsdtIncomeViaAPI>>
}
