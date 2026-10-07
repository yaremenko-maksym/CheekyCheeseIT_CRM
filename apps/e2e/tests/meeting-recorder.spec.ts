import { test, expect, API_RE, INTERVIEWS, type Page, type Route } from './fixtures'

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111'
const RECORDING_ID = '22222222-2222-4222-8222-222222222222'
const INTERVIEW_ID = '33333333-3333-4333-8333-333333333333'

const connection = {
  id: CONNECTION_ID,
  name: 'Recruiting recorder',
  enabled: true,
  secretSet: false,
  expectedSource: null,
  signingSecretUpdatedAt: null,
  lastVerifiedAt: null,
  lastEventAt: null,
  createdAt: '2026-10-07T18:00:00.000Z',
  updatedAt: '2026-10-07T18:00:00.000Z',
  webhookPath: `/api/public/integrations/meeting-recorder/${CONNECTION_ID}/events`,
}

const recordingSummary = {
  id: RECORDING_ID,
  interviewId: INTERVIEW_ID,
  connectionId: CONNECTION_ID,
  externalRecordingId: 'recording-external-1',
  revision: 2,
  title: 'Acme technical interview',
  startedAt: '2026-10-07T17:00:00.000Z',
  endedAt: '2026-10-07T17:42:00.000Z',
  durationMs: 2_520_000,
  provider: 'google-meet',
  meetingId: 'abc-defg-hij',
  meetingUrl: 'https://meet.google.com/abc-defg-hij',
  stageAtLink: 'HR_SCREEN',
  matchedBy: 'meeting-url' as const,
  readiness: { complete: true, release: 'complete' as const, pending: [] },
  linkedByUserId: null,
  linkedAt: '2026-10-07T17:43:00.000Z',
  lastEventAt: '2026-10-07T17:43:00.000Z',
  createdAt: '2026-10-07T17:43:00.000Z',
  updatedAt: '2026-10-07T17:43:00.000Z',
}

const recordingDetail = {
  ...recordingSummary,
  snapshot: {
    id: 'recording-external-1',
    title: 'Acme technical interview',
    startedAt: '2026-10-07T17:00:00.000Z',
    endedAt: '2026-10-07T17:42:00.000Z',
    durationMs: 2_520_000,
    source: {
      kind: 'meeting' as const,
      provider: 'google-meet',
      meetingId: 'abc-defg-hij',
      meetingUrl: 'https://meet.google.com/abc-defg-hij',
    },
    transcript: {
      source: 'meet-captions' as const,
      segments: [
        {
          tStartMs: 1_000,
          tEndMs: 4_500,
          speaker: 'Candidate',
          text: 'Sensitive transcript stays plain text.',
        },
      ],
    },
    analysis: {
      status: 'completed' as const,
      topics: [
        { keywords: ['React'], importance: 0.9, spans: [{ tStartMs: 1_000, tEndMs: 4_500 }] },
      ],
    },
  },
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

async function openInterviewSheet(page: Page, companyName: string) {
  await expect(page.getByTestId('interviews-page')).toBeVisible()
  const companyNameText = page.getByText(companyName, { exact: true }).first()
  await expect(companyNameText).toBeVisible()
  await companyNameText.click()
  const sheet = page.getByTestId('interview-detail-sheet')
  await expect(sheet).toBeVisible()
  return sheet
}

test.describe('Meeting Recorder CRM UI', () => {
  test('ADMIN creates a connection and configures its write-only signing secret', async ({
    asAdmin: page,
  }) => {
    let connections: Array<typeof connection> = []

    await page.route(
      new RegExp(`${API_RE}/integrations/meeting-recorder/connections$`),
      (route) => {
        if (route.request().method() === 'GET') return json(route, connections)
        if (route.request().method() === 'POST') {
          connections = [connection]
          return json(route, connection, 201)
        }
        return route.fallback()
      },
    )
    await page.route(
      new RegExp(`${API_RE}/integrations/meeting-recorder/connections/${CONNECTION_ID}/secret$`),
      (route) => {
        connections = [
          {
            ...connection,
            secretSet: true,
            updatedAt: '2026-10-07T18:01:00.000Z',
          },
        ]
        return json(route, connections[0])
      },
    )

    await page.goto('/admin/integrations')
    const emptyState = page.getByText('Підключень Meeting Recorder поки немає').locator('..')
    await expect(emptyState).toBeVisible()
    await emptyState.getByRole('button', { name: 'Додати підключення' }).click()

    const createDialog = page.getByRole('dialog', { name: 'Додати підключення' })
    await expect(createDialog).toBeVisible()
    await createDialog.getByLabel('Назва').fill('Recruiting recorder')
    await createDialog
      .getByLabel('Signing secret')
      .fill(`whsec_${Buffer.alloc(32, 7).toString('base64')}`)
    await createDialog.getByRole('button', { name: 'Створити' }).click()

    await expect(page.getByText('Recruiting recorder')).toBeVisible()
    await expect(page.getByText('Секрет налаштовано')).toBeVisible()
    await expect(page.getByLabel('Signing secret')).toHaveCount(0)
  })

  test('ADMIN links an unmatched recording and the removed row yields focus to the page heading', async ({
    asAdmin: page,
  }) => {
    let unmatched = [{ ...recordingSummary, interviewId: null, matchedBy: 'unmatched' as const }]
    const linkTarget = { ...INTERVIEWS[0], id: INTERVIEW_ID, notesCorpTech: null }

    await page.route(new RegExp(`${API_RE}/interview-recordings/unmatched$`), (route) =>
      json(route, unmatched),
    )
    await page.route(
      (url) => url.pathname.endsWith('/interviews') && url.searchParams.has('seniorId'),
      (route) => json(route, [linkTarget]),
    )
    await page.route(
      new RegExp(`${API_RE}/interview-recordings/${RECORDING_ID}/link$`),
      (route) => {
        unmatched = []
        return route.fulfill({ status: 204 })
      },
    )

    await page.goto('/interviews/unmatched')
    await expect(page.getByText('Acme technical interview')).toBeVisible()
    await page.getByRole('button', { name: "Прив'язати" }).click()
    const linkDialog = page.getByRole('dialog', { name: "Прив'язати запис до співбесіди" })
    await linkDialog.getByLabel('Сеньйор').selectOption({ label: 'Senior Dev' })
    await linkDialog.getByRole('radio', { name: /Acme Corp/ }).click()
    await linkDialog.getByRole('button', { name: "Прив'язати" }).click()

    await expect(page.getByText("Неприв'язаних записів немає")).toBeVisible()
    await expect(page.getByRole('heading', { name: "Неприв'язані записи" })).toBeFocused()
  })

  test('SENIOR opens a linked recording from the interview sheet without admin link controls', async ({
    asSenior: page,
  }) => {
    await page.route(new RegExp(`${API_RE}/interviews/interview-1-id/recordings$`), (route) =>
      json(route, [recordingSummary]),
    )
    await page.route(new RegExp(`${API_RE}/interview-recordings/${RECORDING_ID}$`), (route) =>
      json(route, recordingDetail),
    )

    await page.goto('/interviews')
    const sheet = await openInterviewSheet(page, 'Acme Corp')
    await expect(sheet.getByText('Acme technical interview')).toBeVisible()
    await sheet.getByRole('button', { name: 'Відкрити' }).click()

    await expect(page.getByText('Sensitive transcript stays plain text.')).toBeVisible()
    await expect(page.getByText('React', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: "Відв'язати" })).toHaveCount(0)
    await expect(page.getByRole('button', { name: "Переприв'язати" })).toHaveCount(0)
  })
})
