/**
 * junior-hub.spec.ts — PR #184 (junior UT round 2): bento hub, route guards,
 * credentials visibility. Updated from PR #177 state.
 *
 * Covers:
 *   AC1 — ContractStatusCard uses /contracts/me/status; SIGNED→«Подписан»;
 *          READY_TO_SIGN→badge + CTA; 404→«Контракт не оформлен»;
 *          500 error ≠ «Контракт не оформлен».
 *   AC2 (bento hub) — hub renders bento grid (junior-hub-bento testid);
 *          QuickLinksBar removed from DOM; HR+credentials bottom row present.
 *   AC3 — SalarySnapshotCard: rate+currency from salary-meta, changedAt line,
 *          last-3 txs from /transactions?type=SALARY; PAID+VALIDATED→«Выплачено».
 *   AC4 (route guards) — JUNIOR по прямому URL на запрещённые роуты редиректит
 *          на /crm/project; разрешённые открываются.
 *   AC6 — Legend persona edit: icon-only X cancel in header (testid persona-edit-cancel-icon),
 *          text «Отмена» ONLY in footer.
 *   AC6 (credentials) — hub shows add-credential button (canAdd); ProfileCredentialsSection
 *          visible to ADMIN/HR in junior profile, hidden for junior self-view.
 *   AC7 — DatePickerField for dateOfBirth (persona form) and eventDate (journal form);
 *          journal entries display eventDate when present.
 *   AC8 — JUNIOR defaults=null → form has no prefill; ADMIN/HR get defaults.
 *   Hub/nav/persona: regression coverage (unchanged).
 *
 * All tests are mock-based. Pattern: role-fixtures + per-test route.fulfill() overrides.
 * Fixtures must satisfy Zod schemas exactly (z.string().uuid() etc.).
 */

import { test, expect, USERS, PROJECTS } from './fixtures'

const API = 'http://localhost:3001/api'

// ---------------------------------------------------------------------------
// Shared junior-facing fixtures
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
const P0 = PROJECTS[0]!
const JUNIOR_PROJECT_ID = 'a0000000-0000-4000-8000-000000000099'
const LEGEND_ID = 'b0000000-0000-4000-8000-000000000001'
const LEGEND_ENTRY_ID = 'b0000000-0000-4000-8000-000000000002'

const JUNIOR_PROJECT = {
  ...P0,
  id: JUNIOR_PROJECT_ID,
  companyName: P0.companyName,
  domain: P0.domain,
  seniorId: null as string | null,
  seniorName: 'Олександр П.',
  seniorPresentedRole: 'Lead Developer',
  rate: null as number | null,
  currency: null as string | null,
}

const LEGEND_FIXTURE = {
  id: LEGEND_ID,
  projectId: JUNIOR_PROJECT_ID,
  fullName: 'Олександр Петренко',
  dateOfBirth: '1990-05-15',
  address: 'Київ, вул. Хрещатик 1',
  presentedRole: 'Lead Developer',
  presentedStack: 'TypeScript, React, NestJS',
  backstory: 'Досвідчений розробник з 10 роками досвіду в фінтеху.',
  hobbies: 'Гірський туризм, фотографія',
  notes: null,
  entries: [
    {
      id: LEGEND_ENTRY_ID,
      legendId: LEGEND_ID,
      authorId: USERS.junior.id,
      authorName: USERS.junior.displayName,
      text: 'Перший запис журналу',
      eventDate: null,
      createdAt: '2024-01-15T10:00:00.000Z',
    },
  ],
  defaults: null, // JUNIOR viewer — no real identity leak
  createdAt: '2024-01-15T00:00:00.000Z',
  updatedAt: '2024-01-20T00:00:00.000Z',
}

const HR_CONTACT_FIXTURE = {
  displayName: USERS.hr.displayName,
  telegram: '@hrmanager',
  phone: '+380671234567',
}

// ---------------------------------------------------------------------------
// Salary fixtures
// ---------------------------------------------------------------------------

const SALARY_META_FIXTURE = {
  monthlySalary: '800',
  salaryCurrency: 'USD',
  changedAt: '2026-03-01T00:00:00.000Z',
}

// Base transaction object satisfying transactionSchema (all nullable fields explicit)
const TX_BASE = {
  type: 'SALARY',
  amount: '800',
  currency: 'USD',
  senderId: null,
  senderLabel: null,
  senderName: null,
  receiverLabel: null,
  receiverName: null,
  projectId: null,
  projectName: null,
  payoutRequestId: null,
  payoutRequest: null,
  seniorSharePercent: null,
  seniorSharePercentSource: null,
  receiptDocumentId: null,
  receiptExternalUrl: null,
  txHash: null,
  validatedBy: null,
  validatedAt: null,
  rejectionReason: null,
  notes: null,
  txDate: null,
  recipientId: null,
  createdBy: 'a0000000-0000-4000-8000-000000000001', // admin uuid
}

const SALARY_TX_PAID = {
  ...TX_BASE,
  id: 'c0000000-0000-4000-8000-000000000011',
  status: 'PAID',
  receiverId: USERS.junior.id,
  salaryMonth: '2026-05',
  createdAt: '2026-05-31T00:00:00.000Z',
  updatedAt: '2026-05-31T00:00:00.000Z',
}

const SALARY_TX_VALIDATED = {
  ...TX_BASE,
  id: 'c0000000-0000-4000-8000-000000000012',
  status: 'VALIDATED',
  receiverId: USERS.junior.id,
  salaryMonth: '2026-04',
  createdAt: '2026-04-30T00:00:00.000Z',
  updatedAt: '2026-04-30T00:00:00.000Z',
}

const SALARY_TX_PENDING = {
  ...TX_BASE,
  id: 'c0000000-0000-4000-8000-000000000013',
  status: 'PENDING',
  receiverId: USERS.junior.id,
  salaryMonth: '2026-03',
  createdAt: '2026-03-31T00:00:00.000Z',
  updatedAt: '2026-03-31T00:00:00.000Z',
}

// ---------------------------------------------------------------------------
// Helper: mount junior-specific mocks
//
// contractStatus — override response for /contracts/me/status.
//   null (default) → 404 "no contract" state.
//   Pass an object to simulate SIGNED/READY_TO_SIGN/error.
//
// salaryMeta — override response for /users/me/salary-meta.
//   null (default) → SALARY_META_FIXTURE.
//   Pass a custom object to simulate other states.
//
// NOTE: Playwright uses LIFO route handler order — handlers registered
// LAST take precedence. Register per-test overrides BEFORE calling this
// helper, or use the contractStatus/salaryMeta parameters instead.
// ---------------------------------------------------------------------------

interface MockOptions {
  contractStatus?: { status: number; body: object } | null
  salaryMeta?: { status: number; body: object } | null
  legend?: object | null
}

async function mockJuniorProjectsAndLegend(
  page: import('@playwright/test').Page,
  opts: MockOptions = {},
) {
  // Projects list — masked project
  await page.route(new RegExp(`${API}/projects(\\?.*)?$`), (r) => {
    if (r.request().method() !== 'GET') return r.fallback()
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([JUNIOR_PROJECT]),
    })
  })

  // Legend GET + PUT
  const legendBody = opts.legend ?? LEGEND_FIXTURE
  await page.route(new RegExp(`${API}/projects/${JUNIOR_PROJECT.id}/legend$`), (r) => {
    if (r.request().method() === 'GET') {
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(legendBody),
      })
    }
    if (r.request().method() === 'PUT') {
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(legendBody),
      })
    }
    return r.fallback()
  })

  // Legend entries POST
  await page.route(new RegExp(`${API}/projects/${JUNIOR_PROJECT.id}/legend/entries$`), (r) => {
    if (r.request().method() !== 'POST') return r.fallback()
    const newEntry = {
      id: 'b0000000-0000-4000-8000-000000000003',
      legendId: LEGEND_ID,
      authorId: USERS.junior.id,
      authorName: USERS.junior.displayName,
      text: 'Новий запис',
      eventDate: null,
      createdAt: new Date().toISOString(),
    }
    const base = (opts.legend ?? LEGEND_FIXTURE) as typeof LEGEND_FIXTURE
    return r.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ ...base, entries: [...base.entries, newEntry] }),
    })
  })

  // HR contact
  await page.route(new RegExp(`${API}/projects/${JUNIOR_PROJECT.id}/hr-contact$`), (r) => {
    if (r.request().method() !== 'GET') return r.fallback()
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(HR_CONTACT_FIXTURE),
    })
  })

  // Contract status — AC1 fix: uses /contracts/me/status, NOT /contracts/me
  const contractOpts = opts.contractStatus ?? { status: 404, body: { message: 'Not found' } }
  await page.route(new RegExp(`${API}/contracts/me/status$`), (r) => {
    if (r.request().method() !== 'GET') return r.fallback()
    return r.fulfill({
      status: contractOpts.status,
      contentType: 'application/json',
      body: JSON.stringify(contractOpts.body),
    })
  })

  // Salary meta
  const salaryMetaOpts = opts.salaryMeta ?? { status: 200, body: SALARY_META_FIXTURE }
  await page.route(new RegExp(`${API}/users/me/salary-meta$`), (r) => {
    if (r.request().method() !== 'GET') return r.fallback()
    return r.fulfill({
      status: salaryMetaOpts.status,
      contentType: 'application/json',
      body: JSON.stringify(salaryMetaOpts.body),
    })
  })

  // Salary transactions
  await page.route(new RegExp(`${API}/transactions(\\?.*)?$`), (r) => {
    if (r.request().method() !== 'GET') return r.fallback()
    const url = new URL(r.request().url())
    if (url.searchParams.get('type') === 'SALARY') {
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([SALARY_TX_PAID, SALARY_TX_VALIDATED, SALARY_TX_PENDING]),
      })
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) })
  })
}

// ---------------------------------------------------------------------------
// AC1 — Hub: all cards render; rate / real identity absent
// ---------------------------------------------------------------------------

test.describe('AC1 — JUNIOR hub /crm/project', () => {
  test('hub renders with all main blocks visible (round 3 layout)', async ({ asJunior: page }) => {
    await mockJuniorProjectsAndLegend(page)

    await page.goto('/crm/project')

    await expect(page.getByTestId('junior-hub')).toBeVisible()

    // Left stack: ProjectInfoCard (with HR inline) + PersonaCard
    await expect(page.getByTestId('project-info-card')).toBeVisible()
    await expect(page.getByTestId('hr-inline')).toBeVisible()
    await expect(page.getByTestId('persona-card')).toBeVisible()
    // Right wide: SalarySnapshotCard
    await expect(page.getByTestId('salary-snapshot-card')).toBeVisible()
    // ContractStatusCard REMOVED in round 3 (task-junior-ut-round3 §5)
    await expect(page.getByTestId('contract-status-card')).toHaveCount(0)
    // HrContactCard REMOVED — HR is now inline in ProjectInfoCard
    await expect(page.getByTestId('hr-contact-card')).toHaveCount(0)
    // AC2: QuickLinksBar removed — quick-links-bar must NOT be in DOM
    await expect(page.getByTestId('quick-links-bar')).toHaveCount(0)
  })

  test('project-info card shows company name, domain, status — no rate/currency', async ({
    asJunior: page,
  }) => {
    await mockJuniorProjectsAndLegend(page)

    await page.goto('/crm/project')
    await expect(page.getByTestId('project-info-card')).toBeVisible()

    const card = page.getByTestId('project-info-card')
    await expect(card.getByText(JUNIOR_PROJECT.companyName)).toBeVisible()
    await expect(card.getByText(JUNIOR_PROJECT.domain!, { exact: true })).toBeVisible()
    await expect(card.getByText('Активный', { exact: true })).toBeVisible()

    // Rate and currency MUST NOT be in the DOM
    await expect(page.getByText('5000')).toHaveCount(0)
    await expect(page.getByText('5 000')).toHaveCount(0)
    await expect(page.getByText('USDT')).toHaveCount(0)
  })

  test('persona card shows legend name/role — real senior identity absent', async ({
    asJunior: page,
  }) => {
    await mockJuniorProjectsAndLegend(page)

    await page.goto('/crm/project')
    await expect(page.getByTestId('persona-card')).toBeVisible()

    const card = page.getByTestId('persona-card')
    await expect(card.getByTestId('persona-fullname')).toContainText(LEGEND_FIXTURE.fullName)
    await expect(card.getByTestId('persona-role')).toContainText(LEGEND_FIXTURE.presentedRole!)

    await expect(page.getByText(USERS.senior.displayName, { exact: false })).toHaveCount(0)
    await expect(page.getByText(USERS.senior.email, { exact: false })).toHaveCount(0)
  })

  test('persona card "Открыть легенду" button navigates to /crm/legend', async ({
    asJunior: page,
  }) => {
    await mockJuniorProjectsAndLegend(page)

    await page.goto('/crm/project')
    await expect(page.getByTestId('persona-card')).toBeVisible()

    await page.getByTestId('persona-open-legend-btn').click()
    await expect(page).toHaveURL('/crm/legend')
  })

  test('HR contact inline shows name, telegram, phone inside project-info-card (round 3)', async ({
    asJunior: page,
  }) => {
    await mockJuniorProjectsAndLegend(page)

    await page.goto('/crm/project')
    // HR is now inline in ProjectInfoCard (HrInline component, data-testid="hr-inline")
    await expect(page.getByTestId('hr-inline')).toBeVisible()

    const hrBlock = page.getByTestId('hr-inline')
    await expect(hrBlock.getByText(HR_CONTACT_FIXTURE.displayName)).toBeVisible()
    await expect(hrBlock.getByText(HR_CONTACT_FIXTURE.telegram)).toBeVisible()
    await expect(hrBlock.getByText(HR_CONTACT_FIXTURE.phone)).toBeVisible()
  })

  test('AC2: bento grid present, quick-links-bar and contract-card absent from DOM (round 3)', async ({
    asJunior: page,
  }) => {
    await mockJuniorProjectsAndLegend(page)

    await page.goto('/crm/project')
    await expect(page.getByTestId('junior-hub')).toBeVisible()

    // Bento grid container must be rendered
    await expect(page.getByTestId('junior-hub-bento')).toBeVisible()

    // Bottom full-width credentials section (round 3: no hr-credentials-row wrapper)
    await expect(page.getByTestId('credentials-section')).toBeVisible()
    // junior-hub-hr-credentials-row REMOVED in round 3 (credentials are now col-span-full standalone)
    await expect(page.getByTestId('junior-hub-hr-credentials-row')).toHaveCount(0)

    // QuickLinksBar completely removed (PR #184 AC2)
    await expect(page.getByTestId('quick-links-bar')).toHaveCount(0)
    await expect(page.getByTestId('quick-link-legend')).toHaveCount(0)

    // ContractStatusCard REMOVED in round 3
    await expect(page.getByTestId('contract-status-card')).toHaveCount(0)
  })

  test('empty-state shown when JUNIOR has no projects', async ({ asJunior: page }) => {
    await page.route(new RegExp(`${API}/projects(\\?.*)?$`), (r) => {
      if (r.request().method() !== 'GET') return r.fallback()
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      })
    })

    await page.goto('/crm/project')
    await expect(page.getByTestId('junior-hub')).toBeVisible()
    await expect(page.getByText('Вас ещё не добавили в проект.')).toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// Round 3 regression — ContractStatusCard removed from hub
// ---------------------------------------------------------------------------

test.describe('Round 3 regression — ContractStatusCard absent from hub', () => {
  test('contract-status-card NOT present in junior hub DOM (removed in round 3)', async ({
    asJunior: page,
  }) => {
    await mockJuniorProjectsAndLegend(page)

    await page.goto('/crm/project')
    await expect(page.getByTestId('junior-hub')).toBeVisible()

    // ContractStatusCard was removed from the hub in task-junior-ut-round3 §5.
    // Regression guard: ensure it is not accidentally re-introduced.
    await expect(page.getByTestId('contract-status-card')).toHaveCount(0)
    // /contracts/me/status should still NOT be called (no hook on hub after removal)
    // salary card must still be present
    await expect(page.getByTestId('salary-snapshot-card')).toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// AC3 — Salary snapshot card
// ---------------------------------------------------------------------------

test.describe('AC3 — Salary snapshot card', () => {
  test('shows rate amount and currency from salary-meta', async ({ asJunior: page }) => {
    await mockJuniorProjectsAndLegend(page)

    await page.goto('/crm/project')
    const card = page.getByTestId('salary-snapshot-card')
    await expect(card).toBeVisible()

    // Rate amount
    await expect(card.getByTestId('salary-rate-amount')).toBeVisible()
    await expect(card.getByTestId('salary-rate-amount')).toContainText('800')
    // Currency label visible in card (first match — the currency badge near the rate)
    await expect(card.getByText('USD').first()).toBeVisible()
  })

  test('salary-changed-at line visible and contains «Изменена» when changedAt is set', async ({
    asJunior: page,
  }) => {
    // SALARY_META_FIXTURE already contains changedAt: '2026-03-01T00:00:00.000Z'
    // The Coder commit cf00988 renders: <p data-testid="salary-changed-at">Изменена 1 марта 2026 г.</p>
    await mockJuniorProjectsAndLegend(page)

    await page.goto('/crm/project')
    const card = page.getByTestId('salary-snapshot-card')
    await expect(card).toBeVisible()

    const changedAtEl = card.getByTestId('salary-changed-at')
    await expect(changedAtEl).toBeVisible()
    await expect(changedAtEl).toContainText('Изменена')
  })

  test('salary-changed-at absent from DOM when changedAt is null', async ({ asJunior: page }) => {
    await mockJuniorProjectsAndLegend(page, {
      salaryMeta: {
        status: 200,
        body: { monthlySalary: '800', salaryCurrency: 'USD', changedAt: null },
      },
    })

    await page.goto('/crm/project')
    const card = page.getByTestId('salary-snapshot-card')
    await expect(card).toBeVisible()

    await expect(card.getByTestId('salary-changed-at')).toHaveCount(0)
  })

  test('PAID transaction shows badge «Выплачено»', async ({ asJunior: page }) => {
    await mockJuniorProjectsAndLegend(page)

    await page.goto('/crm/project')
    const card = page.getByTestId('salary-snapshot-card')
    await expect(card).toBeVisible()

    const txList = card.getByTestId('salary-tx-list')
    await expect(txList).toBeVisible()

    // At least one «Выплачено» badge for PAID tx
    const paidBadges = txList.getByText('Выплачено')
    await expect(paidBadges.first()).toBeVisible()
  })

  test('VALIDATED transaction also shows badge «Выплачено»', async ({ asJunior: page }) => {
    await mockJuniorProjectsAndLegend(page)

    await page.goto('/crm/project')
    const card = page.getByTestId('salary-snapshot-card')
    await expect(card).toBeVisible()

    const txList = card.getByTestId('salary-tx-list')
    // PAID + VALIDATED → 2 «Выплачено» badges
    const paidBadges = txList.getByText('Выплачено')
    await expect(paidBadges).toHaveCount(2)
  })

  test('PENDING transaction shows badge «Ожидание»', async ({ asJunior: page }) => {
    await mockJuniorProjectsAndLegend(page)

    await page.goto('/crm/project')
    const card = page.getByTestId('salary-snapshot-card')
    await expect(card).toBeVisible()

    const txList = card.getByTestId('salary-tx-list')
    await expect(txList.getByText('Ожидание').first()).toBeVisible()
  })

  test('shows max 3 last transactions', async ({ asJunior: page }) => {
    await mockJuniorProjectsAndLegend(page)

    await page.goto('/crm/project')
    const card = page.getByTestId('salary-snapshot-card')
    await expect(card).toBeVisible()

    const txRows = card.getByTestId('salary-tx-row')
    // mockJuniorProjectsAndLegend returns 3 transactions; hook slices to 3
    await expect(txRows).toHaveCount(3)
  })

  test('salary card shows rate zone and summary zone, no all-payments link', async ({
    asJunior: page,
  }) => {
    await mockJuniorProjectsAndLegend(page)

    await page.goto('/crm/project')
    const card = page.getByTestId('salary-snapshot-card')
    await expect(card).toBeVisible()

    // rate zone — крупная ставка (salary-rate-zone присутствует когда ставка задана)
    await expect(card.getByTestId('salary-rate-zone')).toBeVisible()

    // summary zone — прижата к низу, показывает ставку за месяц
    await expect(card.getByTestId('salary-summary')).toBeVisible()

    // кнопка «Все мои выплаты» УДАЛЕНА по фидбеку UT round 4
    await expect(card.getByTestId('salary-all-link')).toHaveCount(0)
  })

  test('no-salary state when salary-meta returns null monthlySalary', async ({
    asJunior: page,
  }) => {
    // Use opts.salaryMeta to override — avoids LIFO conflict
    await mockJuniorProjectsAndLegend(page, {
      salaryMeta: {
        status: 200,
        body: { monthlySalary: null, salaryCurrency: null, changedAt: null },
      },
    })

    await page.goto('/crm/project')
    const card = page.getByTestId('salary-snapshot-card')
    await expect(card).toBeVisible()

    await expect(card.getByTestId('salary-no-rate')).toBeVisible()
    await expect(card.getByTestId('salary-no-rate')).toContainText('Ставка не назначена')
  })
})

// ---------------------------------------------------------------------------
// AC2 — Legend page: view + edit + journal
// ---------------------------------------------------------------------------

test.describe('AC2 — JUNIOR /crm/legend', () => {
  test('legend page renders all 3 blocks', async ({ asJunior: page }) => {
    await mockJuniorProjectsAndLegend(page)

    await page.goto('/crm/legend')

    await expect(page.getByTestId('legend-page')).toBeVisible()
    await expect(page.getByTestId('legend-persona-block')).toBeVisible()
    await expect(page.getByTestId('legend-cover-block')).toBeVisible()
    await expect(page.getByTestId('legend-journal-block')).toBeVisible()
  })

  test('persona block shows fullName, dateOfBirth, address, hobbies', async ({
    asJunior: page,
  }) => {
    await mockJuniorProjectsAndLegend(page)

    await page.goto('/crm/legend')
    const block = page.getByTestId('legend-persona-block')
    await expect(block).toBeVisible()

    await expect(block.getByText(LEGEND_FIXTURE.fullName)).toBeVisible()
    await expect(block.getByText(LEGEND_FIXTURE.hobbies!)).toBeVisible()
  })

  test('cover block shows presentedRole and presentedStack', async ({ asJunior: page }) => {
    await mockJuniorProjectsAndLegend(page)

    await page.goto('/crm/legend')
    const block = page.getByTestId('legend-cover-block')
    await expect(block).toBeVisible()

    await expect(block.getByText(LEGEND_FIXTURE.presentedRole!)).toBeVisible()
    await expect(block.getByText(LEGEND_FIXTURE.presentedStack!)).toBeVisible()
  })

  test('journal block shows existing entry and add-entry form', async ({ asJunior: page }) => {
    await mockJuniorProjectsAndLegend(page)

    await page.goto('/crm/legend')
    const block = page.getByTestId('legend-journal-block')
    await expect(block).toBeVisible()

    // Existing entry text
    await expect(block.getByTestId('legend-entry-item').first()).toBeVisible()
    const firstEntry = LEGEND_FIXTURE.entries[0]
    if (firstEntry) {
      await expect(block.getByText(firstEntry.text)).toBeVisible()
    }

    // Add-entry button
    await expect(block.getByTestId('legend-entry-add-btn')).toBeVisible()
  })

  test('JUNIOR can add journal entry', async ({ asJunior: page }) => {
    await mockJuniorProjectsAndLegend(page)

    await page.goto('/crm/legend')
    const block = page.getByTestId('legend-journal-block')
    await expect(block).toBeVisible()

    await block.getByTestId('legend-entry-add-btn').click()
    await expect(block.getByTestId('legend-entry-textarea')).toBeVisible()

    await block.getByTestId('legend-entry-textarea').fill('Тестовий запис від JUNIOR')

    await block.getByTestId('legend-entry-submit-btn').click()

    // Form should collapse (success path)
    await expect(block.getByTestId('legend-entry-textarea')).not.toBeVisible({ timeout: 3000 })
  })

  test('SENIOR is redirected away from /crm/legend', async ({ asSenior: page }) => {
    await page.goto('/crm/legend')
    await expect(page.getByTestId('legend-page')).not.toBeVisible({ timeout: 3000 })
    await expect(page).not.toHaveURL('/crm/legend')
  })
})

// ---------------------------------------------------------------------------
// AC6 — Legend persona UX: icon-only X in header, «Отмена» only in footer
// ---------------------------------------------------------------------------

test.describe('AC6 — Legend persona edit form UX', () => {
  test('edit form has icon-only X cancel in header and text Отмена only in footer', async ({
    asJunior: page,
  }) => {
    await mockJuniorProjectsAndLegend(page)

    await page.goto('/crm/legend')
    const block = page.getByTestId('legend-persona-block')
    await expect(block).toBeVisible()

    // Open edit form
    await block.getByRole('button', { name: /Редактировать|Создать/ }).click()

    // Header X cancel: aria-label "Отмена редактирования", icon-only (no visible text)
    const headerCancel = block.getByTestId('persona-edit-cancel-icon')
    await expect(headerCancel).toBeVisible()

    // Footer «Отмена» button (exact text label — distinct from header aria-label "Отмена редактирования")
    const footerCancel = block.getByRole('button', { name: 'Отмена', exact: true })
    await expect(footerCancel).toBeVisible()

    // Only ONE exact-text «Отмена» button — the footer one
    await expect(block.getByRole('button', { name: 'Отмена', exact: true })).toHaveCount(1)
  })

  test('footer Отмена resets form and exits edit mode', async ({ asJunior: page }) => {
    await mockJuniorProjectsAndLegend(page)

    await page.goto('/crm/legend')
    const block = page.getByTestId('legend-persona-block')

    await block.getByRole('button', { name: /Редактировать|Создать/ }).click()

    // Edit form is open — ФИО input should be visible
    const fullNameInput = block.getByRole('textbox', { name: /ФИО/ })
    await expect(fullNameInput).toBeVisible()
    await fullNameInput.fill('Зміни які не зберегти')

    await block.getByRole('button', { name: 'Отмена', exact: true }).click()

    // Edit form collapses
    await expect(fullNameInput).not.toBeVisible({ timeout: 2000 })
  })

  test('header X cancel also exits edit mode without saving', async ({ asJunior: page }) => {
    await mockJuniorProjectsAndLegend(page)

    await page.goto('/crm/legend')
    const block = page.getByTestId('legend-persona-block')

    await block.getByRole('button', { name: /Редактировать|Створити|Создать/ }).click()

    const fullNameInput = block.getByRole('textbox', { name: /ФИО/ })
    await expect(fullNameInput).toBeVisible()

    // Click the icon-only X in the header
    await block.getByTestId('persona-edit-cancel-icon').click()

    await expect(fullNameInput).not.toBeVisible({ timeout: 2000 })
  })
})

// ---------------------------------------------------------------------------
// AC7 — Legend: DatePickerField in persona form and journal form
// ---------------------------------------------------------------------------

test.describe('AC7 — DatePickerField in legend forms', () => {
  test('persona edit form has DatePickerField for Дата рождения', async ({ asJunior: page }) => {
    // Use legend with no dateOfBirth so DatePickerField shows placeholder text
    const legendNoDob = { ...LEGEND_FIXTURE, dateOfBirth: null }
    await mockJuniorProjectsAndLegend(page, { legend: legendNoDob })

    await page.goto('/crm/legend')
    const block = page.getByTestId('legend-persona-block')
    await expect(block).toBeVisible()

    await block.getByRole('button', { name: /Редактировать|Создать/ }).click()

    // DatePickerField renders as a button with the field label when no date is set
    // DOM snapshot shows: button "Дата рождения" (label text, not placeholder phrase)
    const datePickerBtn = block.getByRole('button', { name: /Дата рождения/i })
    await expect(datePickerBtn).toBeVisible()
  })

  test('journal add form has DatePickerField for event date (default empty)', async ({
    asJunior: page,
  }) => {
    await mockJuniorProjectsAndLegend(page)

    await page.goto('/crm/legend')
    const block = page.getByTestId('legend-journal-block')
    await expect(block).toBeVisible()

    await block.getByTestId('legend-entry-add-btn').click()

    // DatePickerField for event date
    const eventDateBtn = block.getByRole('button', { name: /Выберите дату события/i })
    await expect(eventDateBtn).toBeVisible()
  })

  test('journal entry item shows eventDate when provided (not createdAt)', async ({
    asJunior: page,
  }) => {
    // Override legend via opts.legend — single handler, no LIFO conflicts
    const legendWithEventDate = {
      ...LEGEND_FIXTURE,
      entries: [
        {
          ...LEGEND_FIXTURE.entries[0]!,
          eventDate: '2026-01-15',
          // createdAt is different to confirm we display eventDate, not createdAt
          createdAt: '2026-01-20T00:00:00.000Z',
        },
      ],
    }

    await mockJuniorProjectsAndLegend(page, { legend: legendWithEventDate })

    await page.goto('/crm/legend')
    const block = page.getByTestId('legend-journal-block')
    await expect(block).toBeVisible()

    const entryItem = block.getByTestId('legend-entry-item').first()
    await expect(entryItem).toBeVisible()
    // eventDate 2026-01-15 → displayed as "15.01.2026" (ru-RU locale)
    await expect(entryItem).toContainText('15.01.2026')
  })
})

// ---------------------------------------------------------------------------
// AC8 (RBAC UI) — JUNIOR gets no defaults prefill in persona form
// ---------------------------------------------------------------------------

test.describe('AC8 — JUNIOR legend persona form has no prefill (defaults=null)', () => {
  test('JUNIOR edit form fields are empty (no defaults leaked)', async ({ asJunior: page }) => {
    // Legend with no fullName/address and defaults=null — as API returns for JUNIOR viewer
    const emptyLegend = {
      ...LEGEND_FIXTURE,
      fullName: null,
      address: null,
      defaults: null,
    }
    await mockJuniorProjectsAndLegend(page, { legend: emptyLegend })

    await page.goto('/crm/legend')
    const block = page.getByTestId('legend-persona-block')
    await expect(block).toBeVisible()

    await block.getByRole('button', { name: /Создать|Редактировать/ }).click()

    // ФИО field must be empty (no prefill from real senior identity)
    const fullNameInput = block.getByRole('textbox', { name: /ФИО/ })
    await expect(fullNameInput).toBeVisible()
    await expect(fullNameInput).toHaveValue('')

    // Address field must be empty
    const addressInput = block.getByRole('textbox', { name: /Адрес/i })
    await expect(addressInput).toHaveValue('')
  })
})

// ---------------------------------------------------------------------------
// AC3 — JUNIOR sidebar nav
// ---------------------------------------------------------------------------

test.describe('AC3 — JUNIOR sidebar nav', () => {
  test('JUNIOR desktop nav has exactly 5 items', async ({ asJunior: page }) => {
    await mockJuniorProjectsAndLegend(page)

    await page.goto('/crm/project')
    await expect(page.getByTestId('junior-hub')).toBeVisible()

    const nav = page.getByTestId('junior-nav')
    await expect(nav).toBeVisible()

    const navLinks = nav.getByRole('link')
    await expect(navLinks).toHaveCount(5)
  })

  test('JUNIOR nav contains Мой проект, Легенда, Финансы, Документы, Профиль', async ({
    asJunior: page,
  }) => {
    await mockJuniorProjectsAndLegend(page)

    await page.goto('/crm/project')
    await expect(page.getByTestId('junior-hub')).toBeVisible()

    const nav = page.getByTestId('junior-nav')
    await expect(nav.getByText('Мой проект')).toBeVisible()
    await expect(nav.getByText('Легенда')).toBeVisible()
    await expect(nav.getByText('Финансы')).toBeVisible()
    await expect(nav.getByText('Документы')).toBeVisible()
    await expect(nav.getByText('Профиль')).toBeVisible()
  })

  test('JUNIOR nav does NOT contain Дашборд, Команда, Проекты, Собеседования', async ({
    asJunior: page,
  }) => {
    await mockJuniorProjectsAndLegend(page)

    await page.goto('/crm/project')
    await expect(page.getByTestId('junior-hub')).toBeVisible()

    const nav = page.getByTestId('junior-nav')
    await expect(nav.getByText('Дашборд')).not.toBeVisible()
    await expect(nav.getByText('Команда')).not.toBeVisible()
    await expect(nav.getByText('Проекты')).not.toBeVisible()
    await expect(nav.getByText('Собеседования')).not.toBeVisible()
  })

  test('Regression — ADMIN nav is unaffected (no junior-nav testid, more items visible)', async ({
    asAdmin: page,
  }) => {
    await page.goto('/crm/team')

    await expect(page.getByTestId('junior-nav')).not.toBeVisible()

    await expect(page.getByRole('link', { name: 'Команда' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Проекты' })).toBeVisible()
  })

  test('Regression — SENIOR nav is unaffected', async ({ asSenior: page }) => {
    await page.goto('/crm/profile')

    await expect(page.getByTestId('junior-nav')).not.toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// AC4 — Route guards: JUNIOR redirect on forbidden URLs (PR #184 §4)
// ---------------------------------------------------------------------------

test.describe('AC4 — Route guards — JUNIOR redirected from forbidden routes', () => {
  // Forbidden routes for JUNIOR (not in ROUTE_ACCESS['JUNIOR'] list)
  const forbiddenRoutes = ['/crm/projects', '/crm/team', '/crm/users', '/crm/stats']

  for (const route of forbiddenRoutes) {
    test(`JUNIOR on ${route} → redirected to /crm/project`, async ({ asJunior: page }) => {
      // Need minimal mocks so the hub can render after redirect
      await page.route(new RegExp(`${API}/projects(\\?.*)?$`), (r) => {
        if (r.request().method() !== 'GET') return r.fallback()
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([]),
        })
      })

      await page.goto(route)

      // After guard fires: URL changes to /crm/project (role home for JUNIOR)
      await expect(page).toHaveURL('/crm/project', { timeout: 8000 })
      // The forbidden page must not have rendered its content
      await expect(page).not.toHaveURL(route)
    })
  }

  // Allowed routes for JUNIOR — must open without redirect
  const allowedRoutes = [
    { path: '/crm/project', testid: 'junior-hub' },
    { path: '/crm/legend', testid: 'legend-page' },
  ]

  for (const { path, testid } of allowedRoutes) {
    test(`JUNIOR on ${path} → stays on page (not redirected)`, async ({ asJunior: page }) => {
      await mockJuniorProjectsAndLegend(page)

      await page.goto(path)

      // Must stay on intended URL
      await expect(page).toHaveURL(path, { timeout: 8000 })
      await expect(page.getByTestId(testid)).toBeVisible()
    })
  }

  test('JUNIOR on /crm/finance → stays on finance page (allowed)', async ({ asJunior: page }) => {
    await mockJuniorProjectsAndLegend(page)

    await page.goto('/crm/finance')

    // Finance allowed for all roles — must not redirect to /crm/project
    await expect(page).not.toHaveURL('/crm/project', { timeout: 5000 })
    await expect(page).toHaveURL('/crm/finance')
  })

  test('JUNIOR on /crm/documents → stays on documents page (allowed)', async ({
    asJunior: page,
  }) => {
    await mockJuniorProjectsAndLegend(page)

    await page.goto('/crm/documents')

    await expect(page).not.toHaveURL('/crm/project', { timeout: 5000 })
    await expect(page).toHaveURL('/crm/documents')
  })
})

// ---------------------------------------------------------------------------
// AC6 — Credentials: hub add-button visible; profile section RBAC (PR #184 §6)
// ---------------------------------------------------------------------------

const CRED_ID = 'e0000000-0000-4000-8000-000000000001'

const CREDENTIAL_FIXTURE = {
  id: CRED_ID,
  projectId: 'a0000000-0000-4000-8000-000000000099',
  label: 'Jira',
  login: 'junior@company.com',
  url: 'https://company.atlassian.net',
  createdAt: '2024-01-15T00:00:00.000Z',
}

/** Mock /api/users/:userId/credentials (user-scoped for ProfileCredentialsSection) */
async function mockUserCredentials(
  page: import('@playwright/test').Page,
  userId: string,
  body: object[],
  status = 200,
) {
  await page.route(new RegExp(`${API}/users/${userId}/credentials$`), (r) => {
    if (r.request().method() !== 'GET') return r.fallback()
    return r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  })
}

test.describe('AC6 — Credentials visibility', () => {
  test('JUNIOR hub has add-credential button (canAdd=true, round 3 col-span-full)', async ({
    asJunior: page,
  }) => {
    await mockJuniorProjectsAndLegend(page)

    await page.goto('/crm/project')
    await expect(page.getByTestId('junior-hub-bento')).toBeVisible()

    // Round 3: credentials are full-width col-span-full, no hr-credentials-row wrapper.
    // credentials-section is rendered directly in the bento grid.
    const credSection = page.getByTestId('credentials-section')
    await expect(credSection).toBeVisible()

    // canAdd=true → add button present (JUNIOR can add credentials to their project)
    const addBtn = credSection.getByTestId('credentials-add-btn')
    await expect(addBtn).toBeVisible()
  })

  test('ADMIN viewing JUNIOR profile: profile-credentials-section visible', async ({
    asAdmin: page,
  }) => {
    // LIFO: register AFTER mockAuthAs (called by asAdmin fixture) to win over the generic handler
    await page.route(new RegExp(`${API}/users/${USERS.junior.id}$`), (r) => {
      if (r.request().method() !== 'GET') return r.fallback()
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: { ...USERS.junior },
          permissions: {
            tabs: ['overview', 'finance', 'projects', 'team', 'requisites', 'documents'],
            actions: [
              'edit-profile',
              'change-role',
              'change-salary',
              'change-requisites',
              'set-note',
              'archive',
            ],
            fields: {
              salary: true,
              share: false,
              paymentMethodKpi: true,
              techStack: true,
              registrationDate: true,
              // ADMIN/HR can see junior credentials (PR #184 §6)
              projectCredentials: true,
            },
          },
          data: {},
        }),
      })
    })

    // Mock user-scoped credentials endpoint → returns a credential
    await mockUserCredentials(page, USERS.junior.id, [CREDENTIAL_FIXTURE])

    // Correct route: /crm/profile/$userId (not /crm/users/$userId)
    await page.goto(`/crm/profile/${USERS.junior.id}`)

    await expect(page.getByTestId('profile-credentials-section')).toBeVisible({ timeout: 8000 })
  })

  test('HR viewing JUNIOR profile: profile-credentials-section visible', async ({ asHr: page }) => {
    await page.route(new RegExp(`${API}/users/${USERS.junior.id}$`), (r) => {
      if (r.request().method() !== 'GET') return r.fallback()
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: { ...USERS.junior },
          permissions: {
            tabs: ['overview', 'projects', 'team'],
            actions: [],
            fields: {
              techStack: true,
              registrationDate: true,
              projectCredentials: true,
            },
          },
          data: {},
        }),
      })
    })

    await mockUserCredentials(page, USERS.junior.id, [CREDENTIAL_FIXTURE])

    await page.goto(`/crm/profile/${USERS.junior.id}`)

    await expect(page.getByTestId('profile-credentials-section')).toBeVisible({ timeout: 8000 })
  })

  test('JUNIOR self-view: profile-credentials-section NOT visible', async ({ asJunior: page }) => {
    // Self-view does NOT include projectCredentials permission
    // (the section is only for ADMIN/HR viewers of a junior)
    await page.goto('/crm/profile')

    // profile-credentials-section should NOT be rendered for self-view
    // (permissions.fields.projectCredentials is absent/false in self-view DTO)
    await expect(page.getByTestId('profile-credentials-section')).toHaveCount(0)
  })
})

// ---------------------------------------------------------------------------
// Round 3 — JUNIOR profile: 2 tabs only (overview + requisites, no documents)
// ---------------------------------------------------------------------------

test.describe('Round 3 — JUNIOR profile self-view tabs', () => {
  test('JUNIOR self-view has overview and requisites tabs, documents tab absent', async ({
    asJunior: page,
  }) => {
    await page.goto('/crm/profile')
    await expect(page.getByRole('heading', { name: 'Junior Dev' })).toBeVisible()

    // overview tab present
    await expect(page.getByRole('button', { name: 'Обзор' })).toBeVisible()
    // requisites tab present
    await expect(page.getByRole('button', { name: 'Реквизиты', exact: true })).toBeVisible()

    // documents tab ABSENT — task-junior-ut-round3 §6a removed it from JUNIOR self-view
    await expect(page.getByRole('button', { name: 'Документы', exact: true })).toHaveCount(0)
  })

  test('JUNIOR self-view: tos-acceptance-card absent (backend withholds tosAcceptedAt)', async ({
    asJunior: page,
  }) => {
    // Backend sets canSeeTos=false for JUNIOR self (task-junior-ut-round3 §6b):
    // tosAcceptedAt is NOT included in data.overview → OverviewTab renders canSeeTos=false
    // → tos-acceptance-card is not rendered.
    await page.goto('/crm/profile')
    await expect(page.getByRole('heading', { name: 'Junior Dev' })).toBeVisible()

    // tos-acceptance-card must NOT be present
    await expect(page.getByTestId('tos-acceptance-card')).toHaveCount(0)
  })
})
