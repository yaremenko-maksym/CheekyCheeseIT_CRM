/**
 * landing/contact-and-hiring.spec.ts — task-landing-contact-and-hiring-strip.md
 * AC1 (no mailto: in CTAs), AC3-4 (honeypot mimics success through the REAL
 * `/api/public/contact` endpoint — Turnstile/Resend are never reached on
 * that path, so this exercises real HTTP without needing a live Turnstile
 * widget or a real Resend key), AC6 (hiring strip show/hide/persist/re-show).
 *
 * Opt-in `landing` project (same pattern as `responsive.spec.ts`/
 * `motion-v3.spec.ts`). Requires an externally started `apps/landing` dev
 * server (default `:3002`, override via `LANDING_BASE_URL`) proxying to a
 * real API instance.
 *
 * `GET /api/public/vacancies` is intercepted via `page.route()` for the
 * HiringStrip describe block ONLY — deterministic count control without
 * writing/cleaning up rows in the shared scratch DB (every other describe
 * block here hits the real backend, same convention as the rest of this
 * project's `landing` shard).
 */
import { test, expect, type Page } from '@playwright/test'

async function gotoStable(page: Page, path: string) {
  await page.goto(path)
  await page.waitForSelector('footer', { state: 'visible' })
}

async function mockVacancyCount(page: Page, count: number) {
  const vacancies = Array.from({ length: count }, (_, i) => ({
    id: `e2e-mock-${i}`,
    slug: `e2e-mock-vacancy-${i}`,
    title: `E2E Mock Role ${i}`,
    domain: 'AI',
    seniority: 'SENIOR',
    employmentType: 'FULL_TIME',
    location: 'Remote',
    publishedAt: new Date().toISOString(),
    isFallback: false,
  }))
  await page.route('**/api/public/vacancies*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(vacancies),
    }),
  )
}

test.describe('AC1 — "Start a project" CTAs have no mailto: href', () => {
  test('nav + hero CTAs scroll to #contact instead of opening a mail client', async ({ page }) => {
    await gotoStable(page, '/')

    const navCta = page.locator('header').getByRole('link', { name: 'Start a project' })
    await expect(navCta).toHaveAttribute('href', /#contact$/)

    const heroCta = page.locator('main').getByRole('link', { name: 'Start a project' }).first()
    await expect(heroCta).toHaveAttribute('href', '#contact')

    // The footer's former mailto CTAs now scroll/link to #contact too — the
    // ONLY mailto: left on the page is the small fallback link inside the
    // contact form itself (asserted in the next describe block).
    const footerContact = page.locator('footer').getByRole('link', { name: 'Contact', exact: true })
    await expect(footerContact).toHaveAttribute('href', /#contact$/)
    const footerGetInTouch = page
      .locator('footer')
      .getByRole('link', { name: 'hr@cheekycheese.tech' })
    await expect(footerGetInTouch).toHaveAttribute('href', /#contact$/)
  })
})

test.describe('Contact form', () => {
  test('empty submit shows field errors, never calls the API', async ({ page }) => {
    await gotoStable(page, '/')
    let requestFired = false
    await page.route('**/api/public/contact', (route) => {
      requestFired = true
      return route.continue()
    })

    await page.getByRole('button', { name: 'Send message' }).click()

    await expect(page.getByText('Please enter your name.')).toBeVisible()
    await expect(page.getByText('Enter a valid email.')).toBeVisible()
    await expect(page.getByText('Tell us a bit more (at least 10 characters).')).toBeVisible()
    expect(requestFired).toBe(false)
  })

  test('the hr@cheekycheese.tech fallback link is always visible under the submit button', async ({
    page,
  }) => {
    await gotoStable(page, '/')
    // Scoped to `#contact` — `main` also contains the (unrelated, pre-
    // existing) CareersTeaser empty-state "hr@cheekycheese.tech" button when
    // there are 0 PUBLISHED vacancies, same accessible name → strict-mode
    // collision without this scope.
    const fallback = page.locator('#contact').getByRole('link', { name: 'hr@cheekycheese.tech' })
    await expect(fallback).toBeVisible()
    await expect(fallback).toHaveAttribute('href', 'mailto:hr@cheekycheese.tech')
  })

  test('honeypot filled → real /api/public/contact call still returns success (201), form shows the success screen', async ({
    page,
  }) => {
    await gotoStable(page, '/')

    // No `exact: true` — the visible `*` marker is `aria-hidden`, so the
    // computed accessible name may or may not include it depending on the
    // engine; substring matching (Playwright's default) is correct either
    // way and unambiguous (no other field starts with these words).
    await page.getByLabel('Name').fill('E2E Bot Check')
    await page.getByLabel('Email').fill('e2e-bot@example.com')
    await page
      .getByLabel('What are you building?')
      .fill('This message should never actually be emailed — honeypot path.')
    // The honeypot input is intentionally `display:none` (Playwright's
    // `.fill()` refuses to act on an invisible element, by design) — set the
    // value + dispatch a real `input` event via the React-controlled-input
    // native-setter trick, mirroring what a naive bot's programmatic
    // form-autofill would actually do (never a real visible interaction).
    await page.locator('input[name="website"]').evaluate((el: HTMLInputElement) => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )!.set!
      nativeSetter.call(el, 'http://spam.example')
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const [response] = await Promise.all([
      page.waitForResponse('**/api/public/contact'),
      page.getByRole('button', { name: 'Send message' }).click(),
    ])
    expect(response.status()).toBe(201)
    await expect(page.getByRole('status')).toContainText('Message received')
  })
})

test.describe('AC6 — hiring strip', () => {
  test('0 vacancies — strip is entirely absent from the DOM', async ({ page }) => {
    await mockVacancyCount(page, 0)
    await gotoStable(page, '/')
    await expect(page.getByRole('button', { name: 'Dismiss' })).toHaveCount(0)
  })

  test('N>0 — shows the count and links to /careers/; closing it persists across reload', async ({
    page,
  }) => {
    await mockVacancyCount(page, 4)
    await gotoStable(page, '/')

    const link = page.getByRole('link', { name: /We're hiring — 4 open positions/ })
    await expect(link).toBeVisible()
    await expect(link).toHaveAttribute('href', /\/careers\/?$/)

    await page.getByRole('button', { name: 'Dismiss' }).click()
    await expect(link).toHaveCount(0)

    // Reload with the SAME mocked count — stays dismissed (task AC6:
    // "закрытие запоминается").
    await gotoStable(page, '/')
    await expect(page.getByRole('link', { name: /We're hiring — 4 open positions/ })).toHaveCount(0)
  })

  test('count changes after a dismissal — the strip reappears with the new number', async ({
    page,
  }) => {
    await mockVacancyCount(page, 4)
    await gotoStable(page, '/')
    await page.getByRole('button', { name: 'Dismiss' }).click()
    await expect(page.getByRole('link', { name: /We're hiring/ })).toHaveCount(0)

    // Same browser context (localStorage persists) — a DIFFERENT count now.
    await mockVacancyCount(page, 7)
    await gotoStable(page, '/')
    await expect(page.getByRole('link', { name: /We're hiring — 7 open positions/ })).toBeVisible()
  })

  test('also renders on /careers/ (not home-only)', async ({ page }) => {
    await mockVacancyCount(page, 2)
    await gotoStable(page, '/careers/')
    await expect(page.getByRole('link', { name: /We're hiring — 2 open positions/ })).toBeVisible()
  })
})
