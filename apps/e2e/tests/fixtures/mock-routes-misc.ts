import type { Page } from '@playwright/test'
import { type MockUser } from './mock-data'
import { API_GLOB, API_RE, jsonOk, noContent } from './route-helpers'

export async function mockMiscRoutes(page: Page, user: MockUser) {
  // Onboarding (Phase 6B) — default: fully onboarded, no wizard redirect.
  // Tests that need unboarded state call mockOnboardingApi() AFTER mockAuthAs();
  // Playwright's LIFO route-handler stack ensures the later registration wins.
  await page.route(`${API_GLOB}/onboarding/status`, (r) =>
    jsonOk(r, {
      requiresContract: false,
      requiresTos: false,
      contractTemplate: null,
      tosVersion: null,
      tosUpdateAvailable: false,
      latestTosVersion: null,
    }),
  )

  // Documents (PHASE 6) — register specific sub-routes before the generic one.
  // navigation.spec.ts and others click sidebar → /documents which mounts
  // DocumentsPage → useDocuments() → GET /documents. Without these mocks the
  // request hits the real backend → 401 → axios interceptor → location.href =
  // '/login' → user gets logged out mid-navigation (root cause for PR #48 fails).
  await page.route(new RegExp(`${API_RE}/documents/([^/?]+)/download$`), (r) =>
    jsonOk(r, {
      url: 'http://localhost:9000/crm-documents/mock-download',
      expiresAt: '2099-01-01T00:00:00.000Z',
    }),
  )
  await page.route(new RegExp(`${API_RE}/documents/([^/?]+)/thumbnail$`), (r) => jsonOk(r, null))
  await page.route(new RegExp(`${API_RE}/documents/([^/?]+)/restore$`), (r) =>
    jsonOk(r, {
      id: r.request().url().split('/').slice(-2, -1)[0],
      ownerId: user.id,
      projectId: null,
      category: 'RESUME',
      name: 'restored.pdf',
      originalName: 'restored.pdf',
      s3Key: 'mock-key',
      thumbnailS3Key: null,
      sizeBytes: 1024,
      mimeType: 'application/pdf',
      uploadedBy: user.id,
      deletedAt: null,
      deletedBy: null,
      createdAt: '2026-05-01T10:00:00.000Z',
    }),
  )
  await page.route(new RegExp(`${API_RE}/documents/([^/?]+)/hard$`), (r) => noContent(r))
  await page.route(new RegExp(`${API_RE}/documents/([^/?]+)$`), (r) =>
    r.request().method() === 'DELETE'
      ? noContent(r)
      : jsonOk(r, {
          id: r.request().url().split('/').at(-1),
          ownerId: user.id,
          projectId: null,
          category: 'RESUME',
          name: 'mock.pdf',
          originalName: 'mock.pdf',
          s3Key: 'mock-key',
          thumbnailS3Key: null,
          sizeBytes: 1024,
          mimeType: 'application/pdf',
          uploadedBy: user.id,
          deletedAt: null,
          deletedBy: null,
          createdAt: '2026-05-01T10:00:00.000Z',
        }),
  )
  await page.route(new RegExp(`${API_RE}/documents(\\?.*)?$`), (r) =>
    r.request().method() === 'POST'
      ? jsonOk(
          r,
          {
            id: 'doc-new',
            ownerId: user.id,
            projectId: null,
            category: 'RESUME',
            name: 'uploaded.pdf',
            originalName: 'uploaded.pdf',
            s3Key: 'mock-key-new',
            thumbnailS3Key: null,
            sizeBytes: 2048,
            mimeType: 'application/pdf',
            uploadedBy: user.id,
            deletedAt: null,
            deletedBy: null,
            createdAt: '2026-05-01T10:00:00.000Z',
          },
          201,
        )
      : jsonOk(r, []),
  )

  // Employee contracts (A3-2) — guard against ContractFillForm firing
  // GET /contract/variables which hits the real backend → 401 → axios
  // interceptor → window.location = '/login' on any test that opens a
  // profile page with the contract tab mounted.
  // Sub-routes must be registered BEFORE the generic /contract$ pattern so
  // they match first (Playwright uses LIFO within a registration sequence;
  // later-registered routes take priority over earlier ones).
  await page.route(new RegExp(`${API_RE}/users/([^/?]+)/contract/variables$`), (r) =>
    jsonOk(r, { variables: [], customVariables: [] }),
  )
  await page.route(new RegExp(`${API_RE}/users/([^/?]+)/contract/custom-values$`), (r) =>
    r.request().method() === 'PATCH' ? jsonOk(r, {}) : r.fallback(),
  )
  await page.route(new RegExp(`${API_RE}/users/([^/?]+)/contract/pdf$`), (r) =>
    r.fulfill({ status: 200, contentType: 'application/pdf', body: Buffer.from('%PDF-1.4') }),
  )
  await page.route(new RegExp(`${API_RE}/users/([^/?]+)/contract/(ready|revert|reset)$`), (r) =>
    r.fallback(),
  )
  await page.route(new RegExp(`${API_RE}/users/([^/?]+)/contract$`), (r) => {
    if (r.request().method() === 'GET') {
      // Default: 404 "no template" — tests that need a real contract
      // register their own handler AFTER mockAuthAs so it takes priority (LIFO).
      // task-i18n-stage2-task5: body is the API error envelope
      // (`apiErrorEnvelopeSchema`) — `WizardStep2`/`ContractTab` now branch
      // on `code`, not `message` substring matching.
      return r.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({
          statusCode: 404,
          code: 'CONTRACT_TEMPLATE_MISSING',
          params: { role: 'UNKNOWN' },
          message: 'No active contract template for role UNKNOWN',
        }),
      })
    }
    return r.fallback()
  })

  // Compliance audit trail (Phase 6 polish PR3)

  // task-junior-ux-2-hub: GET /contracts/me — JUNIOR hub uses this.
  // Default: 404 (no contract yet). Tests that need a SIGNED contract
  // register their own handler AFTER mockAuthAs (LIFO priority).
  await page.route(new RegExp(`${API_RE}/contracts/me$`), (r) => {
    if (r.request().method() !== 'GET') return r.fallback()
    return r.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'No contract found' }),
    })
  })

  // task-junior-ux-hub: GET /contracts/me/status — ContractStatusCard (JUNIOR hub).
  // Must be registered BEFORE the generic /contracts/me$ route so it matches first (LIFO).
  // Default: 404 "no contract". junior-hub.spec.ts overrides this after mockAuthAs for
  // SIGNED/READY_TO_SIGN scenarios. Without this mock the request hits the real backend
  // → 401 → axios interceptor → /login redirect → networkidle never settles
  // → navigation.spec.ts JUNIOR tests timeout at 30 000 ms.
  await page.route(new RegExp(`${API_RE}/contracts/me/status$`), (r) => {
    if (r.request().method() !== 'GET') return r.fallback()
    return r.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'No contract found' }),
    })
  })

  // task-junior-ux-hub: GET /users/me/salary-meta — SalarySnapshotCard (JUNIOR hub).
  // Default: null salary (role has no salary configured). junior-hub.spec.ts overrides
  // for the salary-populated scenarios. Without this mock same timeout failure as above.
  await page.route(new RegExp(`${API_RE}/users/me/salary-meta$`), (r) => {
    if (r.request().method() !== 'GET') return r.fallback()
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ monthlySalary: null, salaryCurrency: null, changedAt: null }),
    })
  })

  // Drop role - phase 2: DROP hub «Мой роутинг» + finance cabinet.
  //
  // GET /api/finance/drop/me/summary → DropSelfSummaryDto
  // GET /api/finance/drop/me/incomes → PaginatedDropIncomes
  // GET /api/finance/drop/me/payments → DropPaymentDto[]
  // GET /api/projects/drop/me → DropProjectDto[]
  //
  // Without these mocks the requests hit the real backend → 401 → axios
  // interceptor → window.location = '/login' — identical failure mode to the
  // JUNIOR hub mocks above. Defaults produce a minimal non-error state so the
  // hub renders its cards. Specs that need specific data register their own
  // handlers AFTER mockAuthAs (LIFO) so they take priority.
  await page.route(new RegExp(`${API_RE}/finance/drop/me/summary$`), (r) => {
    if (r.request().method() !== 'GET') return r.fallback()
    return jsonOk(r, {
      balance: 0,
      dropSharePercent: 5,
      pendingIncomesCount: 0,
      debtToCompany: 0,
      // task-drop-sees-own-obligations: dropSelfSummarySchema now REQUIRES
      // these two fields — omitting them fails the FE's Zod `.parse()`,
      // which silently error-states the whole hub/finance page (MED-3,
      // security-review PR #523 round 1: this exact gap broke
      // drop-share-usdt-gates.spec.ts via the missing `drop-add-income`
      // testid, downstream of this fixture, not of anything in that spec).
      pendingObligationAmount: 0,
      pendingObligationCount: 0,
    })
  })
  await page.route(new RegExp(`${API_RE}/finance/drop/me/incomes(\\?.*)?$`), (r) => {
    if (r.request().method() !== 'GET') return r.fallback()
    return jsonOk(r, { items: [], total: 0, page: 1, limit: 20 })
  })
  await page.route(new RegExp(`${API_RE}/finance/drop/me/payments$`), (r) => {
    if (r.request().method() !== 'GET') return r.fallback()
    return jsonOk(r, [])
  })
  await page.route(new RegExp(`${API_RE}/projects/drop/me$`), (r) => {
    if (r.request().method() !== 'GET') return r.fallback()
    return jsonOk(r, [])
  })
}
