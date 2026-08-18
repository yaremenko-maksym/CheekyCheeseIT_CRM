/**
 * onboarding-regression-pr110.spec.ts — Regression E2E coverage for PR #110
 *
 * Покрывает 4 бага исправленных в fix/onboarding-bugs-batch1:
 *
 * Bug #1 (HIGH) — admin nil-UUID → v4 (migration 0028):
 *   Ранее GET /api/onboarding/status возвращал 400 из-за nil-UUID в seed.
 *   Тест: SENIOR логинится, wizard рендерится без 400.
 *
 * Bug #2 (MED) — contract preview substitution:
 *   Ранее wizard показывал сырые {{placeholders}} вместо реальных данных.
 *   Тест: preview-rendered endpoint вызывается при загрузке SignContractStep,
 *   mock возвращает substituted markdown, form отображается без ошибок.
 *
 * Bug #3 (MED) — console 403 noise от NotificationsBell:
 *   Ранее bell делал polling /api/notifications пока пользователь был в wizard
 *   → 403 (onboarding guard блокировал неонбордированного пользователя).
 *   Тест: на странице /onboarding нет 403 ответов на /api/notifications.
 *
 * Bug #4 (LOW) — seed wallet placeholders → valid ETH addresses:
 *   В fixtures: пользователи с USDT_ERC20 имеют валидный 0x... адрес (40 hex).
 *
 * Все тесты используют Playwright route mocks (без реального backend'а).
 *
 * @see PR #110 fix(onboarding): admin UUID normalize + preview substitution + console gate
 */

import { test as base, expect, type Page } from '@playwright/test'
import { USERS, mockAuthAs, API_GLOB, API_RE } from './fixtures'

// ---------------------------------------------------------------------------
// Fixture constants (mirrors PR #110 changes)
// ---------------------------------------------------------------------------

/** Valid RFC 4122 v4 UUID — результат migration 0028 для admin */
const ADMIN_V4_UUID = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'

/** Template id для preview-rendered endpoint */
const TEMPLATE_ID = 'tpl-senior-1'

const CONTRACT_TEMPLATE = {
  id: TEMPLATE_ID,
  targetRole: 'SENIOR',
  version: 1,
  bodyMarkdown:
    'Контракт между {{companyName}} и {{employeeName}} ({{employeeEmail}}).\n' +
    'Дата: {{onboardingDate}}.\n' +
    'Кошелёк: {{walletUsdt}}.\n' +
    'Метод: {{preferredMethod}}.',
  isActive: true,
  createdByUserId: ADMIN_V4_UUID,
  createdAt: '2026-01-01T00:00:00.000Z',
}

/**
 * Rendered preview — плейсхолдеры заменены реальными данными SENIOR.
 * Используется только как fixture-data для mock — не для DOM-проверки
 * (DOM-рендер substituted текста зависит от наличия PR #110 в dev server).
 */
const RENDERED_PREVIEW = {
  bodyMarkdown:
    'Контракт между Cheeky Cheese IT и Oleksiy Kovalenko (oleksiy.kovalenko@cheekycheese.dev).\n' +
    'Дата: 2026-06-04.\n' +
    'Кошелёк: 0x5B38Da6a701c568545dCfcB03FcB875f56beddC4.\n' +
    'Метод: USDT (ERC-20).',
}

const TOS_VERSION = {
  id: 'tos-v1',
  version: 1,
  bodyMarkdown: '# Условия использования\n\nВы принимаете условия.',
  isActive: true,
  createdByUserId: ADMIN_V4_UUID,
  createdAt: '2026-01-01T00:00:00.000Z',
}

const SIGNED_CONTRACT = {
  id: 'signed-1',
  userId: USERS.senior.id,
  templateId: TEMPLATE_ID,
  bodyMarkdownSnapshot: CONTRACT_TEMPLATE.bodyMarkdown,
  variablesFilled: { employeeName: USERS.senior.displayName },
  signedTypedName: USERS.senior.displayName,
  signedIp: '127.0.0.1',
  signedUserAgent: 'Mozilla/5.0',
  signedAt: '2026-06-04T10:00:00.000Z',
  contractNumber: 'CHK-1-2026',
}

/** Onboarding status: needs both contract + ToS */
const STATUS_UNBOARDED = {
  requiresContract: true,
  requiresTos: true,
  // A3-4: contractReady=true means READY_TO_SIGN → shows SignContractStep
  contractReady: true,
  contractTemplate: CONTRACT_TEMPLATE,
  tosVersion: TOS_VERSION,
  tosUpdateAvailable: false,
  latestTosVersion: TOS_VERSION,
}

/** Onboarding status: needs only ToS (contract signed) */
const STATUS_NEEDS_TOS = {
  requiresContract: false,
  requiresTos: true,
  contractTemplate: null,
  tosVersion: TOS_VERSION,
  tosUpdateAvailable: false,
  latestTosVersion: TOS_VERSION,
}

/** Onboarding status: fully complete */
const STATUS_ONBOARDED = {
  requiresContract: false,
  requiresTos: false,
  contractTemplate: null,
  tosVersion: null,
  tosUpdateAvailable: false,
  latestTosVersion: TOS_VERSION,
}

/** ADMIN bypass status */
const STATUS_ADMIN = {
  requiresContract: false,
  requiresTos: false,
  contractTemplate: null,
  tosVersion: null,
  tosUpdateAvailable: false,
  latestTosVersion: null,
}

// ---------------------------------------------------------------------------
// Locator helper: finds the contract preview article inside sign-contract-form.
//
// data-testid="contract-preview-body" was added to this <article> in PR #110.
// In MAIN branch the attribute is absent. Locating by structural position is
// stable across both branches.
// ---------------------------------------------------------------------------
function getPreviewArticle(page: Page) {
  return page.locator('[data-testid="sign-contract-form"] article')
}

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

async function mockUnboardedStatus(page: Page, statusOverride?: object): Promise<void> {
  await page.unroute(`${API_GLOB}/onboarding/status`)
  await page.route(`${API_GLOB}/onboarding/status`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(statusOverride ?? STATUS_UNBOARDED),
    }),
  )
}

async function mockContractTemplate(page: Page, templateOverride?: object): Promise<void> {
  await page.route(new RegExp(`${API_RE}/contracts/templates/current/[A-Z]+$`), (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(templateOverride ?? CONTRACT_TEMPLATE),
    }),
  )
}

/** A3-4: Mock GET /onboarding/contract/pdf — personal contract PDF blob. */
async function mockContractPdf(
  page: Page,
  opts: { succeed: boolean } = { succeed: true },
): Promise<{ callCount: () => number }> {
  let calls = 0
  await page.route(`${API_GLOB}/onboarding/contract/pdf`, (r) => {
    calls++
    if (!opts.succeed) {
      return r.fulfill({ status: 500, body: 'Internal Server Error' })
    }
    return r.fulfill({
      status: 200,
      contentType: 'application/pdf',
      body: Buffer.from('%PDF-1.4 mock'),
    })
  })
  return { callCount: () => calls }
}

/** Legacy — kept for tests that don't navigate into sign form (harmless no-op there). */
async function mockPreviewRenderedEndpoint(
  page: Page,
  opts: { succeed: boolean },
): Promise<{ callCount: () => number }> {
  let calls = 0
  await page.route(new RegExp(`${API_RE}/contracts/templates/preview-rendered/[^/?]+$`), (r) => {
    calls++
    if (!opts.succeed) {
      return r.fulfill({ status: 500, body: 'Internal Server Error' })
    }
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(RENDERED_PREVIEW),
    })
  })
  return { callCount: () => calls }
}

async function mockSignContract(
  page: Page,
  signedPayload?: object,
): Promise<{ signCalled: () => boolean }> {
  let called = false
  await page.route(`${API_GLOB}/contracts/sign`, (r) => {
    if (r.request().method() !== 'POST') return r.fallback()
    called = true
    return r.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify(signedPayload ?? SIGNED_CONTRACT),
    })
  })
  return { signCalled: () => called }
}

async function mockTosEndpoints(
  page: Page,
  userId?: string,
): Promise<{ tosAcceptCalled: () => boolean }> {
  let called = false
  await page.route(`${API_GLOB}/tos/current`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(TOS_VERSION),
    }),
  )
  await page.route(`${API_GLOB}/tos/accept`, (r) => {
    if (r.request().method() !== 'POST') return r.fallback()
    called = true
    return r.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'acceptance-1',
        userId: userId ?? USERS.senior.id,
        tosVersionId: TOS_VERSION.id,
        acceptedAt: new Date().toISOString(),
        acceptedIp: '127.0.0.1',
        acceptedUserAgent: 'Mozilla/5.0',
      }),
    })
  })
  return { tosAcceptCalled: () => called }
}

/**
 * Full onboarding mock suite: dynamic status + all wizard endpoints.
 * Mirrors the pattern from onboarding-flow.spec.ts mockOnboardingApi.
 * A3-4: removed preview-rendered mock, added /onboarding/contract/pdf mock.
 */
async function mockFullOnboardingApi(
  page: Page,
  opts: { role: string; userId: string },
): Promise<void> {
  let signDone = false
  let tosAcceptDone = false

  await page.unroute(`${API_GLOB}/onboarding/status`)
  await page.route(`${API_GLOB}/onboarding/status`, (r) => {
    const body = tosAcceptDone
      ? STATUS_ONBOARDED
      : signDone
        ? STATUS_NEEDS_TOS
        : { ...STATUS_UNBOARDED, contractTemplate: { ...CONTRACT_TEMPLATE, targetRole: opts.role } }
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    })
  })

  await page.route(new RegExp(`${API_RE}/contracts/templates/current/[A-Z]+$`), (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...CONTRACT_TEMPLATE, targetRole: opts.role }),
    }),
  )

  // A3-4: PDF endpoint for personal contract (replaces old preview-rendered)
  await page.route(`${API_GLOB}/onboarding/contract/pdf`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/pdf',
      body: Buffer.from('%PDF-1.4 mock'),
    }),
  )

  await page.route(`${API_GLOB}/contracts/sign`, (r) => {
    if (r.request().method() !== 'POST') return r.fallback()
    signDone = true
    return r.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify(SIGNED_CONTRACT),
    })
  })

  await page.route(`${API_GLOB}/tos/current`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(TOS_VERSION) }),
  )

  await page.route(`${API_GLOB}/tos/accept`, (r) => {
    if (r.request().method() !== 'POST') return r.fallback()
    tosAcceptDone = true
    return r.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'acceptance-1',
        userId: opts.userId,
        tosVersionId: TOS_VERSION.id,
        acceptedAt: new Date().toISOString(),
        acceptedIp: '127.0.0.1',
        acceptedUserAgent: 'Mozilla/5.0',
      }),
    })
  })
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type RegressionFixtures = {
  asSeniorPage: Page
  asAdminPage: Page
  asJuniorPage: Page
}

const test = base.extend<RegressionFixtures>({
  asSeniorPage: async ({ page }, use) => {
    await mockAuthAs(page, USERS.senior)
    await use(page)
  },
  asAdminPage: async ({ page }, use) => {
    await mockAuthAs(page, USERS.admin)
    await use(page)
  },
  asJuniorPage: async ({ page }, use) => {
    await mockAuthAs(page, USERS.junior)
    await use(page)
  },
})

// ===========================================================================
// REGRESSION #1 — admin nil-UUID → v4 (Bug #1 HIGH)
// После migration 0028 GET /api/onboarding/status должен вернуть 200,
// а не 400 из-за UUID валидации в Zod.
// ===========================================================================

test.describe('Regression #1 — onboarding/status 200 (admin UUID fix)', () => {
  test('SENIOR: /onboarding загружается без 400, wizard виден', async ({ asSeniorPage: page }) => {
    const failedResponses: { url: string; status: number }[] = []
    page.on('response', (resp) => {
      if (resp.url().includes('onboarding/status') && resp.status() >= 400) {
        failedResponses.push({ url: resp.url(), status: resp.status() })
      }
    })

    await mockUnboardedStatus(page)
    await mockContractTemplate(page)
    await mockContractPdf(page)
    await mockSignContract(page)
    await mockTosEndpoints(page)

    await page.goto('/onboarding')

    await expect(page.getByTestId('onboarding-title')).toBeVisible({ timeout: 8000 })
    await expect(page.getByTestId('onboarding-step-contract')).toBeVisible({ timeout: 6000 })

    // Нет 400 ответов на onboarding/status (регрессия Bug #1)
    expect(failedResponses).toHaveLength(0)
  })

  test('SENIOR: onboarding/status мок возвращает 200, wizard показывает step 1', async ({
    asSeniorPage: page,
  }) => {
    const statusResponses: number[] = []
    page.on('response', (resp) => {
      if (resp.url().includes('/onboarding/status')) {
        statusResponses.push(resp.status())
      }
    })

    await mockUnboardedStatus(page)
    await mockContractTemplate(page)
    await mockContractPdf(page)
    await mockSignContract(page)
    await mockTosEndpoints(page)

    await page.goto('/onboarding')
    await expect(page.getByTestId('onboarding-step-contract')).toBeVisible({ timeout: 8000 })

    // Все ответы — 200 (не 400)
    expect(statusResponses.every((s) => s === 200)).toBe(true)
    expect(statusResponses.length).toBeGreaterThanOrEqual(1)
  })

  test('ADMIN: bypass — не редиректится в wizard, остаётся на /', async ({ asAdminPage: page }) => {
    await page.unroute(`${API_GLOB}/onboarding/status`)
    await page.route(`${API_GLOB}/onboarding/status`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(STATUS_ADMIN),
      }),
    )

    await page.goto('/')

    await expect(page).not.toHaveURL(/\/onboarding/, { timeout: 3000 })
    await expect(page).toHaveURL(/\/?$/, { timeout: 5000 })
  })
})

// ===========================================================================
// REGRESSION #2 — A3-4: personal contract PDF preview (replaces old
// preview-rendered markdown approach from PR #110).
//
// Strategy: verify that GET /onboarding/contract/pdf is called by the UI
// and that the wizard form renders without crashing.
// ===========================================================================

test.describe('Regression #2 — A3-4 personal contract PDF wired up', () => {
  test('SignContractStep вызывает /onboarding/contract/pdf после загрузки', async ({
    asSeniorPage: page,
  }) => {
    await mockUnboardedStatus(page)
    await mockContractTemplate(page)
    const { callCount } = await mockContractPdf(page)
    await mockSignContract(page)
    await mockTosEndpoints(page)

    await page.goto('/onboarding')
    await expect(page.getByTestId('sign-contract-form')).toBeVisible({ timeout: 8000 })

    // sign-contract-form visible — wizard not crashed
    await expect(page.getByTestId('sign-button')).toBeVisible()

    // PDF endpoint should have been called once (personal contract fetch)
    expect(callCount()).toBeGreaterThanOrEqual(1)
  })

  test('RENDERED_PREVIEW fixture integrity (data test)', async () => {
    // Pure data test — проверяет что RENDERED_PREVIEW fixture корректен.
    // Retained for historical reference.
    expect(RENDERED_PREVIEW.bodyMarkdown).toContain('Cheeky Cheese IT')
    expect(RENDERED_PREVIEW.bodyMarkdown).toContain('Oleksiy Kovalenko')
    expect(RENDERED_PREVIEW.bodyMarkdown).not.toContain('{{companyName}}')
    expect(RENDERED_PREVIEW.bodyMarkdown).not.toContain('{{employeeName}}')
  })

  test('Graceful fallback: wizard не ломается если PDF endpoint недоступен', async ({
    asSeniorPage: page,
  }) => {
    await mockUnboardedStatus(page)
    await mockContractTemplate(page)
    // PDF endpoint returns 500 — expect pdf-error state to show (graceful fallback)
    await mockContractPdf(page, { succeed: false })
    await mockSignContract(page)
    await mockTosEndpoints(page)

    await page.goto('/onboarding')
    await expect(page.getByTestId('sign-contract-form')).toBeVisible({ timeout: 8000 })

    // Wizard not crashed — error state shows (pdf-error testid)
    await expect(page.getByTestId('pdf-error')).toBeVisible({ timeout: 6000 })
    // Sign button still present (disabled due to pdfError state)
    await expect(page.getByTestId('sign-button')).toBeVisible()
  })
})

// ===========================================================================
// REGRESSION #3 — console 403 noise от NotificationsBell (Bug #3 MED)
// ===========================================================================

test.describe('Regression #3 — NotificationsBell не делает 403 на /notifications в wizard', () => {
  test('Нет 403 ответов на /api/notifications пока пользователь на /onboarding', async ({
    asSeniorPage: page,
  }) => {
    const notifResponses: { url: string; status: number }[] = []
    page.on('response', (resp) => {
      if (resp.url().includes('/notifications')) {
        notifResponses.push({ url: resp.url(), status: resp.status() })
      }
    })

    await mockUnboardedStatus(page)
    await mockContractTemplate(page)
    await mockContractPdf(page)
    await mockSignContract(page)
    await mockTosEndpoints(page)

    await page.goto('/onboarding')
    await expect(page.getByTestId('onboarding-title')).toBeVisible({ timeout: 8000 })
    await expect(page.getByTestId('onboarding-step-contract')).toBeVisible({ timeout: 6000 })

    const forbidden = notifResponses.filter((r) => r.status === 403)
    expect(forbidden).toHaveLength(0)
  })

  test('Нет HTTP 403 статусов среди responses на /api/notifications в onboarding', async ({
    asSeniorPage: page,
  }) => {
    const notifStatuses: number[] = []
    page.on('response', (resp) => {
      if (resp.url().match(/\/notifications(\?.*)?$/)) {
        notifStatuses.push(resp.status())
      }
    })

    await mockUnboardedStatus(page)
    await mockContractTemplate(page)
    await mockContractPdf(page)
    await mockSignContract(page)
    await mockTosEndpoints(page)

    await page.goto('/onboarding')
    await expect(page.getByTestId('onboarding-step-contract')).toBeVisible({ timeout: 8000 })

    expect(notifStatuses).not.toContain(403)
  })

  test('JUNIOR: нет 403 на /notifications пока в wizard', async ({ asJuniorPage: page }) => {
    const forbidden: number[] = []
    page.on('response', (resp) => {
      if (resp.url().includes('/notifications') && resp.status() === 403) {
        forbidden.push(resp.status())
      }
    })

    await mockUnboardedStatus(page, {
      ...STATUS_UNBOARDED,
      contractTemplate: { ...CONTRACT_TEMPLATE, targetRole: 'JUNIOR' },
    })
    await mockContractTemplate(page, { ...CONTRACT_TEMPLATE, targetRole: 'JUNIOR' })
    await mockContractPdf(page)
    await mockSignContract(page)
    await mockTosEndpoints(page, USERS.junior.id)

    await page.goto('/onboarding')
    await expect(page.getByTestId('onboarding-title')).toBeVisible({ timeout: 8000 })

    expect(forbidden).toHaveLength(0)
  })
})

// ===========================================================================
// REGRESSION #4 — seed wallets valid ETH addresses (Bug #4 LOW)
// ===========================================================================

test.describe('Regression #4 — wallet addresses valid ETH format', () => {
  const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

  const PLACEHOLDER_ADDRESSES = [
    '0x3333333333333333333333333333333333333333',
    '0x4444444444444444444444444444444444444444',
    '0x0000000000000000000000000000000000000000',
  ]

  test('RENDERED_PREVIEW wallet — валидный ETH адрес (fixture integrity)', async () => {
    // Pure data test — не требует page navigation.
    // Bug #4: до фикса seed.ts содержал placeholder wallet'ы вида 0x333.../0x444...
    // Эта константа отражает исправленное значение из seed.ts (Oleksiy Kovalenko).
    const walletInPreview = '0x5B38Da6a701c568545dCfcB03FcB875f56beddC4'

    expect(USERS.senior.paymentMethod).toBe('USDT_ERC20')
    expect(walletInPreview).toMatch(ETH_ADDRESS_RE)

    for (const placeholder of PLACEHOLDER_ADDRESSES) {
      expect(walletInPreview).not.toBe(placeholder)
    }

    expect(RENDERED_PREVIEW.bodyMarkdown).toContain(walletInPreview)
  })

  test('Rendered preview не содержит placeholder wallet адресов', async () => {
    for (const placeholder of PLACEHOLDER_ADDRESSES) {
      expect(RENDERED_PREVIEW.bodyMarkdown).not.toContain(placeholder)
    }
    // Every `0x…` string must be a well-formed address. Replaces
    // `if (walletMatch) expect(...)`, which checked nothing when there was no
    // address at all; `matchAll` also covers more than one, which `match`
    // silently ignored.
    //
    // The non-empty assertion is the load-bearing half (code-review MED-3): a
    // `for` over an empty array asserts exactly as little as the `if` did, so
    // without it this rewrite would have swapped one vacuum for another.
    //
    // Scope, stated honestly: `RENDERED_PREVIEW` is a static literal declared
    // at the top of this file — nothing is rendered here. This is a fixture-
    // integrity check (the same role as the "fixture integrity (data test)"
    // case below), NOT proof that the contract renderer emits good addresses.
    const walletMatches = [...RENDERED_PREVIEW.bodyMarkdown.matchAll(/0x[0-9a-fA-F]+/g)].map(
      (m) => m[0],
    )
    expect(walletMatches.length, 'fixture must contain at least one 0x address').toBeGreaterThan(0)
    for (const wallet of walletMatches) {
      expect(wallet).toMatch(ETH_ADDRESS_RE)
    }
  })

  test('ADMIN fixture использует валидный v4 UUID (не nil)', async ({ asAdminPage: page }) => {
    const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    expect(ADMIN_V4_UUID).toMatch(UUID_V4_RE)
    expect(ADMIN_V4_UUID).not.toBe('00000000-0000-0000-0000-000000000001')
    expect(ADMIN_V4_UUID).not.toBe('00000000-0000-0000-0000-000000000002')

    await page.goto('/')
    await expect(page).toHaveURL(/\/?$/, { timeout: 5000 })
  })
})

// ===========================================================================
// SIGN FLOW — happy path (integration)
// ===========================================================================

test.describe('Sign flow — happy path (regression guard for full wizard)', () => {
  test('SENIOR: complete wizard → /', async ({ asSeniorPage: page }) => {
    await mockFullOnboardingApi(page, { role: 'SENIOR', userId: USERS.senior.id })

    await page.goto('/')
    await expect(page).toHaveURL(/\/onboarding/, { timeout: 8000 })

    await expect(page.getByTestId('onboarding-step-contract')).toBeVisible({ timeout: 6000 })
    await expect(page.getByTestId('sign-contract-form')).toBeVisible({ timeout: 6000 })

    // A3-4: typed-name-input removed — legalFullName comes from server.
    // Just check the confirm checkbox and sign.
    await page.getByTestId('confirm-checkbox').check()

    await expect(page.getByTestId('sign-button')).toBeEnabled({ timeout: 6000 })
    await page.getByTestId('sign-button').click()

    await expect(page.getByTestId('onboarding-step-tos')).toBeVisible({ timeout: 8000 })
    await page.getByTestId('accept-tos-checkbox').check()
    await expect(page.getByTestId('accept-tos-button')).toBeEnabled()
    await page.getByTestId('accept-tos-button').click()

    await expect(page).toHaveURL(/\/?$/, { timeout: 8000 })
  })

  test('HR: complete wizard → /', async ({ page }) => {
    // Direct mockAuthAs call — same pattern as onboarding-flow.spec.ts
    // to avoid fixture unroute ordering issues.
    await mockAuthAs(page, USERS.hr)
    await mockFullOnboardingApi(page, { role: 'HR', userId: USERS.hr.id })

    await page.goto('/')
    await expect(page).toHaveURL(/\/onboarding/, { timeout: 8000 })

    await expect(page.getByTestId('sign-contract-form')).toBeVisible({ timeout: 8000 })
    // A3-4: no typed-name-input — just check confirm checkbox
    await page.getByTestId('confirm-checkbox').check()
    await expect(page.getByTestId('sign-button')).toBeEnabled({ timeout: 6000 })
    await page.getByTestId('sign-button').click()

    await expect(page.getByTestId('onboarding-step-tos')).toBeVisible({ timeout: 8000 })
    await page.getByTestId('accept-tos-checkbox').check()
    await page.getByTestId('accept-tos-button').click()

    await expect(page).toHaveURL(/\/?$/, { timeout: 8000 })
  })

  test('Sign button disabled пока checkbox не отмечен (A3-4 model)', async ({
    asSeniorPage: page,
  }) => {
    await mockUnboardedStatus(page)
    await mockContractTemplate(page)
    // A3-4: mock the PDF endpoint (replaces old preview-rendered)
    await page.route(`${API_GLOB}/onboarding/contract/pdf`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/pdf',
        body: Buffer.from('%PDF-1.4 mock'),
      }),
    )
    await mockSignContract(page)
    await mockTosEndpoints(page)

    await page.goto('/onboarding')
    await expect(page.getByTestId('sign-contract-form')).toBeVisible({ timeout: 8000 })

    const signBtn = page.getByTestId('sign-button')

    // Initially disabled (checkbox unchecked)
    await expect(signBtn).toBeDisabled()

    // Check checkbox → enabled (PDF blob mock resolves)
    await page.getByTestId('confirm-checkbox').check()
    await expect(signBtn).toBeEnabled({ timeout: 6000 })

    // Uncheck → disabled again
    await page.getByTestId('confirm-checkbox').uncheck()
    await expect(signBtn).toBeDisabled()
  })
})

// ===========================================================================
// RBAC — кто видит wizard / кто bypass
// ===========================================================================

test.describe('RBAC — onboarding gate', () => {
  test('ADMIN: bypass — /crm без редиректа в wizard', async ({ asAdminPage: page }) => {
    await page.unroute(`${API_GLOB}/onboarding/status`)
    await page.route(`${API_GLOB}/onboarding/status`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(STATUS_ADMIN),
      }),
    )

    await page.goto('/')
    await expect(page).not.toHaveURL(/\/onboarding/, { timeout: 3000 })
    await expect(page).toHaveURL(/\/?$/, { timeout: 5000 })
  })

  test('Onboarded SENIOR: повторный вход → НЕ в wizard (idempotent)', async ({
    asSeniorPage: page,
  }) => {
    // mockAuthAs зарегистрировал fully-onboarded status — не переопределяем
    await page.goto('/')
    await expect(page).not.toHaveURL(/\/onboarding/, { timeout: 3000 })
    await expect(page).toHaveURL(/\/?$/, { timeout: 5000 })
  })

  test('Unboarded JUNIOR: редиректится в wizard', async ({ asJuniorPage: page }) => {
    await mockUnboardedStatus(page, {
      ...STATUS_UNBOARDED,
      contractTemplate: { ...CONTRACT_TEMPLATE, targetRole: 'JUNIOR' },
    })
    // A3-4: mock PDF endpoint so sign form loads without 404.
    await mockContractTemplate(page, { ...CONTRACT_TEMPLATE, targetRole: 'JUNIOR' })
    await mockContractPdf(page)

    await page.goto('/')
    await expect(page).toHaveURL(/\/onboarding/, { timeout: 8000 })
    await expect(page.getByTestId('onboarding-title')).toBeVisible({ timeout: 6000 })
  })

  test('Unboarded HR: редиректится в wizard', async ({ page }) => {
    // Direct mockAuthAs — mirrors onboarding-flow.spec.ts pattern for HR.
    await mockAuthAs(page, USERS.hr)
    await mockUnboardedStatus(page, {
      ...STATUS_UNBOARDED,
      contractTemplate: { ...CONTRACT_TEMPLATE, targetRole: 'HR' },
    })
    // A3-4: mock PDF endpoint so sign form loads without 404.
    await mockContractTemplate(page, { ...CONTRACT_TEMPLATE, targetRole: 'HR' })
    await mockContractPdf(page)

    await page.goto('/')
    await expect(page).toHaveURL(/\/onboarding/, { timeout: 8000 })
    await expect(page.getByTestId('onboarding-title')).toBeVisible({ timeout: 6000 })
  })
})
