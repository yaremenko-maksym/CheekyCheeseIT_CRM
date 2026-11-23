import type { Page } from '@playwright/test'
import { test, expect, loginViaApi, REAL_API_BASE, SEED_EMAILS } from './fixtures'
import { loadMessages, assertInCatalog } from '../fixtures/catalog'
import { MOCK_IDS, apiError, mockJobQueue } from '../fixtures/job-queue'
import { API_RE } from './fixtures/route-helpers'
import { TEAMS, USERS } from './fixtures/mock-data'
import { json, resumeResponse } from './fixtures/senior-resume-mocks'

/**
 * External vacancy intake, PR 1 (spec `docs/superpowers/specs/2026-11-23-external-vacancy-intake-design.md`
 * §B): the bookmarklet's `#external=` hand-off opens «Записати зовнішню подачу» pre-filled.
 *
 * Mocked: what the dialog does with a prefill and with the server's answers. A manual card on the
 * real API would stay in the shared seed and change every actor's visible titles, so the create
 * itself is proven by the API unit specs. Real API: the hand-off survives a dev-login, and the
 * backend refuses a SENIOR.
 */

const TEAM = '99999999-9999-4999-8999-999999999999'
const SENIOR = USERS.senior.id

const prefill = {
  v: 1,
  recognition: 'partial',
  url: 'https://jobs.example.com/vacancy/42',
  title: 'Senior React Developer',
  company: 'Acme',
  description: 'Build the platform. Вимоги: React, TypeScript.',
  status: { url: 'found', title: 'found', company: 'guessed', description: 'found' },
}

const hash = (p: unknown = prefill) =>
  `#external=${Buffer.from(JSON.stringify(p), 'utf8').toString('base64url')}`

/** One team, the queue's HR, its mocked SENIOR with a READY resume, and the manual create. */
async function mockIntake(page: Page, manual: { status: number; body: unknown }) {
  await mockJobQueue(page)
  await page.route(new RegExp(`${API_RE}/teams(\\?|$)`), (r) =>
    r.fulfill(json([{ ...TEAMS[0], id: TEAM }])),
  )
  await page.route(new RegExp(`${API_RE}/users/${SENIOR}/resume(\\?|$)`), (r) =>
    r.fulfill(json(resumeResponse({ status: 'READY' }))),
  )
  const posts: unknown[] = []
  await page.route(new RegExp(`${API_RE}/job-queue/manual(\\?|$)`), (r) => {
    posts.push(r.request().postDataJSON())
    return r.fulfill(json(manual.body, manual.status))
  })
  return posts
}

const created = {
  submission: {
    id: MOCK_IDS.submission,
    opportunityId: MOCK_IDS.opportunity,
    seniorId: SENIOR,
    state: 'TAKEN',
    submittedAt: '2026-11-23T10:00:00.000Z',
    cancelledAt: null,
    version: 1,
    submittedByName: 'HR',
  },
}

test.describe('external submission dialog (mocked)', () => {
  test('a prefilled hand-off is recorded and the queue moves to «Подані»', async ({
    asHr: page,
  }) => {
    const uk = await loadMessages('uk')
    const posts = await mockIntake(page, { status: 201, body: created })

    await page.goto(`/job-queue${hash()}`)

    const dialog = page.getByTestId('external-submission-dialog')
    await expect(dialog).toBeVisible()
    // the hash is dropped at boot, so a reload or a shared link does not carry the payload
    expect(new URL(page.url()).hash).toBe('')
    await expect(dialog.getByLabel(assertInCatalog(uk, 'Назва вакансії'))).toHaveValue(
      prefill.title,
    )
    await expect(dialog.getByLabel(assertInCatalog(uk, 'Компанія'))).toHaveValue(prefill.company)
    await expect(dialog).toContainText(assertInCatalog(uk, 'Перевірте це значення'))

    await dialog.getByTestId('external-submit').click()

    await expect(dialog).toBeHidden()
    await expect(page).toHaveURL((u) => u.searchParams.get('tab') === 'SUBMITTED')
    expect(posts).toHaveLength(1)
    expect(posts[0]).toMatchObject({
      title: prefill.title,
      companyName: prefill.company,
      applicationUrl: prefill.url,
      submission: { teamId: TEAM, seniorId: SENIOR },
    })
  })

  test('the same link again offers the existing card, which opens on click', async ({
    asHr: page,
  }) => {
    const uk = await loadMessages('uk')
    await mockIntake(page, {
      status: 409,
      body: { ...apiError(409, 'JOB_QUEUE_MANUAL_DUPLICATE'), opportunityId: MOCK_IDS.opportunity },
    })

    await page.goto(`/job-queue${hash()}`)
    const dialog = page.getByTestId('external-submission-dialog')
    await dialog.getByTestId('external-submit').click()

    const duplicate = dialog.getByTestId('external-duplicate')
    await expect(duplicate).toContainText(assertInCatalog(uk, 'Ця вакансія вже є в черзі.'))
    await duplicate
      .getByRole('button', { name: assertInCatalog(uk, 'Відкрити й подати там') })
      .click()

    await expect(dialog).toBeHidden()
    await expect(page).toHaveURL((u) => u.searchParams.get('card') === MOCK_IDS.opportunity)
    await expect(page.getByTestId('job-queue-card')).toBeVisible()
  })

  test('a partial hand-off with page text is read once and fills only the empty fields', async ({
    asHr: page,
  }) => {
    const uk = await loadMessages('uk')
    await mockIntake(page, { status: 201, body: created })
    const parses: unknown[] = []
    await page.route(new RegExp(`${API_RE}/job-queue/manual/parse(\\?|$)`), (r) => {
      parses.push(r.request().postDataJSON())
      return r.fulfill(
        json({
          isVacancy: true,
          title: 'Go Developer',
          companyName: 'Globex',
          descriptionMd: 'Go.',
        }),
      )
    })
    const pageText = 'Go Developer at Globex. We need a Go developer.'

    await page.goto(`/job-queue${hash({ ...prefill, title: undefined, pageText })}`)

    const dialog = page.getByTestId('external-submission-dialog')
    await expect(dialog.getByLabel(assertInCatalog(uk, 'Назва вакансії'))).toHaveValue(
      'Go Developer',
    )
    // what the bookmarklet read stays: only the empty field is filled
    await expect(dialog.getByLabel(assertInCatalog(uk, 'Компанія'))).toHaveValue(prefill.company)
    await expect(dialog.getByTestId('external-paste')).toHaveValue(pageText)
    expect(parses).toEqual([{ text: pageText }])
  })

  test('«Заповнити» on an outage shows the banner and the fields stay editable', async ({
    asHr: page,
  }) => {
    const uk = await loadMessages('uk')
    await mockIntake(page, { status: 201, body: created })
    await page.route(new RegExp(`${API_RE}/job-queue/manual/parse(\\?|$)`), (r) =>
      r.fulfill(json(apiError(503, 'JOB_QUEUE_PARSE_UNAVAILABLE'), 503)),
    )

    await page.goto(`/job-queue${hash({ ...prefill, title: undefined })}`)
    const dialog = page.getByTestId('external-submission-dialog')
    await dialog.getByTestId('external-paste').fill('Go Developer at Globex')
    await dialog.getByTestId('external-fill').click()

    await expect(dialog.getByTestId('external-parse-error')).toContainText(
      assertInCatalog(uk, 'Розпізнавання тексту вакансії зараз недоступне. Заповніть поля вручну.'),
    )
    const title = dialog.getByLabel(assertInCatalog(uk, 'Назва вакансії'))
    await title.fill('Go Developer')
    await expect(title).toHaveValue('Go Developer')
  })
})

test.describe('external submission (real API)', () => {
  test('a hand-off opened while logged out survives the login and opens the dialog', async ({
    page,
  }) => {
    const uk = await loadMessages('uk')
    await page.goto(`/${hash()}`)
    await expect(page).toHaveURL(/\/login/, { timeout: 15_000 })

    await loginViaApi(page, SEED_EMAILS.hrA)
    await page.goto('/')

    await expect(page).toHaveURL(/\/job-queue/)
    const dialog = page.getByTestId('external-submission-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByLabel(assertInCatalog(uk, 'Назва вакансії'))).toHaveValue(
      prefill.title,
    )
    // taken once: closing and reloading does not reopen it
    await page.reload()
    await expect(page.getByTestId('job-queue-page')).toBeVisible()
    await expect(dialog).toBeHidden()
  })

  test('the backend refuses a SENIOR the manual create', async ({ page }) => {
    await loginViaApi(page, SEED_EMAILS.seniorA)
    const res = await page.request.post(`${REAL_API_BASE}/api/job-queue/manual`, {
      data: {
        title: prefill.title,
        companyName: prefill.company,
        descriptionMd: prefill.description,
        applicationUrl: prefill.url,
        submission: { teamId: TEAM, seniorId: SENIOR, resumeId: MOCK_IDS.submission },
      },
    })
    expect(res.status()).toBe(403)
  })

  test('the backend refuses a SENIOR the manual parse', async ({ page }) => {
    await loginViaApi(page, SEED_EMAILS.seniorA)
    const res = await page.request.post(`${REAL_API_BASE}/api/job-queue/manual/parse`, {
      data: { text: 'Senior Go developer wanted' },
    })
    expect(res.status()).toBe(403)
  })
})
