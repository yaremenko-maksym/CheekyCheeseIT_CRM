import type { Page, Request } from '@playwright/test'
import { test, expect, loginViaApi, REAL_API_BASE, SEED_EMAILS } from './fixtures'
import { loadMessages, assertInCatalog } from '../fixtures/catalog'
import { API_RE } from './fixtures/route-helpers'
import {
  tailoredResumeDetailSchema,
  tailoredResumeRowSchema,
  type TailoredResumeDetailDto,
} from '../../../packages/shared/src/schemas/tailored-resume'
import {
  MOCK_IDS,
  SEED_QUEUE,
  SEED_TEAMS,
  mockJobQueue,
  queueCard,
  queueRow,
  teamIdByName,
} from '../fixtures/job-queue'

/**
 * Tailored CV + cover letter controls on the queue card — tailored resume plan Task 13 (spec §4).
 *
 * The mocked block drives the whole HR flow on canned answers (every body `.parse()`d against the
 * `@crm/shared` tailored-resume schemas): generate → stage text → one download → copy → edit → one
 * download of the new render → regenerate behind a confirmation. It proves what the UI draws and
 * sends, never what the server answers. The real-stack test proves the one thing a mock cannot:
 * the batch status route answers HR with 200 (it needs `TAILORED_RESUME_ENABLED=true` on the API).
 */

const OPP = MOCK_IDS.opportunity
const SENIOR = MOCK_IDS.seniorA
const RUN = '7e000000-0000-4000-8000-000000000001'
const RENDER_OLD = '7f000000-0000-4000-8000-000000000001'
const RENDER_NEW = '7f000000-0000-4000-8000-000000000002'
const PDF_NAME = 'Senior_Alpha_CV.pdf'

function detail(over: Partial<TailoredResumeDetailDto> = {}): TailoredResumeDetailDto {
  return tailoredResumeDetailSchema.parse({
    seniorId: SENIOR,
    eligibility: 'READY',
    runStatus: null,
    runStage: null,
    runErrorCode: null,
    published: false,
    pdfStatus: 'IDLE',
    pdfRenderId: null,
    baseChanged: false,
    coverLetter: null,
    editable: null,
    summary: null,
    generatedAt: null,
    editedAt: null,
    ...over,
  })
}

const PUBLISHED = {
  runStatus: 'SUCCEEDED',
  published: true,
  pdfStatus: 'READY',
  pdfRenderId: RENDER_OLD,
  coverLetter: 'Dear team, I build React apps.',
  editable: {
    summary: 'Frontend engineer.',
    skills: ['React', 'TypeScript'],
    experience: [
      { company: 'Acme', role: 'Engineer', period: '2020–2024', bullets: ['Built the UI'] },
    ],
  },
  generatedAt: '2026-11-20T10:00:00.000Z',
} as const

/**
 * The tailored routes on top of `mockJobQueue` (registered later, so they win). The per-senior GET
 * answers a queue the last write armed (the last answer repeats); the batch GET answers the state
 * the per-senior GET last served, so both reads agree.
 */
async function mockTailored(page: Page) {
  let current = detail()
  let queue: TailoredResumeDetailDto[] = []
  const writes: Request[] = []
  const json = (body: unknown, status = 200) => ({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
  const senior = `${API_RE}/job-queue/${OPP}/seniors/${SENIOR}/tailored`

  await page.route(new RegExp(`${API_RE}/job-queue/${OPP}/tailored(\\?|$)`), (r) =>
    r.fulfill(json([tailoredResumeRowSchema.parse(current)])),
  )
  await page.route(new RegExp(`${senior}(\\?|$)`), (r) => {
    const method = r.request().method()
    if (method === 'GET') {
      if (queue.length > 0) current = queue.length > 1 ? queue.shift()! : queue[0]!
      return r.fulfill(json(current))
    }
    writes.push(r.request())
    if (method === 'POST') {
      queue = [detail({ runStatus: 'RUNNING', runStage: 'TAILORING' }), detail({ ...PUBLISHED })]
      return r.fulfill(json({ runId: RUN }, 202))
    }
    queue = [
      detail({ ...PUBLISHED, pdfStatus: 'RUNNING', pdfRenderId: RENDER_NEW }),
      detail({ ...PUBLISHED, pdfRenderId: RENDER_NEW, editedAt: '2026-11-20T11:00:00.000Z' }),
    ]
    return r.fulfill(json({ renderId: RENDER_NEW }, 202))
  })
  await page.route(new RegExp(`${senior}/pdf(\\?|$)`), (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/pdf',
      headers: { 'Content-Disposition': `attachment; filename="${PDF_NAME}"` },
      body: '%PDF-1.4\n%mock\n',
    }),
  )
  return { writes }
}

test.describe('tailored resume controls (mocked)', () => {
  // two 5 s polls per transition, three transitions
  test.setTimeout(90_000)

  test('HR generates, downloads, copies, edits and regenerates the tailored CV', async ({
    asHr: page,
  }) => {
    const uk = await loadMessages('uk')
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await mockJobQueue(page)
    const { writes } = await mockTailored(page)

    await page.goto('/job-queue')
    await page.getByTestId(`job-queue-row-${OPP}`).click()
    const controls = page.getByTestId(`tailored-${SENIOR}`)
    await expect(controls).toBeVisible()

    // generate: the stage text, then exactly one download once the run succeeds
    const firstDownload = page.waitForEvent('download')
    await controls
      .getByRole('button', { name: assertInCatalog(uk, 'Згенерувати CV і лист') })
      .click()
    await expect(controls.getByRole('status')).toContainText(
      assertInCatalog(uk, 'Адаптуємо резюме…'),
    )
    expect((await firstDownload).suggestedFilename()).toBe(PDF_NAME)
    expect(writes[0]!.postDataJSON()).toEqual({ overwrite: false })

    // copy: the letter reaches the clipboard and the toast confirms it
    await controls.getByRole('button', { name: assertInCatalog(uk, 'Копіювати лист') }).click()
    await expect(page.getByText(assertInCatalog(uk, 'Лист скопійовано'))).toBeVisible()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(PUBLISHED.coverLetter)

    // edit: the PUT carries the edited fields; the new render downloads once more
    await controls.getByRole('button', { name: assertInCatalog(uk, 'Редагувати') }).click()
    const dialog = page.getByRole('dialog')
    await dialog
      .getByLabel(assertInCatalog(uk, 'Підсумок'), { exact: true })
      .fill('Senior frontend engineer.')
    const editDownload = page.waitForEvent('download')
    await dialog.getByRole('button', { name: assertInCatalog(uk, 'Зберегти') }).click()
    await expect(dialog).toBeHidden()
    expect((await editDownload).suggestedFilename()).toBe(PDF_NAME)
    expect(writes[1]!.method()).toBe('PUT')
    expect(writes[1]!.postDataJSON()).toEqual({
      summary: 'Senior frontend engineer.',
      skills: ['React', 'TypeScript'],
      bullets: [['Built the UI']],
      coverLetter: PUBLISHED.coverLetter,
    })

    // regenerate: nothing is sent until HR confirms the replacement
    await controls.getByRole('button', { name: assertInCatalog(uk, 'Перегенерувати') }).click()
    const confirm = page.getByRole('alertdialog')
    await expect(confirm).toContainText(
      assertInCatalog(uk, 'Це замінить поточне CV і супровідний лист, разом із вашими правками.'),
    )
    expect(writes).toHaveLength(2)
    await confirm.getByRole('button', { name: assertInCatalog(uk, 'Замінити') }).click()
    await expect.poll(() => writes.length).toBe(3)
    expect(writes[2]!.postDataJSON()).toEqual({ overwrite: true })
  })

  test('the batch GET answers 404 (feature off): the card shows no controls and no error', async ({
    asHr: page,
  }) => {
    await mockJobQueue(page)
    let batches = 0
    await page.route(new RegExp(`${API_RE}/job-queue/${OPP}/tailored(\\?|$)`), (r) => {
      batches += 1
      return r.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ statusCode: 404, message: 'Not Found' }),
      })
    })
    await page.goto('/job-queue')
    await page.getByTestId(`job-queue-row-${OPP}`).click()
    await expect(page.getByTestId(`job-queue-senior-${SENIOR}`)).toBeVisible()
    await expect.poll(() => batches).toBe(1)
    await expect(page.getByTestId(`tailored-${SENIOR}`)).toHaveCount(0)
    await expect(page.getByTestId('job-queue-card').getByRole('alert')).toHaveCount(0)
  })
})

test.describe('tailored resume batch status (real API)', () => {
  test('HR’s batch GET answers 200 with one row per named senior; the card draws the controls', async ({
    page,
  }) => {
    await loginViaApi(page, SEED_EMAILS.hrA)
    const teamId = await teamIdByName(page.request, SEED_TEAMS.kovalenko)
    const row = await queueRow(page.request, SEED_QUEUE.reactPlatform, { teamId })
    if (!row) throw new Error(`"${SEED_QUEUE.reactPlatform}" is not in HR A's «Нові» tab`)
    const api = await queueCard(page.request, row.opportunityId, { teamId })
    const ids = api.seniors.items.map((s) => s.seniorId)
    expect(ids.length).toBeGreaterThan(0)

    const res = await page.request.get(
      `${REAL_API_BASE}/api/job-queue/${row.opportunityId}/tailored`,
      { params: { teamId, seniorIds: ids.join(',') } },
    )
    expect(res.status()).toBe(200)
    const rows = tailoredResumeRowSchema.array().parse(await res.json())
    expect(rows.map((r) => r.seniorId).sort()).toEqual([...ids].sort())

    await page.goto('/job-queue')
    await page.getByTestId(`job-queue-row-${row.opportunityId}`).click()
    for (const id of ids) await expect(page.getByTestId(`tailored-${id}`)).toBeVisible()
  })
})
