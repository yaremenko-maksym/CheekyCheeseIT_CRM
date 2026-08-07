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
 *   - per-section in-place editing saves the whole content object, and leaving
 *     with unsaved changes is guarded (§3);
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
import { USERS, mockAuthAs, buildAdminViewingUser, buildSelfView } from '../fixtures'

/**
 * Origin-agnostic patterns, same convention as fixtures.ts: axios talks to
 * `http://localhost:3001/api` in CI (VITE_API_URL) but to the page's own origin
 * `/api` behind the Vite proxy locally. A host-pinned pattern would silently
 * stop matching in one of the two setups.
 */
const API_GLOB = '**/api'
const API_RE = '\\/api'
const SENIOR_ID = USERS.senior.id

const EMPTY_CONTENT = {
  summary: '',
  skills: [],
  experience: [],
  education: [],
  languages: [],
  links: [],
}

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

interface ResumeStub {
  content?: unknown
  status?: string
  errorCode?: string | null
  errorMessage?: string | null
  quotaResetsAt?: string | null
  hasSourceFile?: boolean
  version?: number
}

function resumeResponse(stub: ResumeStub | null, canEdit = true) {
  if (stub === null) return { resume: null, canEdit }
  return {
    resume: {
      id: 'aaaaaaaa-0000-4000-8000-000000000001',
      userId: SENIOR_ID,
      content: stub.content ?? EMPTY_CONTENT,
      status: stub.status ?? 'READY',
      errorCode: stub.errorCode ?? null,
      errorMessage: stub.errorMessage ?? null,
      quotaResetsAt: stub.quotaResetsAt ?? null,
      sourceFileName: stub.hasSourceFile ? 'резюме.pdf' : null,
      sourceFileSizeBytes: stub.hasSourceFile ? 12345 : null,
      hasSourceFile: stub.hasSourceFile ?? false,
      version: stub.version ?? 1,
      updatedByUserId: null,
      updatedByName: null,
      createdAt: '2026-08-07T10:00:00.000Z',
      updatedAt: '2026-08-07T10:00:00.000Z',
    },
    canEdit,
  }
}

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) }
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
) {
  let call = 0
  await page.route(new RegExp(`${API_RE}/users/([^/?]+)/resume$`), async (route) => {
    if (route.request().method() === 'PUT') {
      const last = responses[responses.length - 1]
      await route.fulfill(json(savedResponse ?? last))
      return
    }
    const body = responses[Math.min(call, responses.length - 1)]
    call += 1
    await route.fulfill(json(body))
  })
  await page.route(new RegExp(`${API_RE}/users/([^/?]+)/resume/text$`), (route) =>
    route.fulfill(json(resumeResponse({ status: 'QUEUED' }), 201)),
  )
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
) {
  await mockAuthAs(page, USERS.admin)
  await page.route(`${API_GLOB}/users/${SENIOR_ID}`, (r) =>
    r.fulfill(json(buildAdminViewingUser(USERS.senior))),
  )
  await mockResumeEndpoints(page, responses, savedResponse)
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
    await expect(page.getByRole('button', { name: 'Обзор', exact: true })).toBeVisible()
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
  })

  test('вставка текста уходит на сервер и переводит резюме в очередь', async ({ page }) => {
    const posted = page.waitForRequest(
      (r) => r.url().includes('/resume/text') && r.method() === 'POST',
    )
    await openSeniorResumeAsAdmin(page, [
      resumeResponse(null),
      resumeResponse({ status: 'QUEUED' }),
    ])

    await page.getByTestId('resume-paste-toggle').click()
    await page
      .getByTestId('resume-text-input')
      .fill('Иван Петров. Синьор-разработчик. Опыт: Акме, 2021 — наст. время. TypeScript, NestJS.')
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

    await expect(page.getByTestId('resume-progress')).toContainText('очереди на распознавание')
    // Not a blocking overlay — the sections are reachable the whole time.
    await expect(page.getByTestId('resume-section-summary')).toBeVisible()

    await expect(page.getByTestId('resume-progress')).toContainText('Распознаём резюме', {
      timeout: 10_000,
    })
    await expect(page.getByTestId('resume-progress')).toBeHidden({ timeout: 10_000 })
    await expect(page.getByTestId('resume-summary-view')).toContainText('Синьор-разработчик')
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
    await expect(failed).toContainText('нет текстового слоя')
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
    await expect(failed).toContainText('лимит')
    await expect(failed).toContainText('августа')
    // The form is NOT blocked by the quota wall.
    await expect(page.getByTestId('resume-edit-summary')).toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// Per-section editing
// ---------------------------------------------------------------------------

test.describe('Резюме — правка по секциям', () => {
  test('правка «О себе» сохраняется и не открывает модалку', async ({ page }) => {
    const putRequest = page.waitForRequest(
      (r) => r.url().endsWith('/resume') && r.method() === 'PUT',
    )
    await openSeniorResumeAsAdmin(
      page,
      [resumeResponse({ content: FILLED_CONTENT })],
      resumeResponse({ content: FILLED_CONTENT, version: 2 }),
    )

    await page.getByTestId('resume-edit-summary').click()
    await page.getByTestId('resume-summary-input').fill('Обновлённое описание')
    // Editing happens in place — no dialog opens.
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.getByTestId('resume-save-summary').click()

    const request = await putRequest
    const body = JSON.parse(request.postData() ?? '{}') as { content?: { summary?: string } }
    expect(body.content?.summary).toBe('Обновлённое описание')
  })

  test('порядок мест работы меняется кнопками и уходит в сохранение', async ({ page }) => {
    const putRequest = page.waitForRequest(
      (r) => r.url().endsWith('/resume') && r.method() === 'PUT',
    )
    await openSeniorResumeAsAdmin(
      page,
      [resumeResponse({ content: FILLED_CONTENT })],
      resumeResponse({ content: FILLED_CONTENT, version: 2 }),
    )

    await page.getByTestId('resume-edit-experience').click()
    await page.getByTestId('resume-experience-up-1').click()
    await page.getByTestId('resume-save-experience').click()

    const request = await putRequest
    const body = JSON.parse(request.postData() ?? '{}') as {
      content?: { experience?: Array<{ company: string }> }
    }
    expect(body.content?.experience?.map((e) => e.company)).toEqual(['Бета', 'Акме'])
  })

  test('уход с вкладки с несохранёнными правками спрашивает подтверждение', async ({ page }) => {
    await openSeniorResumeAsAdmin(page, [resumeResponse({ content: FILLED_CONTENT })])

    await page.getByTestId('resume-edit-summary').click()
    await page.getByTestId('resume-summary-input').fill('Черновик, который легко потерять')
    await page.getByRole('button', { name: 'Обзор', exact: true }).click()

    const guard = page.getByTestId('contract-dirty-guard-dialog')
    await expect(guard).toBeVisible()
    await expect(guard).toContainText('Резюме')
    // Staying keeps the draft.
    await page.getByRole('button', { name: 'Остаться' }).click()
    await expect(page.getByTestId('resume-summary-input')).toHaveValue(
      'Черновик, который легко потерять',
    )
  })
})

// ---------------------------------------------------------------------------
// AC7 — untrusted content
// ---------------------------------------------------------------------------

test('AC7: javascript-ссылка из резюме не становится кликабельной', async ({ page }) => {
  await openSeniorResumeAsAdmin(page, [
    resumeResponse({
      content: {
        ...FILLED_CONTENT,
        links: [
          { label: 'Плохая', url: 'javascript:alert(1)' },
          { label: 'Хорошая', url: 'https://example.com' },
        ],
      },
    }),
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

    const editButton = page.getByTestId('resume-edit-summary')
    const box = await editButton.boundingBox()
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)

    await page.getByTestId('resume-edit-experience').click()
    const upBox = await page.getByTestId('resume-experience-up-1').boundingBox()
    expect(upBox?.height ?? 0).toBeGreaterThanOrEqual(44)
    expect(upBox?.width ?? 0).toBeGreaterThanOrEqual(44)
  })
})
