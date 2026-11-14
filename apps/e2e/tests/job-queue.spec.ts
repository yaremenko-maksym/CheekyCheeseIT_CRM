import { randomUUID } from 'node:crypto'
import type { Browser, Page } from '@playwright/test'
import { test, expect, loginViaApi, REAL_API_BASE, SEED_EMAILS } from './fixtures'
import { loadMessages, assertInCatalog } from '../fixtures/catalog'
import { jobQueueTeamTriageGrantSchema } from '../../../packages/shared/src/schemas/job-sourcing'
import {
  MOCK_IDS,
  SEED_PEOPLE,
  SEED_QUEUE,
  SEED_TEAMS,
  apiError,
  serverFailure,
  cancelLiveSubmission,
  card,
  cardSenior,
  revokeLiveTriage,
  jobSource,
  listItem,
  listResponse,
  mockJobQueue,
  mockJobSources,
  queueCard,
  queueList,
  queueRow,
  revokeTriage,
  seniorNamed,
  teamIdByName,
  undoLiveDismissal,
  visibleTitles,
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
      // revision 2 exists only once the submit was sent: any refetch before the click still sees 1
      card: [card({ revision: 1 })],
      cardAfterSubmit: card({ revision: 2 }),
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
      card: [card()],
      cardAfterSubmit: card({ availability: 'CLOSED' }),
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
    // stale until the click, however many times the query retries or refetches before it
    const queue = await mockJobQueue(page, {
      list: [gone],
      listAfterRecover: listResponse([listItem()]),
    })
    await page.goto('/job-queue')
    const notice = page.getByTestId('job-queue-refresh')
    await expect(notice).toBeVisible()

    queue.recover()
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
    // down until the click, however many times the query retries or refetches before it
    const queue = await mockJobQueue(page, {
      list: [down],
      listAfterRecover: listResponse([listItem()]),
    })
    await page.goto('/job-queue')
    const error = page.getByTestId('job-queue-error')
    await expect(error).toBeVisible()

    queue.recover()
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

// ---------------------------------------------------------------------------
// Wave 2 — the REAL API on the Task 7.6a seed: scenarios 1-6, 10, 12
// ---------------------------------------------------------------------------
// Every row and person is found through the API by its seed title / display name. Every write a
// test makes (a submission, a hide, a triage grant) is undone through the API, before (a crashed
// earlier run) and after, so the suite stays green on a re-run against the same database. No
// test touches a senior's stack or a team's members: match versions are frozen at seed time.
test.describe('wave 2 — real API on the 7.6a seed', () => {
  // one database per shard: a write here would race a parallel worker's visibility read
  test.describe.configure({ mode: 'serial' })

  const ROW = (id: string) => `job-queue-row-${id}`
  // a row's own testid ends in its uuid; its parts (`job-queue-row-line`, …) share the prefix
  const ANY_ROW = /^job-queue-row-[0-9a-f]{8}-[0-9a-f-]{27}$/

  /** Runs `fn` as another seed user in a context of its own (its own cookie and cache). */
  async function asActor<T>(
    browser: Browser,
    email: string,
    fn: (page: Page) => Promise<T>,
  ): Promise<T> {
    const ctx = await browser.newContext()
    try {
      const page = await ctx.newPage()
      await loginViaApi(page, email)
      return await fn(page)
    } finally {
      await ctx.close()
    }
  }

  async function rowId(page: Page, title: string, scope: { teamId?: string } = {}) {
    const row = await queueRow(page.request, title, scope)
    if (!row) throw new Error(`"${title}" is not in this actor's «Нові» tab`)
    return row.opportunityId
  }

  test('1/5: each seeded actor is authorized for exactly its own vacancies (API)', async ({
    page,
  }) => {
    const Q = SEED_QUEUE
    const expected: [string, string[]][] = [
      [SEED_EMAILS.admin, Object.values(Q)],
      [SEED_EMAILS.hrA, [Q.reactPlatform, Q.unsafeDescription, Q.uncertainMatch]],
      [SEED_EMAILS.hrB, [Q.reactPlatform, Q.dataPipeline]],
      [SEED_EMAILS.hr3, [Q.reactPlatform]],
      [SEED_EMAILS.hr2, [Q.reactPlatform, Q.unsafeDescription, Q.uncertainMatch]],
      [SEED_EMAILS.hr0, []],
    ]
    for (const [email, titles] of expected) {
      await loginViaApi(page, email)
      // `visibleTitles` throws on any status but 200: the teamless HR is answered, not refused
      expect({ email, titles: await visibleTitles(page.request) }).toEqual({
        email,
        titles: [...titles].sort(),
      })
    }
  })

  test('1: HR opens the queue from the menu; the card shows its sources and own-team seniors', async ({
    page,
  }) => {
    const uk = await loadMessages('uk')
    await loginViaApi(page, SEED_EMAILS.hrA)
    const teamId = await teamIdByName(page.request, SEED_TEAMS.kovalenko)
    const id = await rowId(page, SEED_QUEUE.reactPlatform, { teamId })
    const api = await queueCard(page.request, id, { teamId })

    await page.goto('/')
    await page
      .getByRole('navigation', { name: assertInCatalog(uk, 'Основна навігація') })
      .getByRole('link', { name: assertInCatalog(uk, 'Черга зовнішніх вакансій') })
      .click()
    await expect(page).toHaveURL(/\/job-queue/)
    await expect(page.getByTestId(ANY_ROW)).toHaveCount(3)
    await page.getByTestId(ROW(id)).click()

    const cardEl = page.getByTestId('job-queue-card')
    await expect(cardEl).toBeVisible()
    // the seed links two sources: the primary opens the original, the other is «Також опубліковано»
    const others = api.sources.items.filter(
      (s) => s.sourceRecordId !== api.primarySource?.sourceRecordId,
    )
    expect(others).toHaveLength(1)
    for (const s of others) {
      await expect(cardEl.getByTestId(`job-queue-source-row-${s.sourceRecordId}`)).toBeVisible()
    }
    // own team's two matched seniors; Team Kravchenko's match on the same vacancy is never shown
    for (const name of [SEED_PEOPLE.oleksiy, SEED_PEOPLE.taras]) {
      await expect(
        cardEl.getByTestId(`job-queue-senior-${seniorNamed(api, name).seniorId}`),
      ).toContainText(name)
    }
    await expect(cardEl.getByTestId('job-queue-seniors')).not.toContainText(SEED_PEOPLE.artem)
  })

  test.describe('2-4: one submission, seen from three teams', () => {
    let teamId = ''
    let id = ''
    let taras = ''
    const clean = (browser: Browser) =>
      asActor(browser, SEED_EMAILS.hrA, (p) =>
        cancelLiveSubmission(p.request, id, SEED_PEOPLE.taras, { teamId }),
      )

    test.beforeAll(async ({ browser }) => {
      await asActor(browser, SEED_EMAILS.hrA, async (p) => {
        teamId = await teamIdByName(p.request, SEED_TEAMS.kovalenko)
        const row =
          (await queueRow(p.request, SEED_QUEUE.reactPlatform, { teamId })) ??
          (await queueRow(p.request, SEED_QUEUE.reactPlatform, { teamId, tab: 'SUBMITTED' }))
        if (!row) throw new Error('React Platform is not visible to Team Kovalenko')
        id = row.opportunityId
        taras = seniorNamed(await queueCard(p.request, id, { teamId }), SEED_PEOPLE.taras).seniorId
      })
      await clean(browser)
    })
    test.afterAll(async ({ browser }) => clean(browser))

    test('2: «Записати подачу» moves the vacancy from «Нові» to «Подані» for the team', async ({
      page,
    }) => {
      await loginViaApi(page, SEED_EMAILS.hrA)
      await page.goto(`/job-queue?teamId=${teamId}`)
      await page.getByTestId(ROW(id)).click()
      const submit = page.getByTestId(`job-queue-submit-${taras}`)
      await expect(submit).toBeEnabled()

      await submit.click()

      await expect(page.getByTestId(`job-queue-senior-submitted-${taras}`)).toContainText(
        SEED_PEOPLE.anna,
      )
      await page.goto(`/job-queue?teamId=${teamId}&tab=SUBMITTED`)
      await expect(page.getByTestId(ROW(id))).toBeVisible()
      await page.goto(`/job-queue?teamId=${teamId}&tab=NEW`)
      await expect(page.getByTestId(ANY_ROW).first()).toBeVisible()
      await expect(page.getByTestId(ROW(id))).toHaveCount(0)
    })

    test('3: a second HR of the same team sees «Подано» with the submitter name', async ({
      page,
    }) => {
      await loginViaApi(page, SEED_EMAILS.hr2)
      await page.goto(`/job-queue?teamId=${teamId}&tab=SUBMITTED`)
      await page.getByTestId(ROW(id)).click()
      await expect(page.getByTestId(`job-queue-senior-submitted-${taras}`)).toContainText(
        SEED_PEOPLE.anna,
      )
      await expect(page.getByTestId(`job-queue-submit-${taras}`)).toHaveCount(0)
    })

    test('4: another team sharing the senior sees a nameless «Подано»; a team without him sees nothing', async ({
      page,
      browser,
    }) => {
      const uk = await loadMessages('uk')
      // Team Marchenko shares Taras: it learns he is taken, never by whom
      await loginViaApi(page, SEED_EMAILS.hrB)
      expect(seniorNamed(await queueCard(page.request, id), SEED_PEOPLE.taras).submission).toEqual({
        submittedElsewhere: true,
      })
      await page.goto('/job-queue')
      await page.getByTestId(ROW(id)).click()
      const badge = page.getByTestId(`job-queue-senior-submitted-${taras}`)
      await expect(badge).toHaveText(assertInCatalog(uk, 'Подано'))
      await expect(badge).not.toContainText(SEED_PEOPLE.anna)
      await expect(page.getByTestId(`job-queue-submit-${taras}`)).toHaveCount(0)

      // Team Kravchenko matches only Artem: for it the vacancy is untouched
      await asActor(browser, SEED_EMAILS.hr3, async (p) => {
        const artem = seniorNamed(await queueCard(p.request, id), SEED_PEOPLE.artem)
        expect(artem.submission).toBeNull()
        await p.goto('/job-queue')
        await p.getByTestId(ROW(id)).click()
        await expect(p.getByTestId(`job-queue-submit-${artem.seniorId}`)).toBeEnabled()
        await expect(p.getByTestId(/^job-queue-senior-submitted-/)).toHaveCount(0)
      })
    })
  })

  test('5: an HR with no team gets an empty, authorized queue', async ({ page }) => {
    await loginViaApi(page, SEED_EMAILS.hr0)
    const list = await queueList(page.request)
    expect([list.items, list.counts]).toEqual([[], { NEW: 0, SUBMITTED: 0, HIDDEN: 0 }])

    await page.goto('/job-queue')
    await expect(page.getByTestId('job-queue-no-team')).toBeVisible()
    await expect(page.getByTestId(ANY_ROW)).toHaveCount(0)
  })

  test.describe('6: scoped hide and undo', () => {
    // every team sees React Platform, so a team-scoped hide can be checked from another team
    let teamId = ''
    let id = ''
    const clean = (browser: Browser) =>
      asActor(browser, SEED_EMAILS.hrA, (p) => undoLiveDismissal(p.request, id, { teamId }))

    test.beforeAll(async ({ browser }) => {
      await asActor(browser, SEED_EMAILS.hrA, async (p) => {
        teamId = await teamIdByName(p.request, SEED_TEAMS.kovalenko)
        const row =
          (await queueRow(p.request, SEED_QUEUE.reactPlatform, { teamId })) ??
          (await queueRow(p.request, SEED_QUEUE.reactPlatform, { teamId, tab: 'HIDDEN' }))
        if (!row) throw new Error('React Platform is not visible to Team Kovalenko')
        id = row.opportunityId
      })
      await clean(browser)
    })
    test.afterAll(async ({ browser }) => clean(browser))

    test('6: «Приховати» → «Скасувати» → reload → «Приховати» again succeeds', async ({
      page,
      browser,
    }) => {
      const uk = await loadMessages('uk')
      await loginViaApi(page, SEED_EMAILS.hrA)

      // a full navigation each time: the session forgets the dismissal version, so the second
      // hide must take it from the card's own `dismissal` (an undone row keeps its version)
      const hide = async () => {
        await page.goto(`/job-queue?teamId=${teamId}`)
        await page.getByTestId(ROW(id)).click()
        await page
          .getByTestId('job-queue-card-footer')
          .getByRole('button', { name: assertInCatalog(uk, 'Приховати') })
          .click()
        await page.getByRole('menuitem', { name: assertInCatalog(uk, 'Нерелевантна') }).click()
        const toast = page
          .locator('[data-sonner-toast]')
          .filter({ hasText: assertInCatalog(uk, 'Приховано') })
        await expect(toast).toBeVisible()
        await expect(page.getByTestId(ROW(id))).toHaveCount(0)
        return toast
      }

      const toast = await hide()
      await toast.getByRole('button', { name: assertInCatalog(uk, 'Скасувати') }).click()
      await expect(page.getByTestId(ROW(id))).toBeVisible()
      expect(await queueRow(page.request, SEED_QUEUE.reactPlatform, { teamId })).toBeDefined()

      await hide()
      expect(
        await queueRow(page.request, SEED_QUEUE.reactPlatform, { teamId, tab: 'HIDDEN' }),
      ).toBeDefined()

      // the hide is Team Kovalenko's: Team Marchenko still has the vacancy in «Нові», unhidden
      await asActor(browser, SEED_EMAILS.hrB, async (p) => {
        expect((await queueRow(p.request, SEED_QUEUE.reactPlatform))?.hidden).toBe(false)
        await p.goto('/job-queue')
        await expect(p.getByTestId(ROW(id))).toBeVisible()
      })
    })
  })

  test.describe('10: the queue cache does not outlive the account', () => {
    /** In-page script: records every queue row id the document renders from now on. */
    const watchRows = () => {
      const seen = new Set<string>()
      ;(window as unknown as { __queueRowsSeen: Set<string> }).__queueRowsSeen = seen
      new MutationObserver(() => {
        document.querySelectorAll('[data-testid^="job-queue-row-"]').forEach((el) => {
          const id = el.getAttribute('data-testid') ?? ''
          if (/^job-queue-row-[0-9a-f]{8}-[0-9a-f-]{27}$/.test(id)) seen.add(id)
        })
      }).observe(document, { childList: true, subtree: true })
    }
    const rowsSeen = (page: Page) =>
      page.evaluate(() => [
        ...(window as unknown as { __queueRowsSeen: Set<string> }).__queueRowsSeen,
      ])
    /**
     * The persisted TanStack cache (`lib/persister.ts`: idb-keyval's default store, one JSON
     * string) — its raw text and the first segment of every persisted query key.
     */
    const persisted = (page: Page) =>
      page.evaluate(
        () =>
          new Promise<{ raw: string; keys: string[] }>((resolve, reject) => {
            const open = indexedDB.open('keyval-store')
            open.onerror = () => reject(open.error)
            open.onsuccess = () => {
              const db = open.result
              if (!db.objectStoreNames.contains('keyval')) return resolve({ raw: '', keys: [] })
              const get = db.transaction('keyval').objectStore('keyval').get('crm-query-cache')
              get.onerror = () => reject(get.error)
              get.onsuccess = () => {
                const raw = typeof get.result === 'string' ? get.result : ''
                const client = (raw ? JSON.parse(raw) : {}) as {
                  clientState?: { queries?: { queryKey: unknown[] }[] }
                }
                const queries = client.clientState?.queries ?? []
                resolve({ raw, keys: queries.map((q) => String(q.queryKey[0])) })
              }
            }
          }),
      )
    const nav = async (page: Page, name: string) => {
      const uk = await loadMessages('uk')
      await page
        .getByRole('navigation', { name: assertInCatalog(uk, 'Основна навігація') })
        .getByRole('link', { name: assertInCatalog(uk, name) })
        .click()
    }

    test('10a: logout purges the persisted cache; the next account never paints the previous rows', async ({
      page,
    }) => {
      await loginViaApi(page, SEED_EMAILS.hrA)
      await page.goto('/job-queue')
      await expect(page.getByTestId(ANY_ROW)).toHaveCount(3)
      // `projects` is on the `__root.tsx` allow-list: once it is written, the entry exists
      await nav(page, 'Проєкти')
      await expect.poll(async () => (await persisted(page)).keys).toContain('projects')
      const before = await persisted(page)
      expect(before.raw.length).toBeGreaterThan(0)
      // queue answers are never on the allow-list
      for (const title of Object.values(SEED_QUEUE)) expect(before.raw).not.toContain(title)

      await page.getByTestId('header-user-menu-trigger').click()
      await page.getByTestId('header-user-menu-logout').click()
      await expect(page).toHaveURL(/\/login/)
      // the purge and the redirect race: read the store until it settles, not once
      await expect
        .poll(async () => {
          const after = await persisted(page)
          const titles = Object.values(SEED_QUEUE).filter((t) => after.raw.includes(t))
          return { keys: after.keys, titles }
        })
        .toEqual({ keys: [], titles: [] })

      // logout itself is a hard navigation, so the next document starts from IndexedDB alone
      await page.addInitScript(watchRows)
      await loginViaApi(page, SEED_EMAILS.hr0)
      await page.goto('/job-queue')
      await expect(page.getByTestId('job-queue-no-team')).toBeVisible()
      // the observer keeps every row ever painted, so the final state is the whole history
      await expect.poll(() => rowsSeen(page)).toEqual([])
    })

    test('10b: an account change in the open page never paints the previous account rows', async ({
      page,
    }) => {
      await loginViaApi(page, SEED_EMAILS.hrA)
      // the two vacancies only Team Kovalenko sees: Team Marchenko must never paint them
      const annaOnly = [
        await rowId(page, SEED_QUEUE.unsafeDescription),
        await rowId(page, SEED_QUEUE.uncertainMatch),
      ]
      await page.goto('/job-queue')
      for (const id of annaOnly) await expect(page.getByTestId(ROW(id))).toBeVisible()
      // leave the queue client-side: the document and its in-memory cache stay alive
      await nav(page, 'Проєкти')
      await expect(page).toHaveURL(/\/projects/)
      await page.evaluate(watchRows)

      // another account takes the cookie (another tab's sign-in), no reload
      await loginViaApi(page, SEED_EMAILS.hrB)
      await nav(page, 'Черга зовнішніх вакансій')
      await expect(page.getByTestId(ANY_ROW).first()).toBeVisible()
      // Task 7.6c: the route change revalidates `auth/me` and purges the cache before the queue renders
      const seen = await rowsSeen(page)
      for (const id of annaOnly) expect(seen).not.toContain(ROW(id))
    })
  })

  test.describe('12: ADMIN source switch and triage assign', () => {
    test('12a: only ADMIN gets the source panel; the API refuses HR reads and writes', async ({
      page,
    }) => {
      await loginViaApi(page, SEED_EMAILS.admin)
      await page.goto('/job-queue')
      await expect(page.getByTestId('job-source-section')).toBeVisible()

      await loginViaApi(page, SEED_EMAILS.hrA)
      await page.goto('/job-queue')
      await expect(page.getByTestId(ANY_ROW).first()).toBeVisible()
      await expect(page.getByTestId('job-source-section')).toHaveCount(0)
      const sources = `${REAL_API_BASE}/api/job-sourcing/sources`
      for (const res of [
        await page.request.get(sources),
        await page.request.patch(`${sources}/${randomUUID()}`, { data: { enabled: false } }),
      ]) {
        expect([res.status(), ((await res.json()) as { code?: string }).code]).toEqual([
          403,
          'FORBIDDEN_INSUFFICIENT_ROLE',
        ])
      }
    })

    // The seed has no `job_sources` row and no API creates one: the switch's rendering runs on a
    // mocked source list under a REAL ADMIN session; its RBAC is the real-API case 12a above.
    const openSources = async (page: Page) => {
      await page.goto('/job-queue')
      await page.getByTestId('job-source-section-title').click()
      return page.getByTestId('job-source-card').getByRole('switch')
    }

    test('12b: ADMIN switches a source off and back on (source list mocked)', async ({ page }) => {
      await loginViaApi(page, SEED_EMAILS.admin)
      await mockJobSources(page, jobSource())
      const toggle = await openSources(page)
      await expect(toggle).toBeChecked()

      await toggle.click()
      await expect(toggle).not.toBeChecked()
      await toggle.click()
      await expect(toggle).toBeChecked()
    })

    test('12c: a readiness refusal keeps the source off and says why (source list mocked)', async ({
      page,
    }) => {
      await loginViaApi(page, SEED_EMAILS.admin)
      await mockJobSources(
        page,
        jobSource({
          enabled: false,
          readiness: 'CANDIDATE',
          readinessReason: 'AUTH_DEADLINE_PASSED: the authorization window closed',
        }),
        'JOB_SOURCE_NOT_READY',
      )
      const toggle = await openSources(page)
      await expect(toggle).not.toBeChecked()

      await toggle.click()

      await expect(page.getByTestId('job-source-enable-failure')).toBeVisible()
      await expect(toggle).not.toBeChecked()
    })

    test.describe('12d: triage grant from the card', () => {
      let id = ''
      let team = ''
      let granted: number | null = null
      const sees = (browser: Browser, email: string) =>
        asActor(browser, email, async (p) =>
          (await visibleTitles(p.request)).includes(SEED_QUEUE.unclearStack),
        )

      // ADMIN state is set and undone from a context of its own, never through the test page
      test.beforeEach(async ({ browser }) => {
        await asActor(browser, SEED_EMAILS.admin, async (p) => {
          team = await teamIdByName(p.request, SEED_TEAMS.kravchenko)
          const row = await queueRow(p.request, SEED_QUEUE.unclearStack)
          if (!row) throw new Error('the triage vacancy is not in the ADMIN «Нові» tab')
          id = row.opportunityId
        })
        // a grant left by an aborted run would show the vacancy before the click
        if (await sees(browser, SEED_EMAILS.hr3)) {
          const revoked = await asActor(browser, SEED_EMAILS.admin, (p) =>
            revokeLiveTriage(p.request, id, team),
          )
          if (revoked === null) throw new Error('Team Kravchenko sees the vacancy, no live grant')
        }
        expect(await sees(browser, SEED_EMAILS.hr3)).toBe(false)
      })
      test.afterEach(async ({ browser }) => {
        if (granted !== null) {
          const version = granted
          granted = null
          await asActor(browser, SEED_EMAILS.admin, (p) =>
            revokeTriage(p.request, id, team, version),
          )
        } else if (await sees(browser, SEED_EMAILS.hr3)) {
          // the grant landed but the test died before it read the version
          await asActor(browser, SEED_EMAILS.admin, (p) => revokeLiveTriage(p.request, id, team))
        }
        expect(await sees(browser, SEED_EMAILS.hr3)).toBe(false)
      })

      test('12d: «Призначити команді…» shows the vacancy to the granted team only', async ({
        page,
        browser,
      }) => {
        const uk = await loadMessages('uk')
        await loginViaApi(page, SEED_EMAILS.admin)
        await page.goto('/job-queue')
        await page.getByTestId(ROW(id)).click()
        await page
          .getByTestId('job-queue-card')
          .getByRole('button', { name: assertInCatalog(uk, 'Дії адміністратора'), exact: true })
          .click()
        await page
          .getByRole('menuitem', { name: assertInCatalog(uk, 'Призначити команді…') })
          .click()
        const dialog = page.getByRole('alertdialog', {
          name: assertInCatalog(uk, 'Призначити вакансію команді'),
        })
        await dialog.getByRole('combobox', { name: assertInCatalog(uk, 'Команда') }).click()
        await page.getByRole('option', { name: SEED_TEAMS.kravchenko }).click()
        await dialog
          .getByRole('textbox', { name: assertInCatalog(uk, 'Причина') })
          .fill('Task 7.6 E2E triage grant')
        const posted = page.waitForResponse(
          (r) =>
            r.request().method() === 'POST' &&
            /\/job-queue\/[0-9a-f-]{36}\/team-triage$/.test(new URL(r.url()).pathname),
        )
        await dialog
          .getByRole('button', { name: assertInCatalog(uk, 'Призначити'), exact: true })
          .click()
        const res = await posted
        expect(res.status()).toBe(201)
        granted = jobQueueTeamTriageGrantSchema.parse(await res.json()).grantVersion
        await expect(
          page.locator('[data-sonner-toast]').filter({ hasText: SEED_TEAMS.kravchenko }),
        ).toBeVisible()

        await asActor(browser, SEED_EMAILS.hr3, async (p) => {
          await p.goto('/job-queue')
          await expect(p.getByTestId(ROW(id))).toBeVisible()
        })
        await asActor(browser, SEED_EMAILS.hrB, async (p) => {
          expect(await visibleTitles(p.request)).not.toContain(SEED_QUEUE.unclearStack)
          await p.goto('/job-queue')
          await expect(p.getByTestId(ANY_ROW)).toHaveCount(2)
          await expect(p.getByTestId(ROW(id))).toHaveCount(0)
        })
      })
    })
  })
})
