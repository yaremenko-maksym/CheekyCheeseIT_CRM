import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  workers: process.env['CI'] ? 1 : '75%',
  reporter: 'html',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  use: {
    // Allow overriding via env so a developer can point the suite at a
    // throw-away dev server (e.g. when port 3000 is occupied by a User
    // Testing tunnel build that ships stale code). Falls back to the
    // standard local dev port.
    baseURL: process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:3000',
    trace: 'on-first-retry',
    actionTimeout: 10_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})


