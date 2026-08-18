/**
 * polish-regressions.spec.ts
 *
 * Coverage for task-autotest-polish-coverage (AC1-AC5): the *non-obvious*
 * regressions introduced by the round-1 + round-2 polish batch on
 * `chore/remove-knowledge-base`. These are the kinds of breakage a plain
 * "dialog opens" smoke test misses — money formatting, avatar fallback
 * shape, and console / network hygiene.
 *
 *   AC1 — money format: table shows USD with a `$` prefix (NOT the old `₮`
 *         Tugrik glyph); the transaction detail dialog shows BOTH the USD
 *         figure AND the original currency line (e.g. «7 777,00 USDT»).
 *   AC2 — avatar / project-logo fallback renders INITIALS (Radix Avatar
 *         Fallback text), not a stub «Превью недоступно» icon.
 *   AC3 — console / network assertions (the heart of the task):
 *           • /finance: no «Function components cannot be given refs»
 *             (TransactionRow forwardRef regression — fired ~60× per row).
 *           • /team/:id: no validateDOMNesting «<a> … <a>» warning.
 *           • /interviews as SENIOR: no 403 on /api/users (query gated).
 *   AC4 — canonical spelling «синьора» (NOT «синьера») on the public
 *         invoice verify page.
 *   AC5 — styled 404 empty-state on an unknown route (icon + copy + «На
 *         главную» link), not a bare «Not Found».
 *
 * NOTE: payout / invoice-signing flow coverage lives in
 * finance-senior-payment-flow.spec.ts + invoices-signing-flow.spec.ts
 * (PR #60) — deliberately NOT duplicated here.
 */
import { test, expect, USERS, PROJECTS, API_GLOB, API_RE } from './fixtures'
import type { Page, ConsoleMessage } from '@playwright/test'

// Mirror of UserAvatar.getInitials (apps/web/app/components/users/UserAvatar.tsx).
// Inlined rather than imported because that component pulls in the `@/` alias
// + JSX, which the Playwright runner can't resolve. Kept byte-identical so the
// assertion tracks the component's real output.
function getInitials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase()
}

const PROJECT = PROJECTS[0]!
const PROJECT_ID = PROJECT.id
const PROJECT_NAME = PROJECT.name

// ---------------------------------------------------------------------------
// Console-listener helper — collects error+warning text emitted during a
// navigation so AC3 can assert the absence of specific React/runtime
// warnings. React logs forwardRef / validateDOMNesting via console.error,
// so we capture both `error` and `warning` types to be safe across React
// builds.
// ---------------------------------------------------------------------------

function collectConsole(page: Page): { messages: string[] } {
  const store: { messages: string[] } = { messages: [] }
  page.on('console', (msg: ConsoleMessage) => {
    const type = msg.type()
    if (type === 'error' || type === 'warning') {
      store.messages.push(msg.text())
    }
  })
  // React often surfaces dev warnings through uncaught console.error wrappers
  // that also bubble as pageerror — fold those in too.
  page.on('pageerror', (err) => {
    store.messages.push(err.message)
  })
  return store
}

// A USDT senior-income transaction whose USD figure (USDT is 1:1 with USD)
// is a clean round number so the `$` formatting is unambiguous to assert.
const TX_USDT_SENIOR = {
  id: 'tx-usdt-senior',
  type: 'SENIOR_INCOME',
  status: 'VALIDATED',
  amount: '7777.00',
  currency: 'USDT',
  senderId: null,
  senderName: null,
  senderLabel: 'TechCorp AI',
  receiverId: USERS.senior.id,
  receiverName: USERS.senior.displayName,
  receiverLabel: null,
  seniorSharePercent: 26,
  projectId: PROJECT_ID,
  projectName: PROJECT_NAME,
  receiptDocumentId: null,
  receiptExternalUrl: null,
  notes: null,
  salaryMonth: null,
  txHash: null,
  rejectionReason: null,
  payoutRequestId: null,
  validatedBy: USERS.accountant.id,
  validatedAt: '2026-05-02T10:00:00.000Z',
  createdAt: '2026-05-01T10:00:00.000Z',
  updatedAt: '2026-05-02T10:00:00.000Z',
}

async function mockTxList(page: Page, rows: object[]) {
  await page.route(new RegExp(`${API_RE}/transactions/([^/?]+)$`), (r) => {
    const id = r.request().url().split('/').at(-1)
    const found = rows.find((t) => (t as { id: string }).id === id) ?? rows[0]
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(found ?? {}),
    })
  })
  await page.route(new RegExp(`${API_RE}/transactions(\\?.*)?$`), (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) }),
  )
  await page.route(new RegExp(`${API_RE}/payout-requests(\\?.*)?$`), (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// AC1 — money format ($ in table, source currency + USD in detail)
// ═══════════════════════════════════════════════════════════════════════════

test.describe('AC1 — money format', () => {
  test('table renders the USD amount with a $ prefix, NOT the ₮ glyph', async ({ asAdmin }) => {
    await mockTxList(asAdmin, [TX_USDT_SENIOR])
    await asAdmin.goto('/finance')

    const row = asAdmin.getByTestId(`tx-row-${TX_USDT_SENIOR.id}`)
    await expect(row).toBeVisible()
    // fmtUsd → en-US → «$7,777.00». USDT is pegged 1:1 so the source value
    // passes straight through to the USD column.
    await expect(row.getByText('$7,777.00')).toBeVisible()
    // The legacy ad-hoc Tugrik «₮» symbol must be gone everywhere on the page.
    await expect(asAdmin.getByText(/₮/)).toHaveCount(0)
  })

  test('detail dialog shows BOTH the USD figure and the source currency line', async ({
    asAdmin,
  }) => {
    await mockTxList(asAdmin, [TX_USDT_SENIOR])
    await asAdmin.goto('/finance')
    await asAdmin.getByTestId(`tx-row-${TX_USDT_SENIOR.id}`).click()

    const dialog = asAdmin.getByRole('dialog')
    await expect(dialog).toBeVisible()
    // Big figure = USD-converted.
    await expect(dialog.getByText('$7,777.00')).toBeVisible()
    // Subline = original currency via the shared ru-RU formatter → thin-space
    // thousands + comma decimal + «USDT» suffix. The char class tolerates the
    // exact separator (NBSP / narrow-NBSP / space) the locale emits.
    await expect(dialog.getByText(/7[\s  ]?777,00\s*USDT/)).toBeVisible()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// AC2 — avatar / project-logo fallback → initials (not stub icon)
// ═══════════════════════════════════════════════════════════════════════════

test.describe('AC2 — avatar fallback renders initials', () => {
  // NOTE: this codebase's shadcn <Avatar> (apps/web/app/components/ui/avatar.tsx)
  // wraps Radix primitives WITHOUT a `data-slot` attribute, so the fallback is
  // asserted by its rendered initials text inside the avatar root — not by a
  // [data-slot=avatar-fallback] selector. The Radix Fallback is the only text
  // node the avatar emits when no image is present.
  test('header user menu avatar falls back to the user initials', async ({ asSenior }) => {
    // Seed senior has avatarUrl=null + avatarDocumentId=null → initials path.
    await asSenior.goto('/')
    const trigger = asSenior.getByTestId('header-user-menu-trigger')
    await expect(trigger).toBeVisible()

    // getInitials('Senior Dev') === 'SD' — the Radix Fallback renders this as
    // the avatar's text content once it determines no image will load.
    const expected = getInitials(USERS.senior.displayName)
    await expect(trigger).toContainText(expected)
    // Defensive: the fallback is NOT the «Превью недоступно» stub image icon
    // (that's the DocumentImage error placeholder — must never leak here).
    await expect(trigger.getByText('Превью недоступно')).toHaveCount(0)
    await expect(trigger.locator('img[alt="Превью недоступно"]')).toHaveCount(0)
    await expect(trigger.locator('svg.lucide-image')).toHaveCount(0)
  })

  test('project logo on the project detail page falls back to the company initials', async ({
    asAdmin,
  }) => {
    // The project detail page requires an `effectiveTeam` object on the
    // /projects/:id response (the default fixture mock omits it → error state).
    // Register a one-off override mirroring projects-senior-share-override's
    // helper so the page renders its header (and thus the ProjectLogo).
    await asAdmin.route(`${API_GLOB}/projects/${PROJECT_ID}`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...PROJECT,
          logoDocumentId: null,
          logoExternalUrl: null,
          effectiveTeam: {
            senior: {
              id: USERS.senior.id,
              displayName: USERS.senior.displayName,
              email: USERS.senior.email,
              avatar: null,
              role: 'SENIOR',
            },
            hrs: [],
            accountants: [],
            juniors: [],
          },
        }),
      }),
    )
    // PROJECTS[0] has logoDocumentId=null + logoExternalUrl=null → initials.
    // The detail header passes fallback={getInitials(companyName)} → two-letter
    // «TA» for «TechCorp AI» (page-local getInitials = first char of first two
    // space-split words).
    const expectedInitials = getInitials(PROJECT.companyName)
    await asAdmin.goto(`/projects/${PROJECT_ID}`)

    // project-senior-share testid proves the detail page loaded its header.
    await expect(asAdmin.getByTestId('project-senior-share')).toBeVisible()
    // The logo fallback renders the company initials (Radix Fallback span).
    await expect(asAdmin.getByText(expectedInitials, { exact: true }).first()).toBeVisible()
    // No DocumentImage error stub leaked into the logo slot.
    await expect(asAdmin.getByText('Превью недоступно')).toHaveCount(0)
    await expect(asAdmin.locator('img[alt="Превью недоступно"]')).toHaveCount(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// AC3 — console / network hygiene (the heart of the task)
// ═══════════════════════════════════════════════════════════════════════════

test.describe('AC3 — console clean: forwardRef / nested-a / 403', () => {
  test('/finance: no «Function components cannot be given refs» warning', async ({ asAdmin }) => {
    const console_ = collectConsole(asAdmin)
    await mockTxList(asAdmin, [TX_USDT_SENIOR])
    await asAdmin.goto('/finance')
    // Wait for the animated rows to actually mount — the forwardRef warning
    // only fires once framer-motion tries to attach a ref to each <tr>.
    await expect(asAdmin.getByTestId(`tx-row-${TX_USDT_SENIOR.id}`)).toBeVisible()
    await asAdmin.waitForTimeout(300)

    const refWarnings = console_.messages.filter((m) =>
      /Function components cannot be given refs/i.test(m),
    )
    expect(refWarnings, `forwardRef warnings on /finance:\n${refWarnings.join('\n')}`).toEqual([])
  })

  test('/team/:id: no validateDOMNesting «<a> in <a>» warning', async ({ asAdmin }) => {
    const console_ = collectConsole(asAdmin)
    const teamId = 'team-1-id'
    await asAdmin.goto(`/team/${teamId}`)
    // The member cards are what nest the anchors — wait until they render.
    await expect(asAdmin.getByText('Участники команды')).toBeVisible()
    await expect(asAdmin.getByText(USERS.senior.displayName).first()).toBeVisible()
    await asAdmin.waitForTimeout(300)

    const nestingWarnings = console_.messages.filter(
      (m) => /validateDOMNesting/i.test(m) || /cannot (?:appear|be a descendant)/i.test(m),
    )
    expect(
      nestingWarnings,
      `DOM-nesting warnings on team detail:\n${nestingWarnings.join('\n')}`,
    ).toEqual([])
  })

  test('/interviews as SENIOR: no request to /api/users (gated → no 403)', async ({ asSenior }) => {
    // The board-selector user list is gated to ADMIN/HR. For a SENIOR the
    // query is disabled, so the request must never leave the page — that is
    // what removes the backend 403. We assert at the network layer: zero
    // /api/users hits, and (defensively) no 403 response if one did fire.
    const usersRequests: string[] = []
    const forbiddenResponses: string[] = []
    asSenior.on('request', (req) => {
      if (/\/api\/users(\b|\?|$)/.test(req.url())) usersRequests.push(req.url())
    })
    asSenior.on('response', (res) => {
      if (/\/api\/users(\b|\?|$)/.test(res.url()) && res.status() === 403) {
        forbiddenResponses.push(res.url())
      }
    })

    await asSenior.goto('/interviews')
    // Board renders the senior's own cards without the selector.
    await expect(asSenior.getByText('Acme Corp').first()).toBeVisible()
    await asSenior.waitForTimeout(300)

    expect(
      usersRequests,
      `SENIOR should not fetch /api/users:\n${usersRequests.join('\n')}`,
    ).toEqual([])
    expect(forbiddenResponses).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// AC4 — canonical spelling «синьора» (not «синьера») on the public verify page
// ═══════════════════════════════════════════════════════════════════════════

test.describe('AC4 — «синьора» spelling on verify page', () => {
  test('public verify page renders «синьора», never «синьера»', async ({ page }) => {
    // This is an UNAUTHENTICATED page (QR target) — no mockAuthAs. We only
    // stub the public verify endpoint the page fetches directly.
    const TX_ID = '11111111-2222-4333-8444-555566667777'
    const verify = {
      transactionId: TX_ID,
      status: 'SIGNED',
      amount: '7777.00',
      currency: 'USDT',
      type: 'SENIOR_INCOME', // → TYPE_LABEL «Акт выполненных работ (выплата синьора)»
      signatures: [
        {
          role: 'COMPANY',
          signerName: USERS.admin.displayName,
          signedAt: '2026-05-10T12:00:00.000Z',
          pdfHashShort: 'cafebabe',
        },
        {
          role: 'COUNTERPARTY',
          signerName: USERS.senior.displayName,
          signedAt: '2026-05-11T09:30:00.000Z',
          pdfHashShort: 'deadbeef',
        },
      ],
    }
    await page.route(new RegExp(`${API_RE}/invoices/verify/${TX_ID}$`), (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(verify) }),
    )

    await page.goto(`/invoice/v/${TX_ID}`)
    await expect(page.getByTestId('invoice-verify-success')).toBeVisible()

    // Canonical spelling present (inside the «Тип» row label).
    await expect(page.getByText(/синьора/).first()).toBeVisible()
    // Typo must not appear anywhere on the page.
    await expect(page.getByText(/синьера/)).toHaveCount(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// AC5 — styled 404 on an unknown route
// ═══════════════════════════════════════════════════════════════════════════

test.describe('AC5 — styled 404 empty-state', () => {
  test('unknown route renders the styled NotFound with a «На главную» link', async ({
    asAdmin,
  }) => {
    await asAdmin.goto('/nonexistent-xyz')

    // The styled empty-state link carries a stable testid and points at /crm
    // (Button asChild → renders the TanStack <Link> as an <a href="/">).
    const homeLink = asAdmin.getByTestId('not-found-home-link')
    await expect(homeLink).toBeVisible()
    await expect(homeLink).toContainText('На главную')
    await expect(homeLink).toHaveAttribute('href', '/')
    // Russian copy + 404 code — proves it's the styled state, not bare text.
    await expect(asAdmin.getByText('Страница не найдена')).toBeVisible()
    await expect(asAdmin.getByText('404')).toBeVisible()
    // Bare TanStack «Not Found» fallback must NOT be what rendered.
    await expect(asAdmin.getByText(/^Not Found$/)).toHaveCount(0)
  })

  test('clicking «На главную» navigates back to the CRM workspace', async ({ asAdmin }) => {
    // asAdmin already mocks every CRM API call (incl. transactions), so the
    // dashboard shell that /crm lands on renders without extra stubs.
    await asAdmin.goto('/nonexistent-xyz')
    await asAdmin.getByTestId('not-found-home-link').click()
    // /crm redirects into the dashboard shell — assert we left the 404.
    await expect(asAdmin.getByText('Страница не найдена')).toHaveCount(0)
    await expect(asAdmin).toHaveURL(/\/(\/|$)/)
  })
})
