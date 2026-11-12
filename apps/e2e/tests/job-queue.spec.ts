import type { Page } from '@playwright/test'
import { test, expect, loginViaApi, REAL_API_BASE, SEED_EMAILS } from './fixtures'
import { loadMessages, assertInCatalog } from '../fixtures/catalog'
import {
  MOCK_IDS,
  apiError,
  serverFailure,
  card,
  cardSenior,
  listItem,
  listResponse,
  mockJobQueue,
} from '../fixtures/job-queue'

/**
 * Vacancy queue `/job-queue` — Task 7.6 (spec `docs/design/vacancy-queue.md`, testids §14).
 *
 * Wave 1: scenarios 7, 8, 9, 13 on MOCKED queue responses (rendering only; every mock is
 * `.parse()`d against the `@crm/shared` job-queue schemas in `../fixtures/job-queue`), and
 * scenario 11 on the REAL API with a real dev-login. Wave 2 (real API: 1-6, 10, 12) adds its own
 * `test.describe` blocks to this file.
 *
 * A mocked spec proves what the UI draws for a given response, never what the server returns.
 */

const OPP = MOCK_IDS.opportunity

async function openCard(page: Page) {
  await page.goto('/job-queue')
  await page.getByTestId(`job-queue-row-${OPP}`).click()
  await expect(page.getByTestId('job-queue-card')).toBeVisible()
}

// ---------------------------------------------------------------------------
// Scenario 7 — card states: stale, closed while open, approximate, triage, zero-match
// ---------------------------------------------------------------------------
test.describe('scenario 7 — card states (mocked)', () => {
  test('7a: a submit that meets a newer revision shows the stale note and blocks submits', async ({
    asHr: page,
  }) => {
    const uk = await loadMessages('uk')
    await mockJobQueue(page, {
      card: [card({ revision: 1 }), card({ revision: 2 })],
      submit: [{ status: 409, body: apiError(409, 'JOB_QUEUE_VERSION_CONFLICT') }],
    })
    await openCard(page)
    const submit = page.getByTestId(`job-queue-submit-${MOCK_IDS.seniorA}`)
    await expect(submit).toBeEnabled()

    await submit.click()

    const stale = page.getByTestId('job-queue-stale')
    await expect(stale).toBeVisible()
    await expect(submit).toBeDisabled()
    // «Оновити картку» accepts the newer revision: the note goes and submits are allowed again
    await stale.getByRole('button', { name: assertInCatalog(uk, 'Оновити картку') }).click()
    await expect(stale).toBeHidden()
    await expect(submit).toBeEnabled()
  })

  test('7b: the vacancy closes at the source while the card is open: closed note, submits disabled', async ({
    asHr: page,
  }) => {
    const uk = await loadMessages('uk')
    await mockJobQueue(page, {
      card: [card(), card({ availability: 'CLOSED' })],
      submit: [{ status: 409, body: apiError(409, 'JOB_QUEUE_VERSION_CONFLICT') }],
    })
    await openCard(page)
    await expect(page.getByTestId('job-queue-closed')).toBeHidden()

    // the conflict invalidates the card; the refetch reports the source closed it
    await page.getByTestId(`job-queue-submit-${MOCK_IDS.seniorA}`).click()

    const closed = page.getByTestId('job-queue-closed')
    await expect(closed).toBeVisible()
    await expect(closed).toContainText(assertInCatalog(uk, 'Вакансію закрито на джерелі'))
    await expect(page.getByTestId(`job-queue-submit-${MOCK_IDS.seniorA}`)).toBeDisabled()
    await expect(page.getByTestId('job-queue-card-closed')).toBeVisible()
  })

  test('7c: an approximate match is flagged on the senior row', async ({ asHr: page }) => {
    const uk = await loadMessages('uk')
    await mockJobQueue(page, {
      card: [
        card({}, [
          cardSenior({ matchApproximate: true }),
          cardSenior({ seniorId: MOCK_IDS.seniorB, displayName: 'Senior Beta' }),
        ]),
      ],
    })
    await openCard(page)
    const flag = assertInCatalog(uk, 'Збіг неточний')
    await expect(page.getByTestId(`job-queue-senior-${MOCK_IDS.seniorA}`)).toContainText(flag)
    await expect(page.getByTestId(`job-queue-senior-${MOCK_IDS.seniorB}`)).not.toContainText(flag)
  })

  test('7d: a triage vacancy shows the triage badge + reason on the row and the triage empty state', async ({
    asHr: page,
  }) => {
    const triage = { eligibility: 'TRIAGE' as const, matchedSeniorCount: 0, matchedKeywords: [] }
    await mockJobQueue(page, {
      list: [listResponse([listItem(triage)])],
      card: [card({ ...triage, noMatchReason: 'TRIAGE' }, [])],
    })
    await page.goto('/job-queue')
    const row = page.getByTestId(`job-queue-row-${OPP}`)
    await expect(row.getByTestId('job-queue-row-triage')).toBeVisible()
    await expect(row.getByTestId('job-queue-row-triage-reason')).toBeVisible()

    await row.click()
    await expect(page.getByTestId('job-queue-seniors-triage')).toBeVisible()
    await expect(page.getByTestId('job-queue-seniors').getByRole('button')).toHaveCount(0)
  })

  test('7e: an OPEN lead with zero matching seniors shows the no-match empty state', async ({
    asHr: page,
  }) => {
    await mockJobQueue(page, {
      list: [listResponse([listItem({ matchedSeniorCount: 0, matchedKeywords: [] })])],
      card: [card({ matchedSeniorCount: 0, matchedKeywords: [], noMatchReason: 'NO_MATCH' }, [])],
    })
    await openCard(page)
    await expect(page.getByTestId('job-queue-seniors-none')).toBeVisible()
    await expect(page.getByTestId('job-queue-seniors-triage')).toBeHidden()
  })
})

// ---------------------------------------------------------------------------
// Scenario 8 — the posting description is untrusted markdown (§5.1)
// ---------------------------------------------------------------------------
test.describe('scenario 8 — hostile description markdown (mocked)', () => {
  test('8: script, javascript: links, raw HTML and remote images never execute or load', async ({
    asHr: page,
  }) => {
    const TRACKER = 'tracker.e2e-hostile.example'
    const hostile = [
      'Intro **bold** line.',
      '<script>window.__xss = 1</script>',
      '<img src="https://tracker.e2e-hostile.example/raw.png" onerror="window.__xss = 2">',
      '![pixel](https://tracker.e2e-hostile.example/md.png)',
      '[click me](javascript:window.__xss=3)',
      '[safe link](https://example.com/apply)',
    ].join('\n\n')
    await mockJobQueue(page, { card: [card({ descriptionMd: hostile })] })
    const remote: string[] = []
    page.on('request', (req) => {
      if (req.url().includes(TRACKER)) remote.push(req.url())
    })
    let dialogs = 0
    page.on('dialog', (d) => {
      dialogs += 1
      void d.dismiss()
    })

    await openCard(page)

    const body = page.getByTestId('job-queue-card-description')
    await expect(body).toContainText('Intro')
    await expect(body.locator('script')).toHaveCount(0)
    await expect(body.locator('img')).toHaveCount(0)
    await expect(body.locator('a[href^="javascript:" i]')).toHaveCount(0)
    await expect(body.locator('[onerror]')).toHaveCount(0)
    // the https link survives, hardened for a new tab
    const safe = body.locator('a[href="https://example.com/apply"]')
    await expect(safe).toHaveAttribute('rel', /noopener/)
    // raw HTML stays text, it is never parsed into elements
    await expect(body).toContainText('<script>')
    expect(await page.evaluate(() => (window as { __xss?: number }).__xss)).toBeUndefined()
    expect(dialogs).toBe(0)
    expect(remote).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Scenario 9 — list states: refresh-required, empty, error + retry, loading, partial
// ---------------------------------------------------------------------------
test.describe('scenario 9 — list states (mocked)', () => {
  test('9a: a stale generation asks to refresh; the button loads a fresh list', async ({
    asHr: page,
  }) => {
    const uk = await loadMessages('uk')
    const gone = { status: 409, body: apiError(409, 'JOB_QUEUE_REFRESH_REQUIRED') }
    // the query retries once on its own, so the first two answers are the stale generation
    await mockJobQueue(page, { list: [gone, gone, listResponse([listItem()])] })
    await page.goto('/job-queue')
    const notice = page.getByTestId('job-queue-refresh')
    await expect(notice).toBeVisible()

    await notice
      .getByRole('button', { name: assertInCatalog(uk, 'Показати оновлений список') })
      .click()

    await expect(page.getByTestId(`job-queue-row-${OPP}`)).toBeVisible()
    await expect(notice).toBeHidden()
  })

  test('9b: an empty queue shows the empty state, not the filtered-empty one', async ({
    asHr: page,
  }) => {
    await mockJobQueue(page, { list: [listResponse([])] })
    await page.goto('/job-queue')
    await expect(page.getByTestId('job-queue-empty')).toBeVisible()
    await expect(page.getByTestId('job-queue-filtered-empty')).toBeHidden()
    await expect(page.getByTestId('job-queue-list')).toBeHidden()
  })

  test('9c: a failed load shows the error state; retry loads the list', async ({ asHr: page }) => {
    const uk = await loadMessages('uk')
    const down = { status: 500, body: serverFailure(500) }
    // the query retries once on its own, so the first two answers are the failure
    await mockJobQueue(page, { list: [down, down, listResponse([listItem()])] })
    await page.goto('/job-queue')
    const error = page.getByTestId('job-queue-error')
    await expect(error).toBeVisible()

    await error.getByRole('button', { name: assertInCatalog(uk, 'Спробувати ще раз') }).click()

    await expect(page.getByTestId(`job-queue-row-${OPP}`)).toBeVisible()
    await expect(error).toBeHidden()
  })

  test('9d: a slow first page shows the busy skeleton, then the list', async ({ asHr: page }) => {
    await mockJobQueue(page, {
      list: [{ status: 200, body: listResponse([listItem()]), delayMs: 1500 }],
    })
    await page.goto('/job-queue')
    const loading = page.getByTestId('job-queue-loading')
    await expect(loading).toBeVisible()
    await expect(loading).toHaveAttribute('aria-busy', 'true')
    await expect(page.getByTestId(`job-queue-row-${OPP}`)).toBeVisible()
    await expect(loading).toBeHidden()
  })

  test('9e: a capped generation shows the partial-list notice above the list', async ({
    asHr: page,
  }) => {
    await mockJobQueue(page, {
      list: [
        listResponse([listItem()], {
          generation: {
            ruleVersion: 'rules-v1',
            evaluatedAt: '2026-11-10T09:00:00.000Z',
            capped: true,
          },
        }),
      ],
    })
    await page.goto('/job-queue')
    await expect(page.getByTestId('job-queue-partial')).toBeVisible()
    await expect(page.getByTestId(`job-queue-row-${OPP}`)).toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// Scenario 11 — RBAC on the real API: a SENIOR opening the URL directly is redirected
// ---------------------------------------------------------------------------
test.describe('scenario 11 — SENIOR direct URL (real API)', () => {
  test('11: a SENIOR is redirected away from /job-queue and the API refuses the read', async ({
    page,
  }) => {
    await loginViaApi(page, SEED_EMAILS.seniorA)

    await page.goto('/job-queue')

    await expect(page).toHaveURL((url) => url.pathname === '/')
    await expect(page.getByTestId('job-queue-page')).toBeHidden()
    // the redirect is the UI; the backend guard is what actually protects the data
    const res = await page.request.get(`${REAL_API_BASE}/api/job-queue`)
    expect(res.status()).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// Scenario 13 — mobile (375 px): no horizontal scroll, full-screen card, 44 px targets,
// «Відкрити оригінал» opens inside the click gesture
// ---------------------------------------------------------------------------
type OpenCall = { url: string; inGesture: boolean }

/** Brackets each click dispatch (see job-sourcing-mobile.spec.ts for why this, not a popup wait). */
async function instrumentWindowOpen(page: Page) {
  await page.addInitScript(() => {
    const calls: { url: string; inGesture: boolean }[] = []
    ;(window as unknown as { __openCalls: typeof calls }).__openCalls = calls
    let inGesture = false
    document.addEventListener('click', () => (inGesture = true), true)
    window.addEventListener('click', () => (inGesture = false))
    window.open = ((url?: string | URL) => {
      calls.push({ url: String(url ?? ''), inGesture })
      return null
    }) as typeof window.open
  })
}

async function expectMinTarget(page: Page, testId: string) {
  const box = await page.getByTestId(testId).first().boundingBox()
  expect(box, testId).not.toBeNull()
  expect(box!.height, `${testId} height`).toBeGreaterThanOrEqual(44)
}

test.describe('scenario 13 — mobile 375 px (mocked)', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true })

  test('13: no horizontal scroll, full-screen card, 44 px targets, gesture-safe open', async ({
    asHr: page,
  }) => {
    const uk = await loadMessages('uk')
    await instrumentWindowOpen(page)
    await mockJobQueue(page)
    await page.goto('/job-queue')
    await expect(page.getByTestId(`job-queue-row-${OPP}`)).toBeVisible()

    const noHorizontalScroll = () =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      )
    expect(await noHorizontalScroll()).toBe(true)
    await expectMinTarget(page, `job-queue-row-${OPP}`)
    await expectMinTarget(page, 'job-queue-tab-NEW')

    await page.getByTestId(`job-queue-row-${OPP}`).click()
    const cardPanel = page.getByTestId('job-queue-card')
    await expect(cardPanel).toBeVisible()
    const box = await cardPanel.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.x).toBeLessThanOrEqual(0)
    expect(box!.width).toBeGreaterThanOrEqual(375)
    expect(box!.height).toBeGreaterThanOrEqual(812 - 1)
    expect(await noHorizontalScroll()).toBe(true)
    await expectMinTarget(page, `job-queue-submit-${MOCK_IDS.seniorA}`)

    await page
      .getByTestId('job-queue-card-footer')
      .getByRole('button', { name: assertInCatalog(uk, 'Відкрити оригінал') })
      .click()
    const calls = await page.evaluate(
      () => (window as unknown as { __openCalls: OpenCall[] }).__openCalls,
    )
    // exactly one call, to the original, issued inside the click dispatch
    expect(calls).toEqual([{ url: card().primarySource!.url, inGesture: true }])
  })
})
