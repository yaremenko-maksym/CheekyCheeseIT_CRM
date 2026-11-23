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
 * sends, never what the server answers. A download is the browser's own request, which neither a
 * page nor a context route intercepts, so the spec asserts the download event (its URL, and one per
 * transition), not the file the server would name. The real-stack test proves the one thing a mock cannot:
 * the batch status route answers HR with 200 (it needs `TAILORED_RESUME_ENABLED=true` on the API).
 */

const OPP = MOCK_IDS.opportunity
const SENIOR = MOCK_IDS.seniorA
const RUN = '7e000000-0000-4000-8000-000000000001'
const RENDER_OLD = '7f000000-0000-4000-8000-000000000001'
const RENDER_NEW = '7f000000-0000-4000-8000-000000000002'
const PDF_PATH = `/api/job-queue/${OPP}/seniors/${SENIOR}/tailored/pdf`

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

const COVER_LETTER = 'Dear team, I build React apps.'

const PUBLISHED: Partial<TailoredResumeDetailDto> = {
  runStatus: 'SUCCEEDED',
  published: true,
  pdfStatus: 'READY',
  pdfRenderId: RENDER_OLD,
  coverLetter: COVER_LETTER,
  editable: {
    summary: 'Frontend engineer.',
    skills: ['React', 'TypeScript'],
    experience: [
      { company: 'Acme', role: 'Engineer', period: '2020–2024', bullets: ['Built the UI'] },
    ],
  },
  generatedAt: '2026-11-20T10:00:00.000Z',
}

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
    const downloads: string[] = []
    page.on('download', (d) => downloads.push(new URL(d.url()).pathname))

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
    expect(new URL((await firstDownload).url()).pathname).toBe(PDF_PATH)
    expect(writes[0]!.postDataJSON()).toEqual({ teamId: expect.any(String), overwrite: false })

    // copy: the letter reaches the clipboard and the toast confirms it
    await controls.getByRole('button', { name: assertInCatalog(uk, 'Копіювати лист') }).click()
    await expect(page.getByText(assertInCatalog(uk, 'Лист скопійовано'))).toBeVisible()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(COVER_LETTER)

    // edit: the PUT carries the edited fields; the new render downloads once more
    await controls.getByRole('button', { name: assertInCatalog(uk, 'Редагувати') }).click()
    // the card is a dialog too: name the edit dialog
    const dialog = page.getByRole('dialog', { name: assertInCatalog(uk, 'Редагувати CV і лист') })
    await dialog
      .getByLabel(assertInCatalog(uk, 'Підсумок'), { exact: true })
      .fill('Senior frontend engineer.')
    const editDownload = page.waitForEvent('download')
    await dialog.getByRole('button', { name: assertInCatalog(uk, 'Зберегти') }).click()
    await expect(dialog).toBeHidden()
    expect(new URL((await editDownload).url()).pathname).toBe(PDF_PATH)
    expect(writes[1]!.method()).toBe('PUT')
    expect(writes[1]!.postDataJSON()).toEqual({
      teamId: expect.any(String),
      summary: 'Senior frontend engineer.',
      skills: ['React', 'TypeScript'],
      bullets: [['Built the UI']],
      coverLetter: COVER_LETTER,
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
    expect(writes[2]!.postDataJSON()).toEqual({ teamId: expect.any(String), overwrite: true })
    // one download per transition seen: the run, the edit's render, the regenerated run
    await expect.poll(() => downloads, { timeout: 30_000 }).toEqual([PDF_PATH, PDF_PATH, PDF_PATH])
    await page.waitForTimeout(6000)
    expect(downloads).toHaveLength(3)
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
    // job-queue.spec's wave 2 submits and hides this row mid-run: find it in whichever tab holds it
    let tab: 'NEW' | 'SUBMITTED' | 'HIDDEN' = 'NEW'
    let row
    for (tab of ['NEW', 'SUBMITTED', 'HIDDEN'] as const) {
      row = await queueRow(page.request, SEED_QUEUE.reactPlatform, { teamId, tab })
      if (row) break
    }
    if (!row) throw new Error(`"${SEED_QUEUE.reactPlatform}" is not visible to HR A's team`)
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

    await page.goto(`/job-queue?tab=${tab}&teamId=${teamId}`)
    await page.getByTestId(`job-queue-row-${row.opportunityId}`).click()
    for (const id of ids) await expect(page.getByTestId(`tailored-${id}`)).toBeVisible()
  })
})
