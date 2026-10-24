/**
 * invoice-public-verify.spec.ts — task-autotest-business-logic-coverage (J).
 *
 * Public verify endpoint — real-API coverage. The existing UI-level mock
 * spec (`invoices-signing-flow.spec.ts` C7-C9) verifies the rendered page
 * states; here we hit the backend directly so the JSON contract is locked
 * in at the wire level.
 *
 *   GET /api/invoices/verify/:transactionId  (public — no auth, no cookies)
 *
 * Asserts:
 *   1. Endpoint resolves without auth credentials (separate request context
 *      with NO `dev-login` planted).
 *   2. Response shape carries transactionId, type, status, amount, currency,
 *      signatures[].
 *   3. Private fields are stripped: ip, userAgent, full pdfHash (only the
 *      short prefix is exposed).
 *   4. 404 for non-existent transaction ID.
 *   5. 400 for malformed UUID (ParseUUIDPipe).
 *
 * Sample data: instead of provisioning a fresh signed invoice (heavy — PDF
 * gen path), we resolve a seeded transaction id by listing /api/transactions
 * as ADMIN, picking one that has an invoice if any, and verifying its public
 * shape. The 404 / 400 negative cases need no seeded data.
 */

import { test, expect, REAL_API_BASE } from './fixtures'
import {
  loginViaApi,
  SEED_ADMIN_EMAIL,
  SEED_EMAILS,
  createSeniorProjectViaAPI,
  createSeniorIncomeViaAPI,
  validateTransactionViaAPI,
  createPayoutRequestViaAPI,
  payPayoutRequestViaAPI,
  listTransactionsByProjectViaAPI,
  ensureCompanyWalletViaAPI,
} from './fixtures'

const REAL_API = `${REAL_API_BASE}/api`

test.describe('Invoice public verify endpoint — real API', () => {
  test('GET /api/invoices/verify/:id with a syntactically valid but unknown UUID → 404', async ({
    browser,
  }) => {
    // Fresh, *unauthenticated* request context — no cookies, no dev-login.
    const ctx = await browser.newContext()
    try {
      const ghostId = '99999999-9999-4999-8999-999999999999'
      const res = await ctx.request.get(`${REAL_API}/invoices/verify/${ghostId}`)
      expect(res.status()).toBe(404)
      // Body shape is the standard NestJS HttpException — we don't strictly
      // need to assert beyond status, but `message` is a useful sanity check.
      const body = await res.json().catch(() => null)
      expect(body).not.toBeNull()
    } finally {
      await ctx.close()
    }
  })

  test('GET /api/invoices/verify/:id with malformed UUID → 400 (ParseUUIDPipe)', async ({
    browser,
  }) => {
    const ctx = await browser.newContext()
    try {
      const res = await ctx.request.get(`${REAL_API}/invoices/verify/not-a-uuid`)
      // NestJS ParseUUIDPipe returns 400 — regression catcher for someone
      // accidentally swapping the pipe to a bare string param.
      expect(res.status()).toBe(400)
    } finally {
      await ctx.close()
    }
  })

  test('GET /api/invoices/verify/:id resolves without any auth cookies', async ({
    page,
    browser,
  }) => {
    // Plant cookies on `page` (admin) so a regression that *accidentally*
    // depended on cookies wouldn't fool the assertion. The verify probe runs
    // on a brand-new context that has no shared state with `page`.
    await loginViaApi(page, SEED_ADMIN_EMAIL)

    // Pick any transaction we can reach as ADMIN. If the seed DB is empty
    // (fresh CI) the verify endpoint still answers 404 — that's covered by
    // the previous test. Here we ensure the no-auth path doesn't 401 by
    // probing an arbitrary UUID with a fresh, anonymous context.
    const ctx = await browser.newContext()
    try {
      const someId = '12345678-1234-4234-8234-123456789012'
      const res = await ctx.request.get(`${REAL_API}/invoices/verify/${someId}`)
      // Either 200 (random hit, extremely unlikely) or 404 (expected) —
      // anything in [401, 403] would mean the public-route gate broke.
      expect([200, 404]).toContain(res.status())
    } finally {
      await ctx.close()
    }
  })

  test('GET /api/invoices/verify on a SIGNED invoice exposes safe fields only', async ({
    page,
    browser,
  }) => {
    // The seed has NO SIGNED invoice, so this test used to skip itself on every run (a gated
    // spec that always skips is a check that does not exist). Plant one: SENIOR_INCOME →
    // validated → payout requested + paid (the PAYOUT row is the invoice's transaction) →
    // the counterparty SENIOR signs it.
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    await ensureCompanyWalletViaAPI(page)
    const { projectId } = await createSeniorProjectViaAPI(page, {
      seniorEmail: SEED_EMAILS.seniorA,
      name: `Verify Signed ${suffix}`,
    })
    let txId = ''
    try {
      await loginViaApi(page, SEED_EMAILS.seniorA)
      const income = await createSeniorIncomeViaAPI(page, { projectId, amount: 1000 })
      await loginViaApi(page, SEED_EMAILS.accountant)
      await validateTransactionViaAPI(page, income.txId)
      await loginViaApi(page, SEED_EMAILS.seniorA)
      const { payoutRequestId } = await createPayoutRequestViaAPI(page, [income.txId])
      await payPayoutRequestViaAPI(page, payoutRequestId)
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      const payout = (await listTransactionsByProjectViaAPI(page, projectId)).find(
        (t) => t.type === 'PAYOUT',
      )
      expect(payout, 'cascade must produce the PAYOUT row').toBeTruthy()
      txId = payout!.id
      await loginViaApi(page, SEED_EMAILS.seniorA)
      const signRes = await page.request.post(`${REAL_API}/invoices/${txId}/sign`, { data: {} })
      expect(signRes.status(), 'counterparty sign must succeed').toBeLessThan(400)
    } catch (e) {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await page.request.delete(`${REAL_API}/projects/${projectId}`).catch(() => undefined)
      throw e
    }

    const ctx = await browser.newContext()
    try {
      const res = await ctx.request.get(`${REAL_API}/invoices/verify/${txId}`)
      expect(res.status()).toBe(200)
      const body = (await res.json()) as Record<string, unknown>

      // Required public shape per InvoicesService.verifyInvoice.
      expect(body['transactionId']).toBeTruthy()
      expect(body['type']).toBeTruthy()
      expect(body['status']).toBeTruthy()
      expect(body['amount']).toBeTruthy()
      expect(body['currency']).toBeTruthy()
      expect(Array.isArray(body['signatures'])).toBe(true)

      // Private fields MUST NOT leak. The verify projection strips full
      // hash + ip + user-agent — regression catcher for anyone widening the
      // DTO without thinking about the public exposure.
      const sigs = body['signatures'] as Array<Record<string, unknown>>
      // A signed invoice carries signatures. Without this, an empty array would make every
      // leak check in the loop below pass vacuously.
      expect(sigs.length, 'a SIGNED invoice must expose its signatures').toBeGreaterThan(0)
      for (const sig of sigs) {
        expect('ip' in sig, 'verify response must not expose signer IP').toBe(false)
        expect('userAgent' in sig, 'verify response must not expose signer user-agent').toBe(false)
        // pdfHash (full) — only the short prefix should be exposed.
        // Short prefix is ≤ 16 chars (current PDF hash truncate). Length of an
        // absent field normalises to 0, which trivially satisfies the bound —
        // so this states "if present, it is short" without hiding the check
        // behind an `if` that a leak of the full hash could slip past.
        // (task-lint-teeth)
        const short = sig['pdfHashShort'] as string | undefined
        expect(short?.length ?? 0).toBeLessThanOrEqual(16)
        expect('pdfHash' in sig, 'verify response must not expose full PDF hash').toBe(false)
      }
    } finally {
      await ctx.close()
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await page.request.delete(`${REAL_API}/projects/${projectId}`).catch(() => undefined)
    }
  })
})
