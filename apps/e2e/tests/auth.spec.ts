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
    await expect(page.getByText('CheekyCheeseIT CRM')).toBeVisible()
    await expect(page.getByRole('link', { name: /войти с google/i })).toBeVisible()
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
      errors.push(text)
    })
    await page.goto('/crm/login')
    await page.waitForTimeout(1000)
    expect(errors).toHaveLength(0)
  })

  test('Google login button has correct href', async ({ page }) => {
    await page.goto('/crm/login')
    const link = page.getByRole('link', { name: /войти с google/i })
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
    // Match the error alert div, not the footer paragraph
    await expect(page.locator('.text-destructive').filter({ hasText: /авторизован|доступ/i }).first()).toBeVisible()
  })

  test('?error=google_error shows error message', async ({ page }) => {
    await page.goto('/crm/login?error=google_error')
    await expect(page.locator('.text-destructive').filter({ hasText: /google|oauth/i }).first()).toBeVisible()
  })

  test('?error=invalid_state shows error message', async ({ page }) => {
    await page.goto('/crm/login?error=invalid_state')
    // Message: "Сессия истекла. Пожалуйста, попробуйте снова."
    await expect(page.locator('.text-destructive').filter({ hasText: /сессия|истекла|попробуйте/i }).first()).toBeVisible()
  })

  // ---------------------------------------------------------------------------
  // Already authenticated redirect
  // ---------------------------------------------------------------------------

  test('authenticated user visiting /crm/login is redirected to /crm', async ({ page }) => {
    // LoginPage uses AuthProvider skip=true so it never calls /auth/me.
    // The redirect only fires when the CRM layout's own AuthContext (without skip)
    // detects a valid user. We use dev-login to plant a real JWT cookie first.
    const res = await page.request.post('http://localhost:3001/auth/dev-login', {
      data: { email: 'yaremenkomaksym99@gmail.com' },
    })
    // dev-login sets a HttpOnly cookie; Playwright's request context shares cookies
    // with the browser context, so subsequent navigation sees the cookie.
    test.skip(res.status() !== 200 && res.status() !== 201, 'dev-login unavailable in this environment')
    await page.goto('/crm/login')
    await page.waitForURL((url) => !url.pathname.endsWith('/login'), { timeout: 10000 })
    expect(page.url()).not.toMatch(/\/crm\/login/)
  })
})
