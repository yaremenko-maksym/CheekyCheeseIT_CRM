import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  workers: process.env['CI'] ? 1 : '50%',
  // Under CI we want a *streaming* progress reporter so GHA logs show which
  // test is currently running — `html` alone is silent and makes a hung shard
  // look indistinguishable from a slow one. Locally we keep the HTML report
  // because developers like the GUI.
  reporter: process.env['CI']
    ? [
        // `list` streams "[N/M] [project] › file:line › title" per test to
        // stdout, so a hung test is immediately identifiable in the GHA log.
        ['list'],
        // Native GHA annotations: failures appear inline in the PR UI with
        // file:line links via ::error:: workflow commands.
        ['github'],
        // Preserve the HTML report so `upload-artifact` in ci.yml still has
        // something to attach when the suite fails.
        ['html', { open: 'never', outputFolder: 'playwright-report' }],
      ]
    : 'html',
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
