/**
 * create-wizard.spec.ts — A3-3 E2E happy-path
 *
 * Coverage:
 * - AC1  legalFullName validation on step 1 (JUNIOR without → cannot advance)
 * - AC2  CreateWizardStepper renders all 3 steps
 * - AC3  Step 1 → POST /api/users → advance to step 2 on success
 * - AC4  Step 2 shows ContractEditor (DRAFT contract) → advance to step 3
 * - AC5  Step 3 shows confirm section with Save-draft + Mark-ready buttons
 * - AC6  «Сохранить и отметить готовым» calls POST /users/:id/contract/ready → dialog closes
 * - AC7  «Сохранить как черновик» closes without POST /ready call
 *
 * All tests use Playwright route mocks — no real backend required.
 */

import { test, expect } from '@playwright/test'
import { USERS, mockAuthAs } from '../fixtures'

const API = 'http://localhost:3001/api'
const NEW_USER_ID = 'b0000000-0000-4000-8000-000000000099'

// ─── Contract fixture ─────────────────────────────────────────────────────────

const DRAFT_CONTRACT = {
  id: 'ac000001-0000-4000-8000-000000000001',
  userId: NEW_USER_ID,
  sourceTemplateId: 'ac000001-0000-4000-8000-000000000002',
  bodyMarkdown: '# Contract\n\nDraft body for wizard test.',
  status: 'DRAFT',
  signedContractId: null,
  createdByUserId: USERS.admin.id,
  createdAt: '2026-06-05T00:00:00.000Z',
  updatedAt: '2026-06-05T00:00:00.000Z',
}

// ─── Route helpers ────────────────────────────────────────────────────────────

/** Mount contract sub-routes for a freshly created user (by id). */
async function mockContractRoutes(page: import('@playwright/test').Page) {
  // GET /api/users/:id/contract
  await page.route(new RegExp(`${API}/users/([^/?]+)/contract$`), async (r) => {
    if (r.request().method() === 'GET') {
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(DRAFT_CONTRACT),
      })
    }
    if (r.request().method() === 'PATCH') {
      const body = JSON.parse(r.request().postData() ?? '{}') as { bodyMarkdown?: string }
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...DRAFT_CONTRACT,
          bodyMarkdown: body.bodyMarkdown ?? DRAFT_CONTRACT.bodyMarkdown,
        }),
      })
    }
    return r.fallback()
  })

  // POST /api/users/:id/contract/ready
  await page.route(new RegExp(`${API}/users/([^/?]+)/contract/ready$`), async (r) => {
    if (r.request().method() === 'POST') {
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...DRAFT_CONTRACT, status: 'READY_TO_SIGN' }),
      })
    }
    return r.fallback()
  })

  // PDF endpoint (ContractActionBar may load it)
  await page.route(new RegExp(`${API}/users/([^/?]+)/contract/pdf$`), async (r) => {
    return r.fulfill({
      status: 200,
      contentType: 'application/pdf',
      body: Buffer.from('%PDF-1.4 placeholder'),
    })
  })
}

/** Open the «Новый пользователь» dialog from /crm/users page. */
async function openCreateDialog(page: import('@playwright/test').Page) {
  await page.goto('/crm/users')
  await expect(page.getByTestId('users-list')).toBeVisible()
  await page.getByTestId('users-create-button').click()
  await expect(page.getByTestId('user-dialog')).toBeVisible()
}

/** Fill step-1 form fields for a JUNIOR (default role, BANK_UAH_FOP). */
async function fillStep1(page: import('@playwright/test').Page) {
  await page.getByTestId('user-dialog-email').fill('wizard-junior@example.com')
  await page.getByTestId('user-dialog-name').fill('Wizard Junior')
  await page.getByTestId('user-dialog-legal-full-name').fill('Юніор Тестовий Валентинович')
  await page.getByTestId('user-dialog-bank-recipient').fill('Юніор Тестовий')
  await page.getByTestId('user-dialog-bank-iban').fill('UA213223130000026007233566001')
  await page.getByTestId('user-dialog-bank-rnokpp').fill('1234567890')
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('A3-3: Create-user wizard', () => {
  test.beforeEach(async ({ page }) => {
    await mockAuthAs(page, USERS.admin)
    await mockContractRoutes(page)
  })

  // ── AC2: Stepper renders ──────────────────────────────────────────────────

  test('AC2: stepper shows all 3 step indicators on dialog open', async ({ page }) => {
    await openCreateDialog(page)

    await expect(page.getByTestId('wizard-step-1')).toBeVisible()
    await expect(page.getByTestId('wizard-step-2')).toBeVisible()
    await expect(page.getByTestId('wizard-step-3')).toBeVisible()

    // Step 1 is active at open
    await expect(page.getByTestId('wizard-step-1')).toHaveAttribute('data-state', 'active')
    await expect(page.getByTestId('wizard-step-2')).toHaveAttribute('data-state', 'upcoming')
    await expect(page.getByTestId('wizard-step-3')).toHaveAttribute('data-state', 'upcoming')
  })

  // ── AC1: legalFullName required ───────────────────────────────────────────

  test('AC1: cannot advance from step 1 without legalFullName (toast shown, stays on step 1)', async ({
    page,
  }) => {
    await openCreateDialog(page)

    // Fill everything except legalFullName
    await page.getByTestId('user-dialog-email').fill('nolegal@example.com')
    await page.getByTestId('user-dialog-name').fill('No Legal')
    await page.getByTestId('user-dialog-bank-recipient').fill('No Legal')
    await page.getByTestId('user-dialog-bank-iban').fill('UA213223130000026007233566001')
    await page.getByTestId('user-dialog-bank-rnokpp').fill('1234567890')

    await page.getByTestId('wizard-next-btn').click()

    // Stays on step 1 (wizard-step-1 still active)
    await expect(page.getByTestId('wizard-step-1')).toHaveAttribute('data-state', 'active')
  })

  // ── AC3: Step 1 → step 2 ─────────────────────────────────────────────────

  test('AC3: step 1 «Далее» calls POST /api/users and advances to step 2', async ({ page }) => {
    // Intercept and capture POST /api/users call
    let postUsersCalled = false
    await page.route(new RegExp(`${API}/users(\\?.*)?$`), async (r) => {
      if (r.request().method() === 'POST') {
        postUsersCalled = true
        return r.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ ...USERS.junior, id: NEW_USER_ID }),
        })
      }
      return r.fallback()
    })

    await openCreateDialog(page)
    await fillStep1(page)
    await page.getByTestId('wizard-next-btn').click()

    // Wait for step 2 to become active
    await expect(page.getByTestId('wizard-step-2')).toHaveAttribute('data-state', 'active', {
      timeout: 5000,
    })
    await expect(page.getByTestId('wizard-step-1')).toHaveAttribute('data-state', 'done')

    expect(postUsersCalled).toBe(true)
  })

  // ── AC4: Step 2 ContractEditor ────────────────────────────────────────────

  test('AC4: step 2 shows contract section with editor, «Назад» returns to step 1', async ({
    page,
  }) => {
    await page.route(new RegExp(`${API}/users(\\?.*)?$`), async (r) => {
      if (r.request().method() === 'POST') {
        return r.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ ...USERS.junior, id: NEW_USER_ID }),
        })
      }
      return r.fallback()
    })

    await openCreateDialog(page)
    await fillStep1(page)
    await page.getByTestId('wizard-next-btn').click()

    await expect(page.getByTestId('wizard-step-2')).toHaveAttribute('data-state', 'active', {
      timeout: 5000,
    })

    // Contract step wrapper is visible
    await expect(page.getByTestId('wizard-contract-step')).toBeVisible()

    // «Назад» returns to step 1
    await page.getByTestId('wizard-back-btn').click()
    await expect(page.getByTestId('wizard-step-1')).toHaveAttribute('data-state', 'active', {
      timeout: 3000,
    })
  })

  // ── AC5 + AC6: Step 3 + «Отметить готовым» ────────────────────────────────

  test('AC5+AC6: step 3 shows confirm buttons; «Отметить готовым» calls POST /ready', async ({
    page,
  }) => {
    let readyCalled = false

    await page.route(new RegExp(`${API}/users(\\?.*)?$`), async (r) => {
      if (r.request().method() === 'POST') {
        return r.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ ...USERS.junior, id: NEW_USER_ID }),
        })
      }
      return r.fallback()
    })

    // Override /ready to capture the call
    await page.route(new RegExp(`${API}/users/([^/?]+)/contract/ready$`), async (r) => {
      if (r.request().method() === 'POST') {
        readyCalled = true
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ...DRAFT_CONTRACT, status: 'READY_TO_SIGN' }),
        })
      }
      return r.fallback()
    })

    await openCreateDialog(page)
    await fillStep1(page)
    await page.getByTestId('wizard-next-btn').click()

    await expect(page.getByTestId('wizard-step-2')).toHaveAttribute('data-state', 'active', {
      timeout: 5000,
    })

    // Wait for contract to load — ContractActionBar appears when query resolves (hasContract = true)
    await expect(page.getByTestId('contract-save-btn')).toBeVisible({ timeout: 8000 })

    // Advance to step 3
    await page.getByTestId('wizard-step2-next-btn').click()
    await expect(page.getByTestId('wizard-step-3')).toHaveAttribute('data-state', 'active', {
      timeout: 3000,
    })

    // Step 3 confirm section is visible (AC5)
    await expect(page.getByTestId('wizard-confirm-step')).toBeVisible()
    await expect(page.getByTestId('wizard-save-draft-btn')).toBeVisible()
    await expect(page.getByTestId('wizard-mark-ready-btn')).toBeVisible()

    // «Отметить готовым» enabled (contract exists) and calls POST /ready (AC6)
    const readyBtn = page.getByTestId('wizard-mark-ready-btn')
    await expect(readyBtn).toBeEnabled()
    await readyBtn.click()

    // Dialog closes after success
    await expect(page.getByTestId('user-dialog')).not.toBeVisible({ timeout: 5000 })
    expect(readyCalled).toBe(true)
  })

  // ── AC7: «Сохранить как черновик» ─────────────────────────────────────────

  test('AC7: «Сохранить как черновик» closes dialog without POST /ready', async ({ page }) => {
    let readyCalled = false

    await page.route(new RegExp(`${API}/users(\\?.*)?$`), async (r) => {
      if (r.request().method() === 'POST') {
        return r.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ ...USERS.junior, id: NEW_USER_ID }),
        })
      }
      return r.fallback()
    })

    await page.route(new RegExp(`${API}/users/([^/?]+)/contract/ready$`), async (r) => {
      readyCalled = true
      return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    })

    await openCreateDialog(page)
    await fillStep1(page)
    await page.getByTestId('wizard-next-btn').click()
    await expect(page.getByTestId('wizard-step-2')).toHaveAttribute('data-state', 'active', {
      timeout: 5000,
    })

    // Wait for contract to load before advancing (hasContract set via useEffect)
    await expect(page.getByTestId('contract-save-btn')).toBeVisible({ timeout: 8000 })

    await page.getByTestId('wizard-step2-next-btn').click()
    await expect(page.getByTestId('wizard-step-3')).toHaveAttribute('data-state', 'active', {
      timeout: 3000,
    })

    await page.getByTestId('wizard-save-draft-btn').click()

    // Dialog closes
    await expect(page.getByTestId('user-dialog')).not.toBeVisible({ timeout: 5000 })
    // POST /ready was NOT called
    expect(readyCalled).toBe(false)
  })
})
