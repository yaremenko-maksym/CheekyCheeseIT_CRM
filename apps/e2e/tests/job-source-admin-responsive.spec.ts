import type { Page } from '@playwright/test'
import { test, expect, USERS, mockAuthAs, API_GLOB } from './fixtures'

/**
 * U7 source-fetch-strategy — ADMIN source page, AC3: the page renders at the four
 * responsive breakpoints (320 / 768 / 1024 / 1440) with no horizontal overflow.
 *
 * Mock-based (no backend): the two admin endpoints are fulfilled with fixtures.
 * Routes are registered AFTER mockAuthAs so they win (Playwright runs the
 * most recently registered matching handler first).
 */

const SOURCE_ID = '11111111-1111-4111-8111-111111111111'
const SECOND_ID = '22222222-2222-4222-8222-222222222222'
const NOW = Date.now()
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString()

const PROFILE = {
  intervalMinutes: 60,
  offIntervalMinutes: 360,
  window: {
    timeZone: 'Europe/Kyiv',
    days: ['MON', 'TUE', 'WED', 'THU', 'FRI'],
    from: '09:00',
    to: '18:00',
  },
  fixedSlotTimes: null,
  floorHours: 1,
}

const ROW = {
  id: SOURCE_ID,
  type: 'DOU_RSS',
  enabled: true,
  state: 'DEGRADED',
  reasonCode: 'VOLUME_DROP',
  lastCollectedAt: iso(30),
  newestItemPublishedAt: iso(300),
  profileSummary: PROFILE,
}

const HEALTH = {
  items: [
    ROW,
    {
      ...ROW,
      id: SECOND_ID,
      type: 'REMOTEOK_API',
      state: 'HEALTHY',
      reasonCode: null,
      profileSummary: null,
    },
  ],
}

const DETAIL = {
  source: ROW,
  runs: [
    {
      id: '33333333-3333-4333-8333-333333333333',
      startedAt: iso(30),
      endedAt: iso(29),
      outcome: 'SUCCEEDED',
      received: 40,
      created: 5,
      invalid: 0,
      requestCount: 2,
      bytesRead: 123456,
      lastHttpStatus: 200,
      newestItemPublishedAt: iso(300),
      adapterVersion: 'dou-rss@3',
      configVersion: 2,
    },
  ],
  events: [
    {
      id: '44444444-4444-4444-8444-444444444444',
      at: iso(45),
      kind: 'TRANSITION',
      fromState: 'HEALTHY',
      toState: 'DEGRADED',
      reasonCode: 'VOLUME_DROP',
      adapterVersion: 'dou-rss@3',
      configVersion: 2,
      httpStatus: 200,
      errorSample: null,
      actorName: null,
      note: null,
      correlation: 'NO_CHANGE',
    },
    {
      id: '55555555-5555-4555-8555-555555555555',
      at: iso(20),
      kind: 'NOTE',
      fromState: null,
      toState: null,
      reasonCode: null,
      adapterVersion: null,
      configVersion: null,
      httpStatus: null,
      errorSample: null,
      actorName: USERS.admin.displayName,
      note:
        'Provider announced a feed change; a very long unbroken token follows to stress wrapping: ' +
        'x'.repeat(120),
      correlation: null,
    },
  ],
}

async function mockSourceApis(page: Page) {
  await page.route(`${API_GLOB}/job-sourcing/admin/sources/health`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(HEALTH) }),
  )
  await page.route(`${API_GLOB}/job-sourcing/admin/sources/${SOURCE_ID}`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DETAIL) }),
  )
}

const BREAKPOINTS = [
  { name: 'mobile 320', width: 320, height: 640 },
  { name: 'tablet 768', width: 768, height: 1024 },
  { name: 'laptop 1024', width: 1024, height: 768 },
  { name: 'large 1440', width: 1440, height: 900 },
] as const

async function expectNoHorizontalOverflow(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const el = document.scrollingElement ?? document.documentElement
        return el.scrollWidth - window.innerWidth
      }),
    )
    .toBeLessThanOrEqual(0)
}

for (const bp of BREAKPOINTS) {
  test.describe(`U7 source page — ${bp.name}`, () => {
    test.use({ viewport: { width: bp.width, height: bp.height } })

    test('list: rows with state badge + freshness render without overflow', async ({ page }) => {
      await mockAuthAs(page, USERS.admin)
      await mockSourceApis(page)
      await page.goto('/admin/sources')

      const list = page.getByTestId('job-source-admin-list')
      await expect(list).toBeVisible()
      const rows = list.getByTestId('job-source-health-row')
      await expect(rows).toHaveCount(2)
      await expect(rows.first()).toBeVisible()
      await expect(rows.nth(1)).toBeVisible()
      await expect(rows.first()).toHaveAttribute('data-source-type', 'DOU_RSS')
      await expect(rows.first()).toHaveAttribute('data-state', 'DEGRADED')
      await expect(rows.nth(1)).toHaveAttribute('data-state', 'HEALTHY')
      await expectNoHorizontalOverflow(page)
    })

    test('detail: header, event log, run timeline and note form render without overflow', async ({
      page,
    }) => {
      await mockAuthAs(page, USERS.admin)
      await mockSourceApis(page)
      await page.goto(`/admin/sources/${SOURCE_ID}`)

      const detail = page.getByTestId('job-source-detail')
      await expect(detail).toBeVisible()
      await expect(detail.getByTestId('job-source-detail-error')).toHaveCount(0)
      await expect(detail.getByRole('heading', { level: 2, name: 'DOU_RSS' })).toBeVisible()
      await expect(detail.getByTestId('back-button')).toBeVisible()
      await expect(detail.getByTestId('job-source-event-row')).toHaveCount(2)
      await expect(detail.getByTestId('job-source-event-row').last()).toBeVisible()
      await expect(detail.getByTestId('job-source-run-row')).toHaveCount(1)
      await expect(detail.getByTestId('job-source-run-row')).toBeVisible()

      const form = detail.getByTestId('job-source-note-form')
      await expect(form).toBeVisible()
      await expect(form.getByRole('textbox')).toBeVisible()
      await expect(form.getByRole('button', { name: /.+/ })).toBeVisible()
      await expectNoHorizontalOverflow(page)
    })
  })
}

test.describe('U7 source page — RBAC', () => {
  test('non-ADMIN (SENIOR) does not see the source list', async ({ page }) => {
    await mockAuthAs(page, USERS.senior)
    await mockSourceApis(page)
    await page.goto('/admin/sources')
    await expect(page.getByTestId('job-source-admin-list')).toHaveCount(0)
  })
})
