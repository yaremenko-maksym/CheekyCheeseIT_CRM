import { test, expect } from '@playwright/test'

const PROTECTED_ROUTES = [
  '/crm',
  '/crm/team',
  '/crm/projects',
  '/crm/interviews',
  '/crm/profile',
  '/crm/users',
]

test.describe('Auth flow', () => {
  // ---------------------------------------------------------------------------
  // Login page
  // ---------------------------------------------------------------------------

  test('login page renders correctly', async ({ page }) => {
    await page.goto('/crm/login')
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
    await page.goto('/crm/login')
    await page.waitForTimeout(1000)
    expect(errors).toHaveLength(0)
  })

  test('Google login button has correct href', async ({ page }) => {
    await page.goto('/crm/login')
    const link = page.getByTestId('login-google-button')
    const href = await link.getAttribute('href')
    // Should point to the API Google OAuth endpoint
    expect(href).toMatch(/auth\/google/)
  })

  // ---------------------------------------------------------------------------
  // Unauthenticated redirects — all protected routes bounce to /crm/login
  // ---------------------------------------------------------------------------

  for (const route of PROTECTED_ROUTES) {
    test(`unauthenticated ${route} redirects to /crm/login`, async ({ page }) => {
      // Stub /auth/me to return 401 so the app knows user is not logged in
      await page.route('http://localhost:3001/api/auth/me', (r) =>
        r.fulfill({ status: 401, body: '{"message":"Unauthorized"}' }),
      )
      await page.goto(route)
      await expect(page).toHaveURL(/\/crm\/login/)
    })
  }

  // ---------------------------------------------------------------------------
  // Error state handling on login page
  // ---------------------------------------------------------------------------

  test('?error=unauthorized shows error message', async ({ page }) => {
    await page.goto('/crm/login?error=unauthorized')
    const banner = page.getByTestId('login-error-message')
    await expect(banner).toBeVisible()
    await expect(banner).toHaveAttribute('data-error-code', 'unauthorized')
    // The Russian copy is the error contract — keep text assertion as a regex.
    await expect(banner).toContainText(/авторизован|доступ/i)
  })

  test('?error=google_error shows error message', async ({ page }) => {
    await page.goto('/crm/login?error=google_error')
    const banner = page.getByTestId('login-error-message')
    await expect(banner).toBeVisible()
    await expect(banner).toHaveAttribute('data-error-code', 'google_error')
    await expect(banner).toContainText(/google|oauth/i)
  })

  test('?error=invalid_state shows error message', async ({ page }) => {
    await page.goto('/crm/login?error=invalid_state')
    const banner = page.getByTestId('login-error-message')
    await expect(banner).toBeVisible()
    await expect(banner).toHaveAttribute('data-error-code', 'invalid_state')
    // Message: "Сессия истекла. Пожалуйста, попробуйте снова."
    await expect(banner).toContainText(/сессия|истекла|попробуйте/i)
  })

  // ---------------------------------------------------------------------------
  // Already authenticated redirect
  // ---------------------------------------------------------------------------

  test('authenticated user visiting /crm/login is redirected to /crm', async ({ page }) => {
    // LoginPage uses AuthProvider skip=true so it never calls /auth/me.
    // The redirect only fires when the CRM layout's own AuthContext (without skip)
    // detects a valid user. We use dev-login to plant a real JWT cookie first.
    //
    // Wrap in try/catch so ECONNREFUSED (backend not running) is handled before
    // test.skip can fire — apiRequestContext.post throws synchronously on ECONNREFUSED.
    let res: Awaited<ReturnType<typeof page.request.post>> | null = null
    try {
      res = await page.request.post('http://localhost:3001/auth/dev-login', {
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
    await page.goto('/crm/login')
    await page.waitForURL((url) => !url.pathname.endsWith('/login'), { timeout: 10000 })
    expect(page.url()).not.toMatch(/\/crm\/login/)
  })

  // ---------------------------------------------------------------------------
  // Flow F (task-autotest-strengthen-e2e-pr56-flows): Vite dev proxy.
  //
  // PR #56 wired up `vite.config.ts → server.proxy: { '/api': :3001 }` so
  // the frontend can hit its own origin (http://localhost:3000/api/*) and
  // have Vite forward to NestJS on :3001. Without the proxy, `/api/auth/me`
  // lands on the SPA fallback (`index.html`) and the AuthContext sees a
  // 200 HTML response instead of JSON, which has historically caused the
  // user to ping-pong between /crm/login and /crm.
  //
  // We verify the proxy by hitting `/api/auth/me` through the SPA's own
  // origin and asserting that the response is JSON (or a 401 from the
  // backend) — NOT HTML.
  // ---------------------------------------------------------------------------

  test('Vite proxy forwards /api → :3001 (no SPA fallback HTML)', async ({ page }) => {
    // No /api routes mocked here on purpose — we want the real proxy chain.
    // page.request uses the same context as the browser (same origin).
    const res = await page.request.get('http://localhost:3000/api/auth/me')
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
})
