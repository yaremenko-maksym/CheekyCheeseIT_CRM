// ---------------------------------------------------------------------------
// Real-API helpers (task-expand-drop-e2e-coverage)
// ---------------------------------------------------------------------------
//
// These helpers hit the *real* NestJS backend (no Playwright route mocks).
// Used by `drop-archive-real.spec.ts` and siblings to exercise the actual
// `/api/users/drops`, `/api/teams/:id`, etc. — so the test catches backend
// regressions that mock-based specs silently mask.
//
// They expect a running backend at `http://localhost:3001` and the dev seed
// applied (CI workflow runs `pnpm --filter @crm/api db:migrate && db:seed`
// before `pnpm --filter @crm/e2e test`). For local runs, `pnpm dev` + dev
// login work the same way (`auth.controller.devLogin` gates on NODE_ENV).
//
// Authentication: `loginViaApi` POSTs to `/api/auth/dev-login` and Playwright's
// request context shares cookies with the browser, so a subsequent
// `page.goto('/...')` is authenticated.

/**
 * Backend HTTP origin used by the real-API helpers. Overridable via
 * `E2E_REAL_API_BASE` (task-drop-share-e2e) so a local run can point at a
 * throwaway API instance on a non-default port (e.g. when 3001 is already
 * occupied by a concurrent worktree's dev stack) without touching every
 * call-site. Defaults to the standard dev/CI port — existing specs are
 * unaffected.
 *
 * task-pending-share (2026-09-04): running the FULL suite against a
 * self-provisioned scratch DB + scratch API/web pair (never the live
 * `crm_db` or the live :3000/:3001 pair — see live-db-access.md /
 * light-track.md's port list) needs FOUR env vars set together, none of
 * which are collected in one place anywhere else in this repo:
 *   - `PLAYWRIGHT_BASE_URL` (playwright.config.ts) — drives BROWSER
 *     navigation only.
 *   - `E2E_REAL_API_BASE` (this constant) — drives the DIRECT
 *     `apiRequestContext` calls (`dev-login` and most setup/teardown
 *     helpers) in this file. Separate from the two below because neither
 *     of them is read by a Node test process at all — they configure the
 *     WEB DEV SERVER, started as its own separate command.
 *   - `VITE_PROXY_API_TARGET` (apps/web/vite.config.ts) — the web dev
 *     server's OWN `/api` proxy target for same-origin requests made BY
 *     THE BROWSER (i.e. the app under test, not this fixture file).
 *     Distinct from `VITE_API_URL` (the frontend axios client's base URL);
 *     both default to :3001 independently and neither is driven by the
 *     other — setting only one leaves the other silently pointed at the
 *     live pair, or (worse) creates a self-proxy loop if the web dev
 *     server was also given a non-default `--port` matching that default.
 *   - `THROTTLE_RELAXED=true` (apps/api/src/config/env.ts, non-production
 *     only) on the scratch API — the suite's own parallel workers calling
 *     `dev-login` from `127.0.0.1` comfortably exceed the default
 *     `THROTTLER_LIMIT` (100 req/60s), which 429s cascade into failures
 *     across spec files that have nothing to do with whatever the actual
 *     change under test touches.
 * Also start the web dev server with `--strictPort` (`vite --port <port>
 * --strictPort`, not `pnpm dev -- --port <port>` — a literal `--` can
 * reach vite's own arg parser and get silently ignored, falling back to
 * vite's default port search) so a port collision fails loudly instead of
 * silently binding elsewhere.
 */
export const REAL_API_BASE = process.env['E2E_REAL_API_BASE'] ?? 'http://localhost:3001'

/**
 * Seed ADMIN email used by the dev seed. Hardcoded here to keep the
 * fixtures file self-contained — kept in sync with `apps/api/src/database/seed.ts`.
 */
export const SEED_ADMIN_EMAIL = 'yaremenkomaksym99@gmail.com'

/**
 * Seed JUNIOR/HR/SENIOR/ACCOUNTANT emails used by the dev seed.
 * Mirror of `SEED_USERS` in `apps/api/src/database/seed.ts`.
 */
export const SEED_EMAILS = {
  admin: 'yaremenkomaksym99@gmail.com',
  seniorA: 'oleksiy.kovalenko@cheekycheese.dev',
  // seniorB is the seed's deliberately NOT-onboarded wizard-test user
  // (employee_contract READY_TO_SIGN, no ToS acceptance — seed/onboarding.ts):
  // logging in as him lands on the onboarding wall, not the app shell. Specs
  // that need a working senior session use seniorA or seniorC.
  seniorB: 'dmytro.marchenko@cheekycheese.dev',
  seniorC: 'nazar.ponomarenko@cheekycheese.dev',
  juniorA: 'sofia.bondarenko@cheekycheese.dev',
  juniorB: 'ivan.petrenko@cheekycheese.dev',
  hrA: 'anna.lysenko@cheekycheese.dev',
  hrB: 'kateryna.shevchenko@cheekycheese.dev',
  accountant: 'mykola.savchenko@cheekycheese.dev',
} as const

/** A valid USDT ERC-20 address used as required-requisite payload filler. */
export const VALID_USDT_WALLET = '0x' + '0'.repeat(40)

/**
 * Hardcoded partner UUIDs — duplicated from `packages/shared/src/schemas/index.ts`
 * because the e2e package deliberately doesn't depend on `@crm/shared` (keeps
 * the test runner independent of the workspace build pipeline). These two
 * IDs are environment-stable (seeded by `apps/api/src/database/seed.ts`),
 * so the duplication is benign — a CI guard catches drift if the seed ever
 * changes.
 */
export const MAKSYM_ID = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
export const KOSTYA_ID = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'

/**
 * Plant a real JWT cookie for the given email via `/api/auth/dev-login`.
 *
 * Throws if the backend isn't reachable or rejects the login — real-API
 * specs must surface that loudly so the suite fails fast instead of
 * silently running unauthenticated.
 */
/**
 * Retry a request thunk up to `maxRetries` times on HTTP 429.
 * The global throttler is 100 req/60 s — local test runs can exhaust it
 * when multiple specs run back-to-back. Wait 5 s between retries.
 */
export async function withThrottleRetry(
  thunk: () => Promise<import('@playwright/test').APIResponse>,
  label: string,
  maxRetries = 2,
): Promise<import('@playwright/test').APIResponse> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const res = await thunk()
    if (res.status() !== 429) return res
    if (attempt < maxRetries) {
      // Global throttler: 100 req/60 s sliding window. Wait 10 s to let
      // quota partially recover (enough for one more request).
      await new Promise((r) => setTimeout(r, 10_000))
    }
  }
  // Final attempt — return whatever we got (caller checks status).
  return thunk()
}
