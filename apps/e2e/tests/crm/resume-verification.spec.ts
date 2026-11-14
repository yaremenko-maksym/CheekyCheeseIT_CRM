/**
 * resume-verification.spec.ts — verified base resume Task 21: the check-and-confirm flow.
 *
 *   - HR fills facts, submits, confirms → VERIFIED badge: the UI walks the real state sequence
 *     DRAFT → QUEUED → CHECKING → AWAITING_CONFIRM → VERIFIED (each a polled GET), and the PUT
 *     facts / POST submit / POST confirm bodies are asserted;
 *   - SENIOR cannot confirm: no Confirm button on their own staged result (mocked), AND the
 *     running API answers 403 to a SENIOR's POST confirm (real, seeded user);
 *   - a facts edit after VERIFIED returns the badge to DRAFT;
 *   - 320 px: the facts form has no horizontal overflow.
 *
 * The writer, Jev and vision have no env-level stub in the API (ruling R61), so the UI half is
 * route-mocked on the DTO builders of senior-resume.spec.ts. Lives in `tests/crm/`: that prefix
 * is a CI shard's `files:` entry, so no ci.yml edit is needed.
 */
import { randomUUID } from 'node:crypto'
import { test, expect, type Page } from '@playwright/test'
import {
  USERS,
  mockAuthAs,
  buildHrViewingSenior,
  buildSelfView,
  API_GLOB,
  API_RE,
  REAL_API_BASE,
  SEED_EMAILS,
  loginViaApi,
} from '../fixtures'
import {
  DEFAULT_LAYOUT,
  json,
  mockResumeAssets,
  resumeResponse,
  type ResumeStub,
} from '../fixtures/senior-resume-mocks'
import { loadMessages, assertInCatalog } from '../../fixtures/catalog'

let uk: Record<string, string>
test.beforeAll(async () => {
  uk = await loadMessages('uk')
})

const SENIOR_ID = USERS.senior.id
type Answer = ReturnType<typeof resumeResponse>

/** Facts that pass every completeness rule (Latin, 5 skills, a job with a note, English). */
const COMPLETE_FACTS = {
  headline: 'Backend Engineer',
  location: { city: 'Kyiv', country: 'Ukraine' },
  workFormat: 'remote',
  skills: ['TypeScript', 'NestJS', 'PostgreSQL', 'Docker', 'React'],
  experience: [
    {
      company: 'Acme Payments',
      role: 'Backend Engineer',
      location: null,
      start: '2020-01',
      end: null,
      current: true,
      technologies: ['Node.js'],
      notes: ['Built the billing API'],
    },
  ],
  education: [],
  languages: [{ name: 'English', level: 'C1' }],
  links: [],
}

const STAGED = {
  runId: 'bbbbbbbb-0000-4000-8000-000000000001',
  content: {
    summary: 'Backend engineer with six years of TypeScript and NestJS.',
    skills: COMPLETE_FACTS.skills,
    experience: [
      {
        company: 'Acme Payments',
        role: 'Backend Engineer',
        period: '2020 — Present',
        bullets: ['Built the billing API'],
      },
    ],
    education: [],
    languages: [],
    links: [],
  },
  layout: DEFAULT_LAYOUT,
  templateName: 'classic',
  pdfAvailable: true,
  editedPaths: [],
}

const hr = (stub: ResumeStub) => resumeResponse({ facts: COMPLETE_FACTS, ...stub }, true, true)

/**
 * One route for GET resume and the three writes. GET serves `server.current`, which the test
 * moves forward itself (the tab polls while `verificationBusy`), so every state is observed
 * rather than skipped by a fast poll. A write records its body and answers with `next`.
 */
async function openResume(
  page: Page,
  viewer: 'hr' | 'senior',
  initial: Answer,
  next: { facts?: (facts: unknown) => Answer; submit?: Answer; confirm?: Answer } = {},
  locale: 'uk' | 'en' = 'uk',
) {
  const server = { current: initial, sent: [] as { path: string; body: unknown }[] }
  await mockAuthAs(page, { ...(viewer === 'hr' ? USERS.hr : USERS.senior), locale })
  await (viewer === 'hr'
    ? page.route(`${API_GLOB}/users/${SENIOR_ID}`, (r) =>
        r.fulfill(json(buildHrViewingSenior(USERS.senior))),
      )
    : page.route(`${API_GLOB}/users/me`, (r) => r.fulfill(json(buildSelfView(USERS.senior)))))
  await mockResumeAssets(page)
  await page.route(
    new RegExp(`${API_RE}/users/[^/?]+/resume(/facts|/submit|/confirm)?$`),
    async (route) => {
      const request = route.request()
      const path = new URL(request.url()).pathname.split('/resume')[1] ?? ''
      if (request.method() === 'GET' && path === '') return route.fulfill(json(server.current))
      const body = request.postDataJSON() as { facts?: unknown } | null
      server.sent.push({ path, body })
      const answer =
        path === '/facts'
          ? next.facts?.(body?.facts)
          : path === '/submit'
            ? next.submit
            : next.confirm
      if (!answer) return route.fulfill(json({ message: `unexpected ${path}` }, 500))
      server.current = answer
      return route.fulfill(json(answer))
    },
  )
  await page.goto(viewer === 'hr' ? `/profile/${SENIOR_ID}?tab=resume` : '/profile?tab=resume')
  return server
}

test.describe('Verified base resume — check and confirm', () => {
  test('HR fills facts, submits, confirms → VERIFIED badge', async ({ page }) => {
    const queued = hr({ version: 2, verificationStatus: 'QUEUED', verificationBusy: true })
    const server = await openResume(
      page,
      'hr',
      hr({ facts: { ...COMPLETE_FACTS, headline: '' } }),
      {
        facts: (facts) => hr({ facts: facts as typeof COMPLETE_FACTS, version: 2 }),
        submit: queued,
        confirm: hr({
          version: 3,
          content: STAGED.content,
          verificationStatus: 'VERIFIED',
          verifiedVersion: 3,
          verifiedAt: '2026-11-13T10:00:00.000Z',
          verifiedByName: USERS.hr.displayName,
        }),
      },
    )
    const badge = page.getByTestId('resume-verification-badge')
    await expect(badge).toContainText(assertInCatalog(uk, 'Чернетка'))
    const submit = page.getByTestId('resume-facts-submit')
    // The one missing fact keeps Submit closed until HR enters it.
    await expect(submit).toBeDisabled()
    await page.locator('input[name="resumeFactsHeadline"]').fill('Senior Backend Engineer')
    await submit.click()

    // Unsaved facts are saved first, then the check is requested (one action).
    await expect.poll(() => server.sent.map((s) => s.path)).toEqual(['/facts', '/submit'])
    expect(server.sent[0]?.body).toEqual({
      facts: { ...COMPLETE_FACTS, headline: 'Senior Backend Engineer' },
    })
    const progress = page.getByTestId('resume-verification-progress')
    await expect(progress).toContainText(assertInCatalog(uk, 'У черзі на перевірку'))
    await expect(page.locator('input[name="resumeFactsHeadline"]')).toBeDisabled()

    server.current = hr({ version: 2, verificationStatus: 'CHECKING', verificationBusy: true })
    await expect(progress).toContainText(assertInCatalog(uk, 'Перевіряємо резюме'))

    server.current = hr({ version: 2, verificationStatus: 'AWAITING_CONFIRM', staged: STAGED })
    await expect(page.getByTestId('resume-confirm-step')).toBeVisible()
    await expect(progress).toBeHidden()
    await expect(badge).toContainText(assertInCatalog(uk, 'Чекає підтвердження'))
    await page.getByTestId('resume-confirm').click()

    await expect(badge).toContainText(assertInCatalog(uk, 'Перевірено'))
    expect(server.sent[2]).toEqual({ path: '/confirm', body: { runId: STAGED.runId, version: 2 } })
    await expect(page.getByTestId('resume-verified-meta')).toContainText(USERS.hr.displayName)
    await expect(page.getByTestId('resume-confirm-step')).toBeHidden()
  })

  test.describe('SENIOR cannot confirm', () => {
    test('the UI shows no Confirm button on their own staged result', async ({ page }) => {
      await openResume(
        page,
        'senior',
        resumeResponse(
          {
            facts: COMPLETE_FACTS,
            version: 2,
            verificationStatus: 'AWAITING_CONFIRM',
            staged: STAGED,
          },
          true,
          false,
        ),
      )
      const step = page.getByTestId('resume-confirm-step')
      await expect(step).toBeVisible()
      await expect(step).toContainText(
        assertInCatalog(uk, 'Резюме підтверджує HR. Ви можете змінити факти й надіслати знову.'),
      )
      await expect(page.getByTestId('resume-confirm')).toHaveCount(0)
    })

    test('the API answers 403 to their POST confirm (real backend)', async ({ page }) => {
      await loginViaApi(page, SEED_EMAILS.seniorA)
      const me = await page.request.get(`${REAL_API_BASE}/api/users/me`)
      expect(me.status()).toBe(200)
      const { user } = (await me.json()) as { user: { id: string; role: string } }
      expect(user.role).toBe('SENIOR')
      const confirm = `${REAL_API_BASE}/api/users/${user.id}/resume/confirm`
      // A schema-valid body: the controller parses it, then the service's FIRST check is the role
      // (canConfirmResume) — before any row read, so neither 404 nor 409 can answer for it. The
      // target is the senior's OWN resume, which the general access rule allows: the 403 is the
      // confirm rule, not "not your resume".
      const body = { runId: randomUUID(), version: 0 }

      const refused = await page.request.post(confirm, { data: body })
      expect(refused.status()).toBe(403)

      // Control: the same call as ADMIN passes the role check and stops at the row/run check
      // (no resume row → 404; a row with another run → 409). A 403 for everyone would fail here.
      await loginViaApi(page, SEED_EMAILS.admin)
      const control = await page.request.post(confirm, { data: body })
      expect([404, 409]).toContain(control.status())
    })
  })

  test('facts edit after VERIFIED returns to DRAFT', async ({ page }) => {
    const verified: ResumeStub = {
      version: 3,
      verificationStatus: 'VERIFIED',
      verifiedVersion: 3,
      verifiedAt: '2026-11-13T10:00:00.000Z',
      verifiedByName: USERS.hr.displayName,
    }
    const server = await openResume(page, 'hr', hr(verified), {
      facts: (facts) =>
        hr({
          facts: facts as typeof COMPLETE_FACTS,
          version: 4,
          verificationStatus: 'DRAFT',
          verifiedVersion: 3,
        }),
    })
    const badge = page.getByTestId('resume-verification-badge')
    await expect(badge).toContainText(assertInCatalog(uk, 'Перевірено'))

    await page.locator('input[name="resumeFactsHeadline"]').fill('Staff Backend Engineer')
    await page.getByTestId('resume-facts-save').click()

    await expect(badge).toContainText(assertInCatalog(uk, 'Чернетка'))
    expect(server.sent).toEqual([
      {
        path: '/facts',
        body: { facts: { ...COMPLETE_FACTS, headline: 'Staff Backend Engineer' } },
      },
    ])
    await expect(page.locator('main')).toContainText(
      assertInCatalog(uk, 'Факти змінено. Надішліть резюме на перевірку знову.'),
    )
  })

  test('320 px has no horizontal overflow on the facts form', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 })
    await openResume(page, 'hr', hr({}))
    const form = page.getByTestId('resume-facts-form')
    await expect(form).toBeVisible()
    await expect(page.locator('input[name="resumeFactsCompany"]')).toHaveValue('Acme Payments')

    const overflow = await overflowOf(form)
    expect(overflow.page).toBeLessThanOrEqual(1)
    expect(overflow.outside).toEqual([])
    // FF2-3: the layout panel (template picker, toggles, section rows) fits 320 too.
    const panel = page.getByTestId('resume-layout-panel')
    await expect(panel).toBeVisible()
    const panelOverflow = await overflowOf(panel)
    expect(panelOverflow.outside).toEqual([])
    expect(await panel.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0)
  })

  for (const width of [320, 768]) {
    test(`${width} px has no horizontal overflow on the empty state`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await openResume(page, 'hr', resumeResponse(null, true, true))
      const intake = page.getByTestId('resume-intake')
      await expect(page.getByTestId('resume-fill-manually')).toBeVisible()

      const overflow = await overflowOf(intake)
      expect(overflow.page).toBeLessThanOrEqual(1)
      expect(overflow.outside).toEqual([])
      // The tiles themselves stay inside the viewport (QA-2: the right border was clipped at 344).
      const tilesRight = await intake.evaluate((el) =>
        Math.max(
          ...Array.from(el.querySelectorAll('div')).map((d) => d.getBoundingClientRect().right),
        ),
      )
      expect(tilesRight).toBeLessThanOrEqual(width)
      // FF2-1: every button, and what it paints (icon, label), stays inside its own tile.
      const tiles = page.getByTestId('resume-intake-tile')
      await expect(tiles).toHaveCount(2)
      const escaped = await tiles.evaluateAll((all) =>
        all.flatMap((tile) => {
          const box = tile.getBoundingClientRect()
          return Array.from(tile.querySelectorAll('button')).flatMap((button) => {
            const range = document.createRange()
            range.selectNodeContents(button)
            return [button.getBoundingClientRect(), range.getBoundingClientRect()]
              .filter((r) => r.left < box.left - 1 || r.right > box.right + 1)
              .map(() => button.textContent?.trim() ?? '')
          })
        }),
      )
      expect(escaped).toEqual([])
    })
  }

  test('768 px VERIFIED action bar does not scroll sideways', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 900 })
    await openResume(
      page,
      'hr',
      hr({
        version: 3,
        hasSourceFile: true,
        verificationStatus: 'VERIFIED',
        verifiedVersion: 3,
        verifiedAt: '2026-11-13T10:00:00.000Z',
        verifiedByName: USERS.hr.displayName,
      }),
    )
    const del = page.getByTestId('resume-delete')
    await expect(del).toBeVisible()

    const fit = await del.evaluate((button) => {
      const main = document.querySelector('main')
      const scrollers = [document.documentElement, main, main?.parentElement].filter(
        (el): el is HTMLElement => el instanceof HTMLElement,
      )
      return {
        sideways: Math.max(...scrollers.map((el) => el.scrollWidth - el.clientWidth)),
        right: button.getBoundingClientRect().right,
        edge: (main ?? document.documentElement).getBoundingClientRect().right,
      }
    })
    expect(fit.sideways).toBeLessThanOrEqual(1)
    expect(fit.right).toBeLessThanOrEqual(fit.edge)
  })

  // QA-6 for en: the longest en month ("September") and the en placeholder fit the trigger.
  for (const width of [320, 768, 1024, 1440]) {
    test(`${width} px en month and year triggers show the whole value and placeholder`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 })
      const [job] = COMPLETE_FACTS.experience
      const facts = {
        ...COMPLETE_FACTS,
        experience: [{ ...job, start: '2020-09', end: null, current: false }],
      }
      await openResume(page, 'hr', hr({ facts }), {}, 'en')
      const form = page.getByTestId('resume-facts-form')
      const triggers = form.locator('button[role="combobox"]')
      await expect(form.getByText('September', { exact: true })).toBeVisible()
      await expect(form.getByText('Month', { exact: true })).toBeVisible()

      // The text's own extent (a Range) ends inside its clipping span (not cut) and at least
      // 2 px before the chevron (not jammed against it).
      const fit = await triggers.evaluateAll((buttons) =>
        buttons.flatMap((button) => {
          const span = button.querySelector('span')
          const text = span?.textContent?.trim() ?? ''
          const chevron = button.querySelector('svg')
          if (!span || !chevron || !['September', 'Month', '2020', 'Year'].includes(text)) return []
          const range = document.createRange()
          range.selectNodeContents(span)
          const textRight = range.getBoundingClientRect().right
          // The month + year row stays inside its job grid (at 320 it once pushed the track 9 px out).
          const grid = button.closest('.grid')
          return [
            {
              text,
              cut: textRight - span.getBoundingClientRect().right > 0.5,
              gap: chevron.getBoundingClientRect().left - textRight,
              out: grid ? grid.scrollWidth - grid.clientWidth : -1,
            },
          ]
        }),
      )
      expect(fit.map((f) => f.text).sort()).toEqual(['2020', 'Month', 'September', 'Year'])
      expect(fit.filter((f) => f.cut || f.gap < 2 || f.out !== 0)).toEqual([])
    })
  }

  // Enough chips to wrap onto two rows at 320, so cross-row overlap is measured too.
  const TECHS = [
    'Node.js',
    'TypeScript',
    'PostgreSQL',
    'Redis',
    'Docker',
    'Kubernetes',
    'AWS',
    'GraphQL',
  ]

  // R65 (WCAG 2.5.8): a chip's remove target is at least 24 px, never covers its own label,
  // and never overlaps another chip's target (chips wrap onto two rows at 320).
  for (const width of [320, 1440]) {
    test(`${width} px skill chip remove targets cover no label and no other target`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 })
      const [job] = COMPLETE_FACTS.experience
      await openResume(
        page,
        'hr',
        hr({ facts: { ...COMPLETE_FACTS, experience: [{ ...job, technologies: TECHS }] } }),
      )
      const removes = page.getByTestId('resume-facts-form').getByTestId('tech-chip-remove')
      await expect(removes.first()).toBeVisible()

      const targets = await removes.evaluateAll((buttons) =>
        buttons.map((button) => {
          const box = button.getBoundingClientRect()
          const after = getComputedStyle(button, '::after')
          const rect = {
            left: box.left + parseFloat(after.left),
            right: box.right - parseFloat(after.right),
            top: box.top + parseFloat(after.top),
            bottom: box.bottom - parseFloat(after.bottom),
          }
          const label = button.previousElementSibling?.getBoundingClientRect() ?? null
          // A tap on the last pixel of the label lands on the label, not on the remove button.
          const labelEndHit = label
            ? document
                .elementFromPoint(label.right - 1, label.top + label.height / 2)
                ?.closest('button') === button
            : true
          return { rect, label, labelEndHit }
        }),
      )
      expect(targets.length).toBe(TECHS.length)
      // At 320 the chips wrap, so adjacent rows are part of the check.
      const rows = new Set(targets.map((t) => Math.round(t.rect.top))).size
      expect(rows).toBeGreaterThan(width === 320 ? 1 : 0)
      const overlap = (
        a: { left: number; right: number; top: number; bottom: number },
        b: { left: number; right: number; top: number; bottom: number },
      ) =>
        Math.min(a.right, b.right) > Math.max(a.left, b.left) &&
        Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top)
      for (const [i, { rect, label, labelEndHit }] of targets.entries()) {
        expect(rect.right - rect.left).toBeGreaterThanOrEqual(24)
        expect(rect.bottom - rect.top).toBeGreaterThanOrEqual(24)
        expect(label).not.toBeNull()
        expect(label && overlap(rect, label)).toBe(false)
        expect(labelEndHit).toBe(false)
        for (const other of targets.slice(i + 1)) expect(overlap(rect, other.rect)).toBe(false)
      }
    })
  }
})

/** Page-level scroll plus every control that pokes out of `scope` (stays on screen but clipped). */
function overflowOf(scope: ReturnType<Page['getByTestId']>) {
  return scope.evaluate((root) => {
    const edge = root.getBoundingClientRect().right + 1
    const outside = Array.from(root.querySelectorAll('button, input, textarea, select'))
      .filter((el) => el.getBoundingClientRect().right > edge)
      .map((el) => el.textContent?.trim() || el.getAttribute('name') || el.tagName)
    const doc = document.documentElement
    return { page: doc.scrollWidth - doc.clientWidth, outside }
  })
}
