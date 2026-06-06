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
    // Block Service Worker registration in all E2E contexts.
    // This PR (feat/api-media-caching) added a Workbox NetworkFirst rule for
    // GET /api/* in the SW. When E2E runs against the production build
    // (`vite preview`) the SW intercepts /api/* before page.route() mocks
    // can handle them → requests hang → test timeouts (10-12 s per test).
    // E2E specs do NOT test SW behaviour — they test application logic via
    // mocked API responses. A dedicated SW-integration project can be added
    // in a future task with serviceWorkers: 'allow'.
    serviceWorkers: 'block' as const,
  },
  projects: [
    {
      name: 'chromium',
      // Exclude cache specs from the default project — they require a
      // production build with SW enabled (serviceWorkers: 'allow').
      testIgnore: '**/cache/**',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // ── SW / Cache integration project ────────────────────────────────────
      // Requires a production build (vite build + vite preview) because the
      // Service Worker is disabled in dev mode (devOptions: { enabled: false }
      // in vite.config.ts VitePWA). The webServer config below starts the
      // preview server automatically.
      //
      // Isolation: serviceWorkers: 'allow' is scoped to this project only.
      // The default 'chromium' project above keeps serviceWorkers: 'block' so
      // existing mock-based specs are not affected.
      //
      // CI note: a dedicated 'cache-e2e' shard in ci.yml needs a pre-built
      // dist/ — see docs/superpowers/plans/2026-06-06-cache-e2e-plan.md.
      // NOTE: requires externally-started servers (see the webServer note
      // below); not auto-run by ci.yml yet (no cache shard) — run locally or
      // via the deferred dedicated shard.
      name: 'cache',
      testMatch: '**/cache/**/*.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        // Enable SW registration — this is what we are testing.
        serviceWorkers: 'allow' as const,
        baseURL: 'http://localhost:3000',
        // Longer timeout for SW activation (activation requires ~1–3 network
        // round-trips for SW script fetch + install + activate lifecycle).
        actionTimeout: 20_000,
      },
      // NOTE: `webServer` is a TOP-LEVEL Playwright option — it cannot be
      // nested inside a project (that is a type error and is silently ignored
      // at runtime). The cache project needs BOTH a real backend (:3001) and a
      // production web preview (:3000, since the SW is disabled in `vite dev`).
      // Those are started externally by the runner — see the deferred ci.yml
      // `cache` shard in docs/superpowers/plans/2026-06-06-cache-e2e-plan.md.
      // A top-level webServer is intentionally NOT added: it would also
      // force-start servers for the mock `chromium` shards (which run in ci.yml
      // without a build) and break them.
    },
  ],
})
