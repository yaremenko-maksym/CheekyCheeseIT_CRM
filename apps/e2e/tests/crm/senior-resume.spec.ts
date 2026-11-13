/**
 * senior-resume.spec.ts — task-resume-base, the resume tab on a senior's card.
 *
 * Coverage:
 *   - the tab appears on a SENIOR card (ADMIN view + SENIOR self-view) and is
 *     absent on a non-senior card;
 *   - empty state offers file upload AND the paste-text fallback;
 *   - async extraction: QUEUED -> RUNNING -> READY is reflected by polling,
 *     with named progress copy the whole way (AC3);
 *   - FAILED states carry actionable copy, and the quota wall names its reset
 *     time while leaving manual editing available (AC5);
 *   - HR edits FACTS (verified base resume Task 18): a save goes to PUT facts,
 *     Submit stays disabled while the completeness panel lists issues, and
 *     leaving with unsaved facts is guarded;
 *   - a `javascript:` link in resume content is never rendered as a link (AC7);
 *   - responsive: the tab is usable at 320 px with no horizontal overflow (AC9).
 *
 * Route-mocked — no live backend needed, same pattern as contract-editor.spec.ts.
 *
 * Lives in `tests/crm/` on purpose: that directory prefix is already part of
 * the `misc` CI shard, so the spec is gated by CI without editing ci.yml
 * (which is DevOps's file, not this task's).
 */
import { test, expect, type Page } from '@playwright/test'
import {
  USERS,
  mockAuthAs,
  buildAdminViewingUser,
  buildSelfView,
  buildHrViewingSenior,
  API_GLOB,
  API_RE,
} from '../fixtures'
import {
  DEFAULT_LAYOUT,
  EMPTY_FACTS,
  json,
  mockResumeAssets,
  resumeResponse,
} from '../fixtures/senior-resume-mocks'
import { loadMessages, assertInCatalog } from '../../fixtures/catalog'

// task-i18n-stage3b (Task 1) — this file is otherwise PR3's (resume feature,
// still Russian on purpose). The 3 lines below click/assert UserProfileShell's
// own "Огляд"/"Залишитися" chrome (already migrated in THIS PR), so they must
// stay in sync — every other Резюме/Черновик string here is untouched.
let uk: Record<string, string>
test.beforeAll(async () => {
  uk = await loadMessages('uk')
})
const SENIOR_ID = USERS.senior.id

const FILLED_CONTENT = {
  summary: 'Синьор-разработчик с восемью годами опыта.',
  skills: ['TypeScript', 'NestJS'],
  experience: [
    {
      company: 'Акме',
      role: 'Технический лидер',
      period: '2021 — наст. время',
      bullets: ['Руководил командой из пяти инженеров'],
    },
    { company: 'Бета', role: 'Разработчик', period: '2018–2021', bullets: [] },
  ],
  education: [],
  languages: [],
  links: [],
}

/**
 * Mock GET /users/:id/resume with a QUEUE of successive answers — the tab
 * polls, so returning a different body per call is what actually exercises the
 * async state machine rather than a static snapshot. A PUT (save) is answered
 * with `savedResponse`, so both verbs share one route registration and their
 * relative order can never drift.
 */
async function mockResumeEndpoints(
  page: Page,
  responses: Array<ReturnType<typeof resumeResponse>>,
  savedResponse?: ReturnType<typeof resumeResponse>,
  afterTextPost?: ReturnType<typeof resumeResponse>,
) {
  let call = 0
  let textPosted = false
  await page.route(new RegExp(`${API_RE}/users/([^/?]+)/resume$`), async (route) => {
    if (route.request().method() === 'PUT') {
      const last = responses[responses.length - 1]
      await route.fulfill(json(savedResponse ?? last))
      return
    }
    // State-based, not call-count-based: the profile page may legitimately
    // refetch the resume (staleTime 0) before the user acts, and a counter
    // would then serve the post-submit snapshot too early.
    // Keep the initial server state for two reads. The profile query uses
    // staleTime: 0, so mounting/navigation can legitimately issue an immediate
    // second GET before the first snapshot has been painted. Advancing the
    // fixture on every raw request made QUEUED disappear before a user could
    // ever observe it and turned this state-machine test into a timing race.
    const sequenceIndex = Math.min(Math.max(0, call - 1), responses.length - 1)
    const body = textPosted && afterTextPost ? afterTextPost : responses[sequenceIndex]
    call += 1
    await route.fulfill(json(body))
  })
  // Task 18: HR saves FACTS, never the resume text. Answered like the old PUT.
  await page.route(new RegExp(`${API_RE}/users/([^/?]+)/resume/facts$`), async (route) => {
    const last = responses[responses.length - 1]
    await route.fulfill(json(savedResponse ?? last))
  })
  await page.route(new RegExp(`${API_RE}/users/([^/?]+)/resume/text$`), (route) => {
    textPosted = true
    return route.fulfill(json(resumeResponse({ status: 'QUEUED' }), 201))
  })
  await mockResumeAssets(page)
}

/** Register a DELETE handler and report what it received. */
async function mockResumeDelete(page: Page): Promise<{ calls: string[] }> {
  const calls: string[] = []
  await page.route(new RegExp(`${API_RE}/users/([^/?]+)/resume$`), async (route) => {
    if (route.request().method() !== 'DELETE') {
      await route.fallback()
      return
    }
    calls.push(route.request().url())
    await route.fulfill(json(resumeResponse(null)))
  })
  return { calls }
}

/**
 * Open a senior's resume tab as ADMIN. Resume routes are registered AFTER
 * `mockAuthAs` on purpose: Playwright resolves the most recently registered
 * matching handler first, so this guarantees the resume mocks win over any
 * broader `/users/...` pattern the shared fixture installs.
 */
async function openSeniorResumeAsAdmin(
  page: Page,
  responses: Array<ReturnType<typeof resumeResponse>>,
  savedResponse?: ReturnType<typeof resumeResponse>,
  afterTextPost?: ReturnType<typeof resumeResponse>,
) {
  await mockAuthAs(page, USERS.admin)
  await page.route(`${API_GLOB}/users/${SENIOR_ID}`, (r) =>
    r.fulfill(json(buildAdminViewingUser(USERS.senior))),
  )
  await mockResumeEndpoints(page, responses, savedResponse, afterTextPost)
  await page.goto(`/profile/${SENIOR_ID}?tab=resume`)
}

// ---------------------------------------------------------------------------
// Tab presence
// ---------------------------------------------------------------------------

test.describe('Резюме — вкладка на карточке синьора', () => {
  test('вкладка «Резюме» есть на карточке синьора у админа', async ({ page }) => {
    await openSeniorResumeAsAdmin(page, [resumeResponse({ content: FILLED_CONTENT })])
    await expect(page.getByRole('button', { name: 'Резюме', exact: true })).toBeVisible()
    await expect(page.getByTestId('resume-tab')).toBeVisible()
  })

  test('синьор видит вкладку «Резюме» в собственном профиле', async ({ page }) => {
    await mockAuthAs(page, USERS.senior)
    await page.route(`${API_GLOB}/users/me`, (r) => r.fulfill(json(buildSelfView(USERS.senior))))
    await mockResumeEndpoints(page, [resumeResponse(null)])
    await page.goto('/profile?tab=resume')
    await expect(page.getByRole('button', { name: 'Резюме', exact: true })).toBeVisible()
    await expect(page.getByTestId('resume-intake')).toBeVisible()
  })

  test('на карточке джуна вкладки «Резюме» нет', async ({ page }) => {
    await mockAuthAs(page, USERS.admin)
    await page.route(`${API_GLOB}/users/${USERS.junior.id}`, (r) =>
      r.fulfill(json(buildAdminViewingUser(USERS.junior))),
    )
    await page.goto(`/profile/${USERS.junior.id}`)
    await expect(
      page.getByRole('button', { name: assertInCatalog(uk, 'Огляд'), exact: true }),
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Резюме', exact: true })).toHaveCount(0)
  })
})

// ---------------------------------------------------------------------------
// Empty state + intake
// ---------------------------------------------------------------------------

test.describe('Резюме — пустое состояние', () => {
  test('предлагает загрузить файл или вставить текст', async ({ page }) => {
    await openSeniorResumeAsAdmin(page, [resumeResponse(null)])

    await expect(page.getByTestId('resume-intake')).toBeVisible()
    await expect(page.getByTestId('resume-upload-button')).toBeVisible()
    await expect(page.getByTestId('resume-paste-toggle')).toBeVisible()
    await expect(page.getByTestId('resume-fill-manually')).toBeVisible()
  })

  test('«Заповнити вручну» открывает пустую форму фактов', async ({ page }) => {
    await openSeniorResumeAsAdmin(page, [resumeResponse(null)])

    await page.getByTestId('resume-fill-manually').click()
    await expect(page.getByTestId('resume-facts-form')).toBeVisible()
    await expect(page.locator('input[name="resumeFactsHeadline"]')).toHaveValue('')
  })

  test('вставка текста уходит на сервер и переводит резюме в очередь', async ({ page }) => {
    await openSeniorResumeAsAdmin(
      page,
      [resumeResponse(null)],
      undefined,
      resumeResponse({ status: 'QUEUED' }),
    )

    await page.getByTestId('resume-paste-toggle').click()
    await page
      .getByTestId('resume-text-input')
      .fill('Иван Петров. Синьор-разработчик. Опыт: Акме, 2021 — наст. время. TypeScript, NestJS.')
    const posted = page.waitForRequest(
      (r) => r.url().includes('/resume/text') && r.method() === 'POST',
    )
    await page.getByTestId('resume-text-submit').click()

    const request = await posted
    const body = JSON.parse(request.postData() ?? '{}') as { text?: string }
    expect(body.text).toContain('Иван Петров')
    await expect(page.getByTestId('resume-progress')).toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// AC3 — async extraction with visible progress
// ---------------------------------------------------------------------------

test.describe('Резюме — асинхронное распознавание (AC3)', () => {
  test('QUEUED → RUNNING → READY: прогресс виден, экран не заблокирован', async ({ page }) => {
    await openSeniorResumeAsAdmin(page, [
      resumeResponse({ status: 'QUEUED' }),
      resumeResponse({ status: 'RUNNING' }),
      resumeResponse({ status: 'READY', content: FILLED_CONTENT, version: 2 }),
    ])

    await expect(page.getByTestId('resume-progress')).toContainText('черзі на розпізнавання')
    // Not a blocking overlay — the facts form is reachable the whole time.
    await expect(page.getByTestId('resume-facts-form')).toBeVisible()

    await expect(page.getByTestId('resume-progress')).toContainText('Розпізнаємо резюме', {
      timeout: 10_000,
    })
    await expect(page.getByTestId('resume-progress')).toBeHidden({ timeout: 10_000 })
    await expect(page.getByTestId('resume-facts-form')).toBeVisible()
  })

  test('FAILED/NO_TEXT объясняет причину и предлагает вставить текст', async ({ page }) => {
    await openSeniorResumeAsAdmin(page, [
      resumeResponse({
        status: 'FAILED',
        errorCode: 'NO_TEXT',
        errorMessage: 'Из файла не удалось извлечь текст',
      }),
    ])

    const failed = page.getByTestId('resume-failed')
    await expect(failed).toBeVisible()
    await expect(failed).toContainText('немає текстового шару')
    await expect(page.getByTestId('resume-paste-toggle')).toBeVisible()
  })

  test('AC5: исчерпан лимит — названо время сброса, ручное заполнение доступно', async ({
    page,
  }) => {
    await openSeniorResumeAsAdmin(page, [
      resumeResponse({
        status: 'FAILED',
        errorCode: 'QUOTA_EXCEEDED',
        errorMessage: 'Исчерпан суточный лимит бесплатных запросов к ИИ.',
        quotaResetsAt: '2026-08-08T00:00:00.000Z',
      }),
    ])

    const failed = page.getByTestId('resume-failed')
    await expect(failed).toContainText('ліміт')
    await expect(failed).toContainText('серпня')
    // The form is NOT blocked by the quota wall.
    await expect(page.locator('input[name="resumeFactsHeadline"]')).toBeEnabled()
  })
})

// ---------------------------------------------------------------------------
// Facts editing (verified base resume Task 18)
// ---------------------------------------------------------------------------

test.describe('Резюме — факты', () => {
  test('сохранение черновика уходит в PUT facts и не открывает модалку', async ({ page }) => {
    await openSeniorResumeAsAdmin(page, [resumeResponse({ content: FILLED_CONTENT })])

    await page.locator('input[name="resumeFactsHeadline"]').fill('Senior backend engineer')
    // Editing happens in place — no dialog opens.
    await expect(page.getByRole('dialog')).toHaveCount(0)
    // Registered after the page is up: its 10 s actionTimeout must not also cover a cold load.
    const putRequest = page.waitForRequest(
      (r) => r.url().endsWith('/resume/facts') && r.method() === 'PUT',
    )
    await page.getByTestId('resume-facts-save').click()

    const request = await putRequest
    const body = JSON.parse(request.postData() ?? '{}') as { facts?: { headline?: string } }
    expect(body.facts?.headline).toBe('Senior backend engineer')
  })

  test('«Надіслати на перевірку» недоступна, пока панель перечисляет поля', async ({ page }) => {
    await openSeniorResumeAsAdmin(page, [resumeResponse({ content: FILLED_CONTENT })])

    const panel = page.getByTestId('resume-completeness-panel')
    await expect(panel.getByRole('listitem').first()).toBeVisible()
    await expect(page.getByTestId('resume-facts-submit')).toBeDisabled()
  })

  test('черновик со статусом DRAFT помечен бейджем', async ({ page }) => {
    await openSeniorResumeAsAdmin(page, [resumeResponse({ content: FILLED_CONTENT })])

    await expect(page.getByTestId('resume-verification-badge')).toBeVisible()
  })

  test('идёт проверка — форма недоступна', async ({ page }) => {
    await openSeniorResumeAsAdmin(page, [
      resumeResponse({ content: FILLED_CONTENT, verificationBusy: true }),
    ])

    await expect(page.locator('input[name="resumeFactsHeadline"]')).toBeDisabled()
    await expect(page.getByTestId('resume-facts-submit')).toBeDisabled()
  })

  test('уход с вкладки с несохранёнными фактами спрашивает подтверждение', async ({ page }) => {
    await openSeniorResumeAsAdmin(page, [resumeResponse({ content: FILLED_CONTENT })])

    const headline = page.locator('input[name="resumeFactsHeadline"]')
    await headline.fill('Draft that is easy to lose')
    await page.getByRole('button', { name: assertInCatalog(uk, 'Огляд'), exact: true }).click()

    const guard = page.getByTestId('contract-dirty-guard-dialog')
    await expect(guard).toBeVisible()
    await expect(guard).toContainText('Резюме')
    // Staying keeps the draft.
    await page.getByRole('button', { name: assertInCatalog(uk, 'Залишитися') }).click()
    await expect(headline).toHaveValue('Draft that is easy to lose')
  })

  test('добавление места работы не стирает черновик', async ({ page }) => {
    await openSeniorResumeAsAdmin(page, [resumeResponse({ content: FILLED_CONTENT })])

    const headline = page.locator('input[name="resumeFactsHeadline"]')
    await headline.fill('Draft that is easy to lose')
    await page.getByTestId('resume-facts-experience-add').click()

    await expect(page.getByTestId('resume-facts-job-0')).toBeVisible()
    await expect(headline).toHaveValue('Draft that is easy to lose')
  })

  test('порядок мест работы меняется кнопками и уходит в сохранение', async ({ page }) => {
    const job = (company: string) => ({
      company,
      role: 'Engineer',
      location: null,
      start: '2020-01',
      end: '2021-01',
      current: false,
      technologies: [],
      notes: [],
    })
    const facts = { ...EMPTY_FACTS, experience: [job('Acme'), job('Beta'), job('Gamma')] }
    await openSeniorResumeAsAdmin(page, [resumeResponse({ content: FILLED_CONTENT, facts })])

    const company = (i: number) =>
      page.getByTestId(`resume-facts-job-${i}`).locator('input[name="resumeFactsCompany"]')
    await expect(company(0)).toHaveValue('Acme')
    // Up on the second job, then down on the (new) second job: Beta, Gamma, Acme.
    await page.getByRole('button', { name: 'Перемістити місце роботи 2 вгору' }).click()
    await expect(company(0)).toHaveValue('Beta')
    await page.getByRole('button', { name: 'Перемістити місце роботи 2 вниз' }).click()
    await expect(company(1)).toHaveValue('Gamma')
    const putRequest = page.waitForRequest(
      (r) => r.url().endsWith('/resume/facts') && r.method() === 'PUT',
    )
    await page.getByTestId('resume-facts-save').click()

    const body = JSON.parse((await putRequest).postData() ?? '{}') as {
      facts?: { experience?: { company: string }[] }
    }
    expect(body.facts?.experience?.map((e) => e.company)).toEqual(['Beta', 'Gamma', 'Acme'])
  })
})

// ---------------------------------------------------------------------------
// Erasure (personal data)
// ---------------------------------------------------------------------------

test.describe('Резюме — удаление', () => {
  test('удаление спрашивает подтверждение и возвращает пустое состояние', async ({ page }) => {
    await openSeniorResumeAsAdmin(page, [
      resumeResponse({ content: FILLED_CONTENT, hasSourceFile: true }),
    ])
    const del = await mockResumeDelete(page)
    // Wait for the tab itself before reaching for anything inside it, so a
    // failure points at the missing control rather than at page load.
    await expect(page.getByTestId('resume-tab')).toBeVisible()

    await page.getByTestId('resume-delete').click()
    const dialog = page.getByTestId('resume-delete-confirm-dialog')
    await expect(dialog).toBeVisible()
    // It names the file that goes with the record.
    await expect(dialog).toContainText('резюме.pdf')

    await page.getByTestId('resume-delete-cancel').click()
    await expect(dialog).toBeHidden()
    expect(del.calls).toHaveLength(0)

    await page.getByTestId('resume-delete').click()
    await page.getByTestId('resume-delete-confirm').click()

    await expect(page.getByTestId('resume-intake')).toBeVisible()
    expect(del.calls).toHaveLength(1)
  })

  test('синьор не видит кнопку удаления в чужом резюме (только чтение)', async ({ page }) => {
    await mockAuthAs(page, USERS.admin)
    await page.route(`${API_GLOB}/users/${SENIOR_ID}`, (r) =>
      r.fulfill(json(buildAdminViewingUser(USERS.senior))),
    )
    await mockResumeEndpoints(page, [resumeResponse({ content: FILLED_CONTENT }, false)])
    await page.goto(`/profile/${SENIOR_ID}?tab=resume`)

    await expect(page.getByTestId('resume-summary-view')).toBeVisible()
    await expect(page.getByTestId('resume-delete')).toHaveCount(0)
  })
})

// ---------------------------------------------------------------------------
// AC7 — untrusted content
// ---------------------------------------------------------------------------

test('AC7: javascript-ссылка из резюме не становится кликабельной', async ({ page }) => {
  // A read-only viewer sees the resume text; an editor sees the facts form.
  await openSeniorResumeAsAdmin(page, [
    resumeResponse(
      {
        content: {
          ...FILLED_CONTENT,
          links: [
            { label: 'Плохая', url: 'javascript:alert(1)' },
            { label: 'Хорошая', url: 'https://example.com' },
          ],
        },
      },
      false,
    ),
  ])

  const links = page.getByTestId('resume-links-view')
  await expect(links).toContainText('Плохая')
  await expect(links.getByRole('link')).toHaveCount(1)
  await expect(links.getByRole('link')).toHaveAttribute('href', 'https://example.com')
})

// ---------------------------------------------------------------------------
// AC9 — responsive
// ---------------------------------------------------------------------------

test.describe('Резюме — адаптив (AC9)', () => {
  for (const width of [320, 768, 1024, 1440]) {
    test(`нет горизонтального переполнения на ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await openSeniorResumeAsAdmin(page, [resumeResponse({ content: FILLED_CONTENT })])
      await expect(page.getByTestId('resume-tab')).toBeVisible()

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
      expect(overflow).toBeLessThanOrEqual(1)
    })
  }

  test('на мобильном тач-цели правки не меньше 44px', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 })
    await openSeniorResumeAsAdmin(page, [resumeResponse({ content: FILLED_CONTENT })])

    const submitBox = await page.getByTestId('resume-facts-submit').boundingBox()
    expect(submitBox?.height ?? 0).toBeGreaterThanOrEqual(44)

    await page.getByTestId('resume-facts-experience-add').click()
    // The first icon button of a job block: move up / down / remove.
    const iconBox = await page
      .getByTestId('resume-facts-job-0')
      .getByRole('button')
      .first()
      .boundingBox()
    expect(iconBox?.height ?? 0).toBeGreaterThanOrEqual(44)
    expect(iconBox?.width ?? 0).toBeGreaterThanOrEqual(44)
  })

  test('на мобильном переключатели оформления тоже не меньше 44px', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 })
    await openSeniorResumeAsAdmin(page, [resumeResponse({ content: FILLED_CONTENT })])

    const hide = page.getByTestId('resume-layout-toggle-links')
    await hide.scrollIntoViewIfNeeded()
    const box = await hide.boundingBox()
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44)
  })
})

/**
 * task-resume-template: the layout switches and the rendered document.
 *
 * The PDF is built by a background job, so what the interface must never do is
 * present a stale or missing render as the current resume. These pin the three
 * states end to end.
 */
test.describe('Резюме синьора — оформление и PDF', () => {
  test('переключатель оформления уходит на сервер как отдельное сохранение', async ({ page }) => {
    const layoutCalls: unknown[] = []
    await page.route(new RegExp(`${API_RE}/users/([^/?]+)/resume/layout$`), async (route) => {
      layoutCalls.push(route.request().postDataJSON())
      await route.fulfill(json(resumeResponse({ content: FILLED_CONTENT })))
    })
    await openSeniorResumeAsAdmin(page, [resumeResponse({ content: FILLED_CONTENT })])

    await page.getByTestId('resume-layout-toggle-links').click()
    await page.getByTestId('resume-layout-save').click()

    await expect.poll(() => layoutCalls.length).toBe(1)
    expect(layoutCalls[0]).toMatchObject({ layout: { hiddenSections: ['links'] } })
  })

  test('готовый PDF показывается и скачивается', async ({ page }) => {
    await openSeniorResumeAsAdmin(page, [resumeResponse({ content: FILLED_CONTENT })])

    await expect(page.getByTestId('resume-pdf-preview')).toBeVisible()
    await expect(page.getByTestId('resume-download-pdf')).toHaveAttribute(
      'href',
      /\/users\/[^/]+\/resume\/pdf$/,
    )
  })

  test('устаревший PDF не выдаётся за текущий', async ({ page }) => {
    await openSeniorResumeAsAdmin(page, [
      resumeResponse({ content: FILLED_CONTENT, renderStatus: 'RUNNING', pdfUpToDate: false }),
    ])

    await expect(page.getByTestId('resume-pdf-pending')).toBeVisible()
    // The download must be gone, not merely stale — a resume that no longer
    // matches its PDF has no current PDF to offer.
    await expect(page.getByTestId('resume-download-pdf')).toHaveCount(0)
  })

  test('провал сборки объясняется словами сервера', async ({ page }) => {
    await openSeniorResumeAsAdmin(page, [
      resumeResponse({
        content: FILLED_CONTENT,
        renderStatus: 'FAILED',
        pdfUpToDate: false,
        renderError: 'Вёрстка не уложилась в 20 с.',
      }),
    ])

    await expect(page.getByTestId('resume-pdf-failed')).toContainText('не уложилась')
  })

  test('шаблон недоступен для правки из интерфейса', async ({ page }) => {
    await openSeniorResumeAsAdmin(page, [resumeResponse({ content: FILLED_CONTENT })])

    // Switches only: a textarea would make template source editable from a browser.
    const panel = page.getByTestId('resume-layout-panel')
    await expect(panel).toBeVisible()
    await expect(panel.getByRole('textbox')).toHaveCount(0)
  })
})

/**
 * verified-base-resume Task 19: the confirm step and the failure panel. Only a
 * viewer the server marks `canConfirm` gets the Confirm button; the request
 * carries the staged run and the version the reviewer looked at.
 */
test.describe('Резюме — подтверждение проверенного текста', () => {
  const RUN_ID = 'bbbbbbbb-0000-4000-8000-000000000001'
  const awaiting = (canConfirm: boolean) =>
    resumeResponse(
      {
        content: FILLED_CONTENT,
        version: 3,
        verificationStatus: 'AWAITING_CONFIRM',
        staged: {
          runId: RUN_ID,
          content: FILLED_CONTENT,
          layout: DEFAULT_LAYOUT,
          templateName: 'classic',
          pdfAvailable: true,
          editedPaths: [],
        },
      },
      true,
      canConfirm,
    )

  test('HR confirms: the request carries runId and version', async ({ page }) => {
    const bodies: unknown[] = []
    await mockAuthAs(page, USERS.hr)
    await page.route(`${API_GLOB}/users/${SENIOR_ID}`, (r) =>
      r.fulfill(json(buildHrViewingSenior(USERS.senior))),
    )
    await mockResumeEndpoints(page, [awaiting(true)])
    await page.route(new RegExp(`${API_RE}/users/([^/?]+)/resume/confirm$`), async (route) => {
      bodies.push(route.request().postDataJSON())
      await route.fulfill(
        json(resumeResponse({ content: FILLED_CONTENT, verificationStatus: 'VERIFIED' })),
      )
    })
    await page.goto(`/profile/${SENIOR_ID}?tab=resume`)

    await expect(page.getByTestId('resume-confirm-block-summary')).toBeVisible()
    const form = page.getByTestId('resume-facts-form') // R56: hidden, not unmounted
    await expect(form).toBeAttached()
    await expect(form).toBeHidden()
    await page.getByTestId('resume-confirm').click()
    await expect.poll(() => bodies.length).toBe(1)
    expect(bodies[0]).toEqual({ runId: RUN_ID, version: 3 })
  })

  test('a senior sees the staged text but no Confirm button', async ({ page }) => {
    await mockAuthAs(page, USERS.senior)
    await page.route(`${API_GLOB}/users/me`, (r) => r.fulfill(json(buildSelfView(USERS.senior))))
    await mockResumeEndpoints(page, [awaiting(false)])
    await page.goto('/profile?tab=resume')

    await expect(page.getByTestId('resume-confirm-block-summary')).toBeVisible()
    await expect(page.getByTestId('resume-confirm-change-facts')).toBeVisible()
    await expect(page.getByTestId('resume-confirm')).toHaveCount(0)
  })

  test('FAILED names the reason and the resume item, facts form open', async ({ page }) => {
    await openSeniorResumeAsAdmin(page, [
      resumeResponse({
        content: FILLED_CONTENT,
        verificationStatus: 'FAILED',
        verificationErrorCode: 'ATS_CHECK_FAILED',
        verificationReport: {
          gates: [
            {
              gate: 'ats',
              ok: false,
              items: [{ path: 'experience[0].bullets', reason: 'MISSING_TEXT' }],
            },
          ],
          fallbacks: [],
        },
      }),
    ])

    const failure = page.getByTestId('resume-verification-failure')
    await expect(failure).toContainText(assertInCatalog(uk, 'ATS не прочитав PDF'))
    await expect(failure).toContainText(assertInCatalog(uk, 'текст не знайдено в PDF'))
    await expect(failure).not.toContainText('ATS_CHECK_FAILED')
    await expect(page.getByTestId('resume-verification-retry')).toBeEnabled()
    await expect(page.getByTestId('resume-facts-form')).toBeVisible()
  })
})
