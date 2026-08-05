/**
 * Anti-Stale Mutation Tests — cache suite
 *
 * PURPOSE: Prove that UI mutations trigger TanStack Query invalidation → a
 * real network refetch → the UI shows FRESH data without a manual page
 * reload — AND that this refetch is never served from a Service Worker
 * cache (there is nothing under /api/* for the SW to go stale on, see
 * "fix(web): stop routing API requests through the service worker").
 *
 * This is a REGRESSION GUARD, now cutting the other way from before: if
 * someone reintroduces an `/api/*`-matching `runtimeCaching` rule (NetworkFirst,
 * StaleWhileRevalidate, whatever), the "response was never fromServiceWorker"
 * assertion below fails — catching the exact class of bug this PR fixes
 * (SW-mediated caching of financial/PII API responses) before it needs a
 * 16.7s-hang-style live repro to notice again.
 *
 * Scenarios covered:
 *   1. Finance — ADMIN creates EXPENSE via UI dialog →
 *      new row appears in the transactions table without page reload.
 *   2. Projects — ADMIN creates a project via UI dialog →
 *      new project row appears in the projects list without page reload.
 *
 * Requirements (real API stack):
 *   - NestJS API running on :3001 (dev seed applied)
 *   - Vite preview on :3000 (production build with SW enabled)
 *   - The Playwright "cache" project (serviceWorkers: 'allow')
 *
 * Anti-flaky guarantees:
 *   - waitForSWActive before any interaction (SW must be controlling)
 *   - expect.poll / toBeVisible assertions (NEVER waitForTimeout)
 *   - clearSWAndCaches in beforeEach + afterEach (full isolation)
 *   - Cleanup in afterEach deletes test data via direct API call
 *   - Unique sentinel amounts per run (Date.now()) to avoid collisions
 */
import { test, expect } from '@playwright/test'
import {
  clearSWAndCaches,
  navigateWithSWReady,
  loginViaApi,
  SEED_ADMIN_EMAIL,
  REAL_API_BASE,
} from './helpers'

// ─── Constants from seed.ts ──────────────────────────────────────────────────

/** Stable UUID for Oleksiy Kovalenko (SENIOR) — used as seniorId when
 *  creating a test project. Mirrors apps/api/src/database/seed.ts. */
const SEED_SENIOR_ID = 'c1e2f3a4-b5c6-4d7e-8f9a-0b1c2d3e4f55'

// ─── Helper: delete a transaction via real API (cleanup) ─────────────────────

async function deleteTransactionViaApi(
  page: import('@playwright/test').Page,
  txId: string,
): Promise<void> {
  const res = await page.request.delete(`${REAL_API_BASE}/api/transactions/${txId}`)
  // 200 or 404 (already gone) are both acceptable for cleanup.
  if (res.status() !== 200 && res.status() !== 404 && res.status() !== 204) {
    console.warn(`[anti-stale cleanup] DELETE /transactions/${txId} returned HTTP ${res.status()}`)
  }
}

// ─── Helper: delete a project via real API (cleanup) ─────────────────────────

async function deleteProjectViaApi(
  page: import('@playwright/test').Page,
  projectId: string,
): Promise<void> {
  const res = await page.request.delete(`${REAL_API_BASE}/api/projects/${projectId}`)
  if (res.status() !== 200 && res.status() !== 404 && res.status() !== 204) {
    console.warn(`[anti-stale cleanup] DELETE /projects/${projectId} returned HTTP ${res.status()}`)
  }
}

// ─── Suite ───────────────────────────────────────────────────────────────────

test.describe('Anti-stale: UI mutation → fresh data, /api/* never cached by the SW', () => {
  // Serial: tests share mutable cleanup state (createdTransactionId /
  // createdProjectId) and each mutates seeded data, so they must not overlap
  // even if the global config enables fullyParallel.
  test.describe.configure({ mode: 'serial' })

  // Track IDs created during each test for cleanup.
  let createdTransactionId: string | null = null
  let createdProjectId: string | null = null

  test.beforeEach(async ({ page }) => {
    createdTransactionId = null
    createdProjectId = null
    // Full SW + cache isolation: clear registrations and all cache stores.
    await clearSWAndCaches(page)
  })

  test.afterEach(async ({ page }) => {
    // Cleanup created test data so seed stays clean.
    if (createdTransactionId) {
      await deleteTransactionViaApi(page, createdTransactionId)
      createdTransactionId = null
    }
    if (createdProjectId) {
      await deleteProjectViaApi(page, createdProjectId)
      createdProjectId = null
    }
    // Belt-and-suspenders: clear SW + caches after the test too.
    await clearSWAndCaches(page)
  })

  // ── Scenario 1: Finance — EXPENSE mutation shows fresh row ────────────────
  //
  // Flow:
  //   1. Login as ADMIN, navigate to /finance (SW becomes active controller)
  //   2. Wait until real /api/* traffic has happened (GET /transactions)
  //   3. Intercept the POST /transactions network request to capture the created ID
  //   4. Click "Новая транзакция" → fill EXPENSE dialog → submit
  //   5. Assert the new tx row appears in the table WITHOUT any page.reload()
  //   6. Assert NONE of the /api/* responses were served fromServiceWorker
  //      (direct network — nothing to go stale on)
  //
  test('Scenario 1 — Finance: EXPENSE via UI → new row in table without reload (no SW caching)', async ({
    page,
  }) => {
    await loginViaApi(page, SEED_ADMIN_EMAIL)

    // Track every /api/* response for the whole test — used both as the
    // "real traffic happened" precondition and the anti-stale proof below.
    const apiResponses: { url: string; fromSW: boolean }[] = []
    page.on('response', (response) => {
      if (response.url().includes('/api/') && !response.url().includes('/api/auth/logout')) {
        apiResponses.push({ url: response.url(), fromSW: response.fromServiceWorker() })
      }
    })

    // Double-goto: first navigation registers the SW, second fires requests
    // while the SW is already the active controller.
    await navigateWithSWReady(page, '/finance')

    // Precondition: real /api/* traffic happened (GET /transactions etc.).
    await expect
      .poll(() => apiResponses.length > 0, {
        message: 'Expected at least one /api/* response before mutation',
        timeout: 25_000,
        intervals: [500, 1000, 2000],
      })
      .toBeTruthy()

    // Unique sentinel amount — makes the new row identifiable even when many
    // transactions already exist in the seed DB.
    const sentinelAmount = `${7 + (Date.now() % 89)}` // e.g. "42" — always 2 digits, < 100 USDT

    // Capture the POST /transactions response to extract the new ID for cleanup.
    const txResponsePromise = page.waitForResponse(
      (res) =>
        res.url().includes('/api/transactions') &&
        res.request().method() === 'POST' &&
        res.status() === 201,
      { timeout: 15_000 },
    )

    // Open "Новая транзакция" dialog.
    await page.locator('[data-testid="finance-create-transaction-button"]').click()

    // Wait for dialog to appear.
    await expect(page.locator('[data-testid="create-transaction-dialog"]')).toBeVisible()

    // Select EXPENSE type (admin sees: ADMIN_INCOME, EXPENSE, SALARY, ADMIN_TRANSFER).
    await page.locator('[data-testid="create-transaction-type-expense"]').click()

    // Fill amount.
    // AmountCurrencyInput has a text input — find by placeholder or role.
    const amountInput = page
      .locator('[data-testid="create-transaction-dialog"]')
      .locator('input[type="text"], input[inputmode="decimal"], input[placeholder]')
      .first()
    await amountInput.fill(sentinelAmount)

    // Receipt is required ("Чек обязателен: приложите файл или ссылку на
    // blockchain-explorer") — switch the ReceiptInput to link mode and fill
    // a placeholder URL. Not a caching concern, just satisfying form
    // validation so the dialog actually submits.
    await page.locator('[data-testid="receipt-input-mode-url"]').click()
    await page
      .locator('[data-testid="receipt-input-url-field"]')
      .fill('https://etherscan.io/tx/0xtest')

    // Submit.
    await page.locator('[data-testid="create-transaction-submit"]').click()

    // Wait for the POST /transactions to complete and capture the new tx ID.
    const txResponse = await txResponsePromise
    const txBody = await txResponse.json().catch(() => null)
    if (txBody?.id) {
      createdTransactionId = txBody.id as string
    }

    // Dialog should close (mutation success → onClose() called).
    await expect(page.locator('[data-testid="create-transaction-dialog"]')).not.toBeVisible({
      timeout: 10_000,
    })

    // KEY ASSERTION: After mutation, TanStack Query fires invalidateQueries(['transactions'])
    // → a direct network refetch of GET /transactions (no SW cache in the loop)
    // → new row appears in the UI without page.reload().
    //
    // The new row has data-testid="tx-row-{id}". Since we may not always
    // capture the ID (e.g. non-201 response shape), we fall back to checking
    // that a tx-row with [data-tx-type="EXPENSE"] containing the sentinel
    // amount text appears in the table.
    if (createdTransactionId) {
      await expect(page.locator(`[data-testid="tx-row-${createdTransactionId}"]`)).toBeVisible({
        timeout: 15_000,
      })
    } else {
      // Fallback: check that some row with the sentinel amount appeared.
      await expect
        .poll(
          async () => {
            const rows = page.locator('[data-testid^="tx-row-"]')
            const count = await rows.count()
            for (let i = 0; i < count; i++) {
              const text = await rows.nth(i).textContent()
              if (text?.includes(sentinelAmount)) return true
            }
            return false
          },
          {
            message: `Expected a tx row with sentinel amount "${sentinelAmount}" to appear after mutation`,
            timeout: 15_000,
            intervals: [300, 500, 1000],
          },
        )
        .toBeTruthy()
    }

    // ANTI-STALE PROOF: no /api/* response (before OR after the mutation) was
    // ever served fromServiceWorker — every one hit the real network directly.
    // That's why the new row appearing without a manual reload can't be a
    // fluke of stale-cache-happens-to-match: there is no cache in the loop.
    const anyFromSW = apiResponses.some((r) => r.fromSW)
    expect(
      anyFromSW,
      `Expected NO /api/* response to be fromServiceWorker. Got: ${JSON.stringify(apiResponses)}`,
    ).toBe(false)
  })

  // ── Scenario 2: Projects — create project shows fresh row ─────────────────
  //
  // Flow:
  //   1. Login as ADMIN, navigate to /projects (SW active)
  //   2. Wait until real /api/* traffic has happened (GET /projects)
  //   3. Intercept POST /projects to capture new project ID
  //   4. Click "Новый проект" → fill dialog → submit
  //   5. Assert new project row appears WITHOUT page.reload()
  //
  test('Scenario 2 — Projects: create project via UI → new row in list without reload (no SW caching)', async ({
    page,
  }) => {
    await loginViaApi(page, SEED_ADMIN_EMAIL)

    // Track every /api/* response for the whole test.
    const apiResponses: { url: string; fromSW: boolean }[] = []
    page.on('response', (response) => {
      if (response.url().includes('/api/') && !response.url().includes('/api/auth/logout')) {
        apiResponses.push({ url: response.url(), fromSW: response.fromServiceWorker() })
      }
    })

    await navigateWithSWReady(page, '/projects')

    // Precondition: real /api/* traffic happened (GET /projects etc.).
    await expect
      .poll(() => apiResponses.length > 0, {
        message: 'Expected at least one /api/* response before projects mutation',
        timeout: 25_000,
        intervals: [500, 1000, 2000],
      })
      .toBeTruthy()

    // Unique sentinel name — makes the new project identifiable in the list.
    const sentinelSuffix = Date.now().toString().slice(-6)
    const projectName = `AntiStale-${sentinelSuffix}`
    const companyName = `TestCo-${sentinelSuffix}`

    // Click "Новый проект".
    await page.getByRole('button', { name: 'Новый проект' }).click()

    // Wait for the create-project dialog.
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 10_000 })

    // Fill project name — label is a plain text node without a `for` attr,
    // so getByLabel() doesn't resolve it. Locate via the generic wrapper that
    // contains both the label text and the textbox (confirmed from DOM snapshot).
    await dialog
      .locator('div, [class]')
      .filter({ hasText: /^Название проекта/ })
      .getByRole('textbox')
      .fill(projectName)

    await dialog
      .locator('div, [class]')
      .filter({ hasText: /^Компания/ })
      .getByRole('textbox')
      .fill(companyName)

    // Select senior — combobox labelled «Синьор» (confirmed from DOM snapshot).
    await dialog
      .locator('div, [class]')
      .filter({ hasText: /^Синьор/ })
      .getByRole('combobox')
      .selectOption(SEED_SENIOR_ID)

    // Set rate — spinbutton inside the Ставка wrapper.
    await dialog.getByRole('spinbutton').fill('1000')

    // Start capturing POST /projects response RIGHT BEFORE submit, so the
    // 15 s deadline starts from the moment of the network request, not from
    // when the form was being filled.
    const projectResponsePromise = page.waitForResponse(
      (res) =>
        res.url().includes('/api/projects') &&
        res.request().method() === 'POST' &&
        (res.status() === 201 || res.status() === 200),
      { timeout: 15_000 },
    )

    // Submit.
    await page.getByRole('button', { name: 'Создать' }).click()

    // Capture project ID for cleanup.
    try {
      const projectResponse = await projectResponsePromise
      const projectBody = await projectResponse.json().catch(() => null)
      if (projectBody?.id) {
        createdProjectId = projectBody.id as string
      }
    } catch {
      // If capture fails, cleanup will skip — acceptable for smoke.
    }

    // Dialog should close.
    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 10_000 })

    // KEY ASSERTION: new project row appears without page reload.
    // projects list uses data-testid="projects-list" and each row has
    // data-testid="project-card-{id}".
    if (createdProjectId) {
      await expect(page.locator(`[data-testid="project-card-${createdProjectId}"]`)).toBeVisible({
        timeout: 15_000,
      })
    } else {
      // Fallback: project name appears somewhere in the list.
      await expect(
        page.locator('[data-testid="projects-list"]').getByText(projectName),
      ).toBeVisible({ timeout: 15_000 })
    }

    // ANTI-STALE PROOF: no /api/* response was ever served fromServiceWorker.
    const anyFromSW = apiResponses.some((r) => r.fromSW)
    expect(
      anyFromSW,
      `Expected NO /api/* response to be fromServiceWorker. Got: ${JSON.stringify(apiResponses)}`,
    ).toBe(false)
  })

  // ── Scenario 3: fresh-data contrast — real traffic but UI shows data AFTER mutation ─
  //
  // Extra guard: verify that AFTER a UI mutation, the new data IS visible
  // (i.e. the refetch hit the real network, not a stale SW cache — there is
  // no SW cache in the loop at all any more). This is the minimal "stale
  // data NOT shown" assertion.
  //
  // Mechanism: we seed a unique amount, create the EXPENSE via UI, then verify
  // the row appears. If a future regression reintroduced SW caching of
  // /api/*, a stale cached GET /transactions from BEFORE the POST could win
  // the race — the new row would be absent → test fails → regression
  // detected.
  //
  test('Scenario 3 — fresh-data contrast: real /api/* traffic but UI shows data AFTER mutation (no stale)', async ({
    page,
  }) => {
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    // Track every /api/* response for the whole test.
    const apiResponses: { url: string; fromSW: boolean }[] = []
    page.on('response', (response) => {
      if (response.url().includes('/api/') && !response.url().includes('/api/auth/logout')) {
        apiResponses.push({ url: response.url(), fromSW: response.fromServiceWorker() })
      }
    })

    await navigateWithSWReady(page, '/finance')

    // Verify real /api/* traffic happened before the mutation.
    await expect
      .poll(() => apiResponses.length > 0, {
        message: 'Expected at least one /api/* response before mutation',
        timeout: 25_000,
        intervals: [500, 1000, 2000],
      })
      .toBeTruthy()

    // Sentinel amount — uniquely identifies this test's tx.
    const sentinelAmount = `${11 + (Date.now() % 77)}`

    // Capture POST /transactions.
    const txResponsePromise = page.waitForResponse(
      (res) =>
        res.url().includes('/api/transactions') &&
        res.request().method() === 'POST' &&
        res.status() === 201,
      { timeout: 15_000 },
    )

    // Mutate via UI.
    await page.locator('[data-testid="finance-create-transaction-button"]').click()
    await expect(page.locator('[data-testid="create-transaction-dialog"]')).toBeVisible()
    await page.locator('[data-testid="create-transaction-type-expense"]').click()

    const amountInput = page
      .locator('[data-testid="create-transaction-dialog"]')
      .locator('input[type="text"], input[inputmode="decimal"], input[placeholder]')
      .first()
    await amountInput.fill(sentinelAmount)

    // Receipt is required — see the comment on the same two lines in
    // Scenario 1 above.
    await page.locator('[data-testid="receipt-input-mode-url"]').click()
    await page
      .locator('[data-testid="receipt-input-url-field"]')
      .fill('https://etherscan.io/tx/0xtest')

    await page.locator('[data-testid="create-transaction-submit"]').click()

    const txResponse = await txResponsePromise
    const txBody = await txResponse.json().catch(() => null)
    if (txBody?.id) {
      createdTransactionId = txBody.id as string
    }

    // Dialog closes = mutation succeeded.
    await expect(page.locator('[data-testid="create-transaction-dialog"]')).not.toBeVisible({
      timeout: 10_000,
    })

    // THE ANTI-STALE ASSERTION: new row is visible = TanStack Query got FRESH
    // data from a direct network refetch. There is no SW cache in the loop
    // (see fromServiceWorker check below) to serve a stale pre-mutation list.
    if (createdTransactionId) {
      await expect(page.locator(`[data-testid="tx-row-${createdTransactionId}"]`)).toBeVisible({
        timeout: 15_000,
      })
    } else {
      await expect
        .poll(
          async () => {
            const rows = page.locator('[data-testid^="tx-row-"]')
            const count = await rows.count()
            for (let i = 0; i < count; i++) {
              const text = await rows.nth(i).textContent()
              if (text?.includes(sentinelAmount)) return true
            }
            return false
          },
          {
            message: `Expected tx row with sentinel amount "${sentinelAmount}" — refetch must serve fresh data post-invalidation`,
            timeout: 15_000,
            intervals: [300, 500, 1000],
          },
        )
        .toBeTruthy()
    }

    const anyFromSW = apiResponses.some((r) => r.fromSW)
    expect(
      anyFromSW,
      `Expected NO /api/* response to be fromServiceWorker. Got: ${JSON.stringify(apiResponses)}`,
    ).toBe(false)
  })
})
