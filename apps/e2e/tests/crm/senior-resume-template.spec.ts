/**
 * senior-resume-template.spec.ts — verified base resume Task 20: the template
 * picker in the layout panel (design §5.6).
 *
 *   - on a DRAFT row a pick is a plain save: `PUT template` with the name;
 *   - on a VERIFIED row a pick starts a template run: the busy line shows, the
 *     picker locks, and the previous PDF stays downloadable.
 *
 * Route-mocked like senior-resume.spec.ts (that file is at its 800-line cap,
 * so these cases live here). Same `tests/crm/` prefix, so the same CI shard.
 */
import { test, expect, type Page } from '@playwright/test'
import { USERS, mockAuthAs, buildAdminViewingUser, API_GLOB, API_RE } from '../fixtures'
import { loadMessages, assertInCatalog } from '../../fixtures/catalog'
import { EMPTY_FACTS, json, resumeResponse, type ResumeStub } from '../fixtures/senior-resume-mocks'

let uk: Record<string, string>
test.beforeAll(async () => {
  uk = await loadMessages('uk')
})

const SENIOR_ID = USERS.senior.id

/** The row these cases start from; each case overrides the verification half. */
const BASE: ResumeStub = {
  content: {
    summary: 'Senior developer with eight years of experience.',
    skills: ['TypeScript'],
    experience: [],
    education: [],
    languages: [],
    links: [],
  },
  version: 3,
  facts: { ...EMPTY_FACTS, headline: 'Backend Engineer' },
}

function resume(stub: ResumeStub = {}) {
  return resumeResponse({ ...BASE, ...stub }, true, true)
}

const VERIFIED = {
  verificationStatus: 'VERIFIED',
  verifiedVersion: 3,
  verifiedAt: '2026-11-10T11:00:00.000Z',
  verifiedByName: 'Hanna HR',
}

/**
 * GET answers the current server state; PUT template records its body and
 * moves the server to `afterPut`. The PDF is mocked too: an unmocked call in CI
 * gets a 401 and the interceptor logs the page out (see senior-resume.spec.ts).
 */
async function openResume(
  page: Page,
  initial: ReturnType<typeof resume>,
  afterPut: ReturnType<typeof resume>,
): Promise<{ bodies: unknown[] }> {
  const bodies: unknown[] = []
  let current = initial
  await mockAuthAs(page, USERS.admin)
  await page.route(`${API_GLOB}/users/${SENIOR_ID}`, (r) =>
    r.fulfill(json(buildAdminViewingUser(USERS.senior))),
  )
  await page.route(new RegExp(`${API_RE}/users/([^/?]+)/resume$`), (route) =>
    route.fulfill(json(current)),
  )
  await page.route(new RegExp(`${API_RE}/users/([^/?]+)/resume/template$`), async (route) => {
    bodies.push(route.request().postDataJSON())
    current = afterPut
    await route.fulfill(json(afterPut))
  })
  await page.route(new RegExp(`${API_RE}/users/([^/?]+)/resume/pdf$`), (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/pdf',
      body: '%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF',
    }),
  )
  await page.goto(`/profile/${SENIOR_ID}?tab=resume`)
  return { bodies }
}

test.describe('Resume — template picker', () => {
  test('on a DRAFT row a pick sends PUT template with the name', async ({ page }) => {
    const { bodies } = await openResume(page, resume(), resume({ templateName: 'modern' }))
    const picker = page.getByTestId('resume-template-picker')
    await expect(picker.getByRole('radio')).toHaveCount(4)
    await expect(page.getByTestId('resume-template-classic')).toHaveAttribute(
      'aria-checked',
      'true',
    )

    await page.getByTestId('resume-template-modern').click()

    await expect.poll(() => bodies.length).toBe(1)
    expect(bodies[0]).toEqual({ templateName: 'modern' })
    await expect(page.getByTestId('resume-template-modern')).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId('resume-template-modern')).toContainText(
      assertInCatalog(uk, 'Поточний'),
    )
  })

  test('on a VERIFIED row a pick starts the check and keeps the previous PDF', async ({ page }) => {
    const { bodies } = await openResume(
      page,
      resume(VERIFIED),
      resume({ ...VERIFIED, verificationBusy: true }),
    )
    await expect(page.getByTestId('resume-download-pdf')).toBeVisible()

    await page.getByTestId('resume-template-technical').click()

    await expect.poll(() => bodies.length).toBe(1)
    expect(bodies[0]).toEqual({ templateName: 'technical' })
    await expect(page.getByTestId('resume-verification-template-run')).toContainText(
      assertInCatalog(uk, 'Перевіряємо нове оформлення'),
    )
    await expect(page.getByTestId('resume-download-pdf')).toHaveAttribute(
      'href',
      /\/users\/[^/]+\/resume\/pdf$/,
    )
    // aria-disabled, not native: the picked tile keeps focus through the run.
    await expect(page.getByTestId('resume-template-technical')).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    await expect(page.getByTestId('resume-template-technical')).toBeFocused()
    await expect(page.getByTestId('resume-template-picker')).toContainText(
      assertInCatalog(uk, 'Шаблон можна змінити після перевірки.'),
    )
    await expect(page.getByTestId('resume-layout-busy')).toBeVisible()
  })
})
