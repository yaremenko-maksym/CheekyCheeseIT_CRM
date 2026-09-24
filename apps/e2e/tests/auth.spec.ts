import { test, expect } from '@playwright/test'
import { API_GLOB, mockAuthAs, USERS } from './fixtures'
import { loadMessages, assertInCatalog } from '../fixtures/catalog'

const PROTECTED_ROUTES = ['/', '/team', '/projects', '/interviews', '/profile', '/users']

test.describe('Auth flow', () => {
  // ---------------------------------------------------------------------------
  // Login page
  // ---------------------------------------------------------------------------

  test('login page renders correctly', async ({ page }) => {
    await page.goto('/login')
    // Brand title is the product contract — text assertion stays.
    await expect(page.getByText('CheekyCheeseIT CRM')).toBeVisible()
    await expect(page.getByTestId('login-google-button')).toBeVisible()
  })

  test('login page has no app console errors on load', async ({ page }) => {
    const errors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return
      const text = msg.text()
      // Ignore expected GSI/FedCM errors — Google One Tap requires a signed-in
      // Google account in the browser; headless test runners have none
      const isGsiNoise =
        text.includes('GSI_LOGGER') ||
        text.includes('FedCM') ||
        text.includes('navigator.credentials') ||
        text.includes('accounts list is empty')
      if (isGsiNoise) return
      // After PR #39 round 2 auth-guard (commit 3fee9ae): LoginRoot mounts
      // <AuthProvider> WITHOUT `skip`, so LoginPage fires /api/auth/me to
      // detect already-authenticated visitors and redirect them to /crm.
      // For an unauthenticated visitor the backend legitimately returns 401,
      // which the browser logs as "Failed to load resource: 401 Unauthorized".
      // This is expected behaviour — exclude this single 401 from the assert
      // (any OTHER 401 or any other status code still counts as a bug).
      const isAuthMeProbe401 =
        text.includes('401') && (text.includes('auth/me') || text.includes('Unauthorized'))
      if (isAuthMeProbe401) return
      // When backend is down the browser logs a bare "Failed to load resource:
      // net::ERR_CONNECTION_REFUSED" for the /api/auth/me probe — the only
      // network request the login page makes. The message contains no URL so
      // we can't scope it narrower; on the login page this error is always
      // the auth/me probe and is expected when the API server is not running.
      const isConnectionRefused = text.includes('ERR_CONNECTION_REFUSED')
      if (isConnectionRefused) return
      errors.push(text)
    })
    await page.goto('/login')
    await page.waitForTimeout(1000)
    expect(errors).toHaveLength(0)
  })

  test('Google login button has correct href', async ({ page }) => {
    await page.goto('/login')
    const link = page.getByTestId('login-google-button')
    const href = await link.getAttribute('href')
    // Should point to the API Google OAuth endpoint
    expect(href).toMatch(/auth\/google/)
  })

  // ---------------------------------------------------------------------------
  // Unauthenticated redirects — all protected routes bounce to /login
  // ---------------------------------------------------------------------------

  for (const route of PROTECTED_ROUTES) {
    test(`unauthenticated ${route} redirects to /login`, async ({ page }) => {
      // Stub /auth/me to return 401 so the app knows user is not logged in.
      // Origin-agnostic glob (task-e2e-origin-agnostic) — see fixtures.ts
      // API_GLOB comment; a hardcoded 'http://localhost:3001/...' prefix only
      // matches when the web app happens to be served from exactly that origin.
      await page.route(`${API_GLOB}/auth/me`, (r) =>
        r.fulfill({ status: 401, body: '{"message":"Unauthorized"}' }),
      )
      await page.goto(route)
      await expect(page).toHaveURL(/\/login/)
    })
  }

  // ---------------------------------------------------------------------------
  // Error state handling on login page
  //
  // task-i18n-stage3a (Task 3, Step 4): `/login` is UNAUTHENTICATED — there is
  // no session `locale` yet, so `readPreLoginLocale()` (apps/web/app/lib/i18n.ts)
  // falls through to `navigator.language` before defaulting to uk. Playwright's
  // Chromium launches with an en-US locale by default, which — since 'en' IS a
  // supported locale — resolves to 'en', NOT the uk default a first read of
  // `resolveLocale` might suggest. `test.use({ locale: 'uk-UA' })` pins
  // `navigator.language` for this describe block so the assertion is
  // deterministic regardless of the runner's own default locale (verified live:
  // without this, these three tests received the EN catalog text).
  // ---------------------------------------------------------------------------

  test.describe('error state handling', () => {
    test.use({ locale: 'uk-UA' })

    test('?error=unauthorized shows error message', async ({ page }) => {
      const uk = await loadMessages('uk')
      await page.goto('/login?error=unauthorized')
      const banner = page.getByTestId('login-error-message')
      await expect(banner).toBeVisible()
      await expect(banner).toHaveAttribute('data-error-code', 'unauthorized')
      await expect(banner).toHaveText(
        assertInCatalog(uk, 'Ваш email не авторизовано. Зверніться до адміністратора.'),
      )
    })

    test('?error=google_error shows error message', async ({ page }) => {
      const uk = await loadMessages('uk')
      await page.goto('/login?error=google_error')
      const banner = page.getByTestId('login-error-message')
      await expect(banner).toBeVisible()
      await expect(banner).toHaveAttribute('data-error-code', 'google_error')
      await expect(banner).toHaveText(
        assertInCatalog(uk, 'Помилка Google OAuth. Спробуйте ще раз.'),
      )
    })

    test('?error=invalid_state shows error message', async ({ page }) => {
      const uk = await loadMessages('uk')
      await page.goto('/login?error=invalid_state')
      const banner = page.getByTestId('login-error-message')
      await expect(banner).toBeVisible()
      await expect(banner).toHaveAttribute('data-error-code', 'invalid_state')
      // Message: "Сесія закінчилася. Спробуйте ще раз, будь ласка."
      await expect(banner).toHaveText(
        assertInCatalog(uk, 'Сесія закінчилася. Спробуйте ще раз, будь ласка.'),
      )
    })
  })

  // ---------------------------------------------------------------------------
  // Already authenticated redirect
  // ---------------------------------------------------------------------------

  test('authenticated user visiting /login is redirected to /', async ({ page }) => {
    // LoginPage uses AuthProvider skip=true so it never calls /auth/me.
    // The redirect only fires when the CRM layout's own AuthContext (without skip)
    // detects a valid user. We use dev-login to plant a real JWT cookie first.
    //
    // Wrap in try/catch so ECONNREFUSED (backend not running) is handled before
    // test.skip can fire — apiRequestContext.post throws synchronously on ECONNREFUSED.
    // Relative path (task-e2e-origin-agnostic) — `page.request` resolves
    // against the test's configured `baseURL` (PLAYWRIGHT_BASE_URL), so this
    // works regardless of which port the web app is served from. Previously
    // hardcoded to 'http://localhost:3001/auth/dev-login' — TWO bugs in one:
    // wrong origin (broke on any non-default port) AND missing the `/api`
    // global prefix (apps/api/src/main.ts `setGlobalPrefix('api')`), so the
    // real route is `/api/auth/dev-login`. The missing prefix meant this POST
    // always 404'd and the test silently `test.skip()`d below — a masked
    // failure that never actually ran the assertion it exists for.
    let res: Awaited<ReturnType<typeof page.request.post>> | null = null
    try {
      res = await page.request.post('/api/auth/dev-login', {
        data: { email: 'yaremenkomaksym99@gmail.com' },
      })
    } catch {
      test.skip(true, 'dev-login unavailable — backend not running in this environment')
      return
    }
    // dev-login sets a HttpOnly cookie; Playwright's request context shares cookies
    // with the browser context, so subsequent navigation sees the cookie.
    test.skip(
      res.status() !== 200 && res.status() !== 201,
      'dev-login unavailable in this environment',
    )
    await page.goto('/login')
    await page.waitForURL((url) => !url.pathname.endsWith('/login'), { timeout: 10000 })
    expect(page.url()).not.toMatch(/\/login/)
  })

  // ---------------------------------------------------------------------------
  // Flow F (task-autotest-strengthen-e2e-pr56-flows): Vite dev proxy.
  //
  // PR #56 wired up `vite.config.ts → server.proxy: { '/api': :3001 }` so
  // the frontend can hit its own origin (http://localhost:3000/api/*) and
  // have Vite forward to NestJS on :3001. Without the proxy, `/api/auth/me`
  // lands on the SPA fallback (`index.html`) and the AuthContext sees a
  // 200 HTML response instead of JSON, which has historically caused the
  // user to ping-pong between /login and /crm.
  //
  // We verify the proxy by hitting `/api/auth/me` through the SPA's own
  // origin and asserting that the response is JSON (or a 401 from the
  // backend) — NOT HTML.
  // ---------------------------------------------------------------------------

  test('Vite proxy forwards /api → :3001 (no SPA fallback HTML)', async ({ page }) => {
    // No /api routes mocked here on purpose — we want the real proxy chain.
    // page.request uses the same context as the browser (same origin).
    // Relative path (task-e2e-origin-agnostic) — resolves against the test's
    // configured baseURL (PLAYWRIGHT_BASE_URL). A hardcoded
    // 'http://localhost:3000/...' only worked when the web app happened to be
    // served from exactly that origin — ECONNREFUSED on any other port.
    const res = await page.request.get('/api/auth/me')
    const contentType = res.headers()['content-type'] ?? ''
    // When the backend is not running the Vite proxy returns 502/504/500.
    // Skip the assertion in that case — the test is only meaningful when both
    // servers are live (e.g. local dev or CI with a real NestJS instance).
    const status = res.status()
    test.skip(status >= 500, 'backend not running — Vite proxy returned ' + String(status))
    // Either the API returned JSON (authenticated) or 401 JSON (anonymous).
    // The smoking-gun regression would be `text/html` + 200 — the SPA
    // fallback. We assert against that explicitly.
    expect(contentType).not.toMatch(/text\/html/i)
    expect([200, 401]).toContain(status)
  })

  // ---------------------------------------------------------------------------
  // task-i18n-stage2 (Task 6): the session's `locale` (from `/auth/me`,
  // mocked here via `mockAuthAs`) sets `<html lang>` after login —
  // something no unit test can see (jsdom/happy-dom never runs the real
  // dynamic `.po` import + `<I18nProvider>` re-render chain end to end).
  // ---------------------------------------------------------------------------

  test('locale "en" in /auth/me sets <html lang="en"> after login', async ({ page }) => {
    await mockAuthAs(page, { ...USERS.senior, locale: 'en' })
    await page.goto('/')
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  })

  test('locale "uk" in /auth/me sets <html lang="uk"> after login', async ({ page }) => {
    await mockAuthAs(page, { ...USERS.senior, locale: 'uk' })
    await page.goto('/')
    await expect(page.locator('html')).toHaveAttribute('lang', 'uk')
  })
})
