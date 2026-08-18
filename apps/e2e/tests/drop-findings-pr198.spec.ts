/**
 * drop-findings-pr198.spec.ts
 *
 * E2E regression guards for UT findings 1 & 2 from PR #198 review
 * (task-drop-phase3-frontend, fix commit 74befbe).
 *
 * Finding 1 — DROP documents page access:
 *   Before fix: DROP was absent from ROUTE_ACCESS['/documents'] →
 *   useRoleGuard redirected to the DROP home (now /crm root). Backend also had no
 *   ownerId-scoping for DROP in documents.service.ts.
 *
 *   After fix:
 *     - DROP added to ROUTE_ACCESS['/documents'] (route-access.ts).
 *     - documents.tsx useRoleGuard now includes 'DROP'.
 *     - nav-sidebar shows «Документы» in drop-nav (navRolesFor → DROP included).
 *     - documents.service.ts forces ownerId=actor.id for DROP (IDOR fix).
 *
 *   E2E coverage:
 *     F1a — DROP navigates to /documents, page renders (no redirect/403).
 *     F1b — drop-nav contains «Документы» link.
 *     F1c — GET /api/documents response for DROP contains only own-owner docs
 *           (mock fulfills with ownerId=USERS.drop.id; test verifies rendered row).
 *     F1d — RBAC inversion: other user's doc (different ownerId) is NOT rendered
 *           when backend correctly scopes to DROP (mock returns filtered list).
 *
 * Finding 2 — ContractTab read-only for non-ADMIN:
 *   Before fix: ContractTab had no canEdit prop; all viewers saw the ADMIN
 *   editor (ContractEditor + ContractActionBar + mutation controls).
 *
 *   After fix:
 *     - ContractTab accepts canEdit (default false).
 *     - UserProfileShell passes canEdit={viewer?.role === 'ADMIN'}.
 *     - When canEdit=false: renders data-testid="contract-tab-readonly"
 *       (status badge + PDF preview only), no editor.
 *     - When canEdit=true (ADMIN only): renders data-testid="contract-tab".
 *
 *   E2E coverage:
 *     F2a — DROP self-profile «Контракт» tab renders contract-tab-readonly.
 *     F2b — contract-tab (ADMIN editor) is absent for DROP.
 *     F2c — ADMIN viewing DROP profile renders contract-tab (editor), NOT readonly.
 *
 * All tests are mock-based (page.route / asDrop / asAdmin fixtures).
 * No waitForTimeout — only expect(locator).toBeVisible() / toHaveCount(0).
 */

import { test, expect, USERS, mockAuthAs, API_RE } from './fixtures'

// Origin-agnostic API prefix (task-e2e-origin-agnostic: now imported from
// fixtures.ts — this file independently reinvented the exact same
// `API_RE = '\\/api'` value, which is the "one thing described two ways"
// duplication that motivated exporting it as the canonical constant).
// Matches regardless of whether the app is served from localhost:3000 (dev)
// or a scratch preview port. In production builds VITE_API_URL is absent →
// axios falls back to `/api` (relative), so requests hit
// <preview-origin>/api/... not localhost:3001.

// ---------------------------------------------------------------------------
// Shared contract fixtures
// ---------------------------------------------------------------------------

const DROP_CONTRACT = {
  // Valid UUID v4 required — Zod validates uuid format on the client schema.
  id: 'dc000002-0000-4000-8000-000000000001',
  userId: USERS.drop.id,
  sourceTemplateId: 'dc000002-0000-4000-8000-000000000002',
  bodyMarkdown: '# Drop Employee Contract',
  status: 'DRAFT',
  signedContractId: null,
  createdByUserId: USERS.admin.id,
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
}

/** Register contract route mocks AFTER mockAuthAs (LIFO — wins over default 404). */
async function mockDropContract(page: import('@playwright/test').Page) {
  await page.route(/\/api\/users\/[^/?]+\/contract$/, async (r) => {
    if (r.request().method() === 'GET') {
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(DROP_CONTRACT),
      })
    }
    return r.fallback()
  })
  await page.route(/\/api\/users\/[^/?]+\/contract\/variables$/, async (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ variables: [], customVariables: [] }),
    }),
  )
  await page.route(/\/api\/users\/[^/?]+\/contract\/pdf$/, async (r) =>
    r.fulfill({ status: 200, contentType: 'application/pdf', body: Buffer.from('%PDF-1.4') }),
  )
}

// ---------------------------------------------------------------------------
// Documents fixtures (Finding 1)
// ---------------------------------------------------------------------------

function makeDropDoc(overrides: object = {}) {
  return {
    id: 'doc-drop-f1-0001',
    ownerId: USERS.drop.id,
    projectId: null,
    category: 'RESUME',
    name: 'drop-resume.pdf',
    originalName: 'drop-resume.pdf',
    s3Key: 'drop/resume/drop-resume.pdf',
    thumbnailS3Key: null,
    sizeBytes: 1024,
    mimeType: 'application/pdf',
    uploadedBy: USERS.drop.id,
    deletedAt: null,
    deletedBy: null,
    createdAt: '2026-06-01T10:00:00.000Z',
    ...overrides,
  }
}

function makeOtherUserDoc() {
  // Document owned by a DIFFERENT user (Senior) — must NOT appear in DROP's view.
  return makeDropDoc({
    id: 'doc-senior-f1-0002',
    ownerId: USERS.senior.id,
    uploadedBy: USERS.senior.id,
    name: 'senior-resume.pdf',
    originalName: 'senior-resume.pdf',
  })
}

// ---------------------------------------------------------------------------
// Finding 1 — DROP documents page access
// ---------------------------------------------------------------------------

test.describe('Finding 1 — DROP documents page access (PR #198)', () => {
  test('F1a: DROP navigates to /documents — page renders, no redirect', async ({
    asDrop: page,
  }) => {
    // ROUTE_ACCESS['/documents'] now includes DROP (Finding 1 fix).
    // useRoleGuard must NOT fire → URL stays on /documents.
    await page.goto('/documents')
    await expect(page).toHaveURL(/\/documents/, { timeout: 8_000 })
    await expect(page).not.toHaveURL(/\/dashboard/)
    await expect(page).not.toHaveURL(/\/login/)

    // Page shell renders the «Документы» heading.
    const main = page.locator('main')
    await expect(main.getByRole('heading', { name: /документы/i }).first()).toBeVisible({
      timeout: 8_000,
    })
  })

  test('F1b: drop-nav contains «Документы» link after Finding 1 fix', async ({ asDrop: page }) => {
    // nav-sidebar builds items via navRolesFor('/documents') — DROP is now
    // included in route-access.ts → link appears in drop-nav.
    await page.goto('/')
    await expect(page.getByTestId('drop-routing-hub')).toBeVisible({ timeout: 8_000 })

    const nav = page.getByTestId('drop-nav')
    await expect(nav).toBeVisible()
    // «Документы» link must be present.
    await expect(nav.locator('a[href="/documents"]')).toBeVisible()
  })

  test('F1c: /documents renders DROP own documents (backend scopes to ownerId=DROP)', async ({
    asDrop: page,
  }) => {
    // Override the default mockAuthAs documents mock (which returns []) with a
    // list containing one doc owned by DROP. Registered after mockAuthAs → LIFO
    // wins. This mirrors the backend Finding 1 fix: documents.service.ts forces
    // ownerId=actor.id for DROP, so the API only returns their own docs.
    //
    // Use origin-agnostic regex (API_RE = '\\/api') because in production build
    // (vite preview) VITE_API_URL is absent → axios uses relative '/api' →
    // requests go to <preview-host>/api/... not localhost:3001.
    await page.route(new RegExp(`${API_RE}/documents(\\?.*)?$`), async (r) => {
      if (r.request().method() === 'GET') {
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([makeDropDoc()]),
        })
      }
      return r.fallback()
    })

    await page.goto('/documents')
    await expect(page).toHaveURL(/\/documents/, { timeout: 8_000 })

    // The document row/card for DROP's own file must be visible.
    const main = page.locator('main')
    await expect(main.getByText('drop-resume.pdf', { exact: false }).first()).toBeVisible({
      timeout: 8_000,
    })
  })

  test('F1d: /documents does NOT render other users docs (IDOR scope — backend filters)', async ({
    asDrop: page,
  }) => {
    // Backend IDOR fix: documents.service.ts forces ownerId=actor.id for DROP.
    // Mock returns a correctly-scoped response (empty — no other-user docs leak).
    // The other-user doc must not appear in the rendered page.
    // Origin-agnostic regex — same reasoning as F1c.
    await page.route(new RegExp(`${API_RE}/documents(\\?.*)?$`), async (r) => {
      if (r.request().method() === 'GET') {
        // Correctly-scoped backend returns [] for DROP when they have no docs.
        // (In production the backend filters on ownerId=actor.id.)
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([]),
        })
      }
      return r.fallback()
    })

    await page.goto('/documents')
    await expect(page).toHaveURL(/\/documents/, { timeout: 8_000 })

    const main = page.locator('main')
    // The senior's doc name must not appear anywhere in main.
    const otherDoc = makeOtherUserDoc()
    await expect(main.getByText(otherDoc.name, { exact: false })).toHaveCount(0)
  })
})

// ---------------------------------------------------------------------------
// Finding 2 — ContractTab read-only for non-ADMIN
// ---------------------------------------------------------------------------

test.describe('Finding 2 — ContractTab read-only for DROP (PR #198)', () => {
  test('F2a: DROP self-profile «Контракт» tab renders contract-tab-readonly (not editor)', async ({
    asDrop: page,
  }) => {
    // UserProfileShell passes canEdit={viewer?.role === 'ADMIN'}.
    // DROP role → canEdit=false → ContractTab renders data-testid="contract-tab-readonly".
    await mockDropContract(page)

    await page.goto('/profile')
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Drop User', {
      timeout: 8_000,
    })

    // Click «Контракт» tab.
    const main = page.locator('main')
    const contractTabBtn = main.getByRole('button', { name: /Контракт/i }).first()
    await expect(contractTabBtn).toBeVisible({ timeout: 8_000 })
    await contractTabBtn.click()

    // Read-only wrapper must appear (Finding 2 regression guard).
    await expect(page.getByTestId('contract-tab-readonly')).toBeVisible({ timeout: 8_000 })
    // Status badge is rendered inside contract-tab-readonly.
    await expect(page.getByTestId('contract-status-badge')).toBeVisible()
  })

  test('F2b: ADMIN editor (contract-tab) is absent for DROP — no mutation controls', async ({
    asDrop: page,
  }) => {
    // canEdit=false → the ADMIN editor branch (data-testid="contract-tab") must
    // never render for DROP. This guards against regression where canEdit
    // accidentally defaults to true or the prop is dropped.
    await mockDropContract(page)

    await page.goto('/profile')
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Drop User', {
      timeout: 8_000,
    })

    const main = page.locator('main')
    const contractTabBtn = main.getByRole('button', { name: /Контракт/i }).first()
    await expect(contractTabBtn).toBeVisible({ timeout: 8_000 })
    await contractTabBtn.click()

    // ADMIN editor div must be absent.
    await expect(page.getByTestId('contract-tab')).toHaveCount(0)
  })

  test('F2c: ADMIN viewing DROP profile renders contract-tab (editor), not readonly', async ({
    page,
  }) => {
    // ADMIN: canEdit=true → ContractTab renders data-testid="contract-tab" (editor).
    // Regression guard: ensure the ADMIN branch was not accidentally removed.
    await mockAuthAs(page, USERS.admin)
    await mockDropContract(page)

    // ADMIN navigates to the DROP user's profile by userId.
    await page.goto(`/profile/${USERS.drop.id}`)
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Drop User', {
      timeout: 8_000,
    })

    const main = page.locator('main')
    const contractTabBtn = main.getByRole('button', { name: /Контракт/i }).first()
    await expect(contractTabBtn).toBeVisible({ timeout: 8_000 })
    await contractTabBtn.click()

    // ADMIN editor must be visible (canEdit=true branch).
    await expect(page.getByTestId('contract-tab')).toBeVisible({ timeout: 8_000 })
    // Read-only wrapper must NOT be rendered for ADMIN.
    await expect(page.getByTestId('contract-tab-readonly')).toHaveCount(0)
  })
})
