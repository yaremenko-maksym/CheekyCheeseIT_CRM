/**
 * job-source-admin-rbac-api.spec.ts — r5 Task 2.5 T9 AC 1 against the RUNNING API.
 *
 * Direct API calls with a real dev-login JWT per seed role, no mocks: both ADMIN job-source
 * endpoints must answer 403 to SENIOR, JUNIOR, HR and ACCOUNTANT. The ADMIN rows are the control
 * (a 403 for everyone would pass the rest). Nothing here writes: every POST names a source that
 * does not exist, so even a broken guard could not reset a real row.
 */

import { randomUUID } from 'node:crypto'
import { test, expect, REAL_API_BASE, SEED_EMAILS, loginViaApi } from './fixtures'

const API = `${REAL_API_BASE}/api/job-sourcing/admin`
const LIST = `${API}/sources/excluded`
const reset = (id: string) => `${API}/sources/${id}/reset-failures`

const NON_ADMIN = [
  ['SENIOR', SEED_EMAILS.seniorA],
  ['JUNIOR', SEED_EMAILS.juniorA],
  ['HR', SEED_EMAILS.hrA],
  ['ACCOUNTANT', SEED_EMAILS.accountant],
] as const

test.describe('T9 admin job-source endpoints — real-backend RBAC', () => {
  for (const [role, email] of NON_ADMIN) {
    test(`${role}: GET excluded and POST reset → 403`, async ({ page }) => {
      await loginViaApi(page, email)
      expect((await page.request.get(LIST)).status()).toBe(403)
      const res = await page.request.post(reset(randomUUID()), { data: { reason: 'e2e' } })
      expect(res.status()).toBe(403)
    })
  }

  test('ADMIN: GET excluded → 200 with items; POST reset of an unknown source → 404', async ({
    page,
  }) => {
    await loginViaApi(page, SEED_EMAILS.admin)
    const list = await page.request.get(LIST)
    expect(list.status()).toBe(200)
    expect(Array.isArray(((await list.json()) as { items: unknown }).items)).toBe(true)
    const res = await page.request.post(reset(randomUUID()), { data: { reason: 'e2e' } })
    expect(res.status()).toBe(404)
  })

  test('ADMIN: a malformed id or a missing reason → 400', async ({ page }) => {
    await loginViaApi(page, SEED_EMAILS.admin)
    expect(
      (await page.request.post(reset('not-a-uuid'), { data: { reason: 'e2e' } })).status(),
    ).toBe(400)
    expect((await page.request.post(reset(randomUUID()), { data: {} })).status()).toBe(400)
  })
})
