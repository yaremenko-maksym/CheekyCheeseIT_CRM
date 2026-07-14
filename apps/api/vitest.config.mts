import { configDefaults, defineConfig } from 'vitest/config'
import path from 'path'
import { existsSync, readFileSync, statSync } from 'fs'
import { config as loadDotenv } from 'dotenv'

import {
  INTEGRATION_SPEC_EXCLUDE_GLOB,
  isIntegrationRun as detectIntegrationRun,
} from './src/test/integration-run-mode'

// Detect whether we are running inside a git worktree and, if so, locate
// the main repo root so that vitest can resolve packages installed there.
//
// Strategy: walk up from __dirname looking for a ".git" entry.
//   - In the main repo:  .git is a directory  → we ARE the main repo root.
//   - In a git worktree: .git is a file whose first line is
//       "gitdir: <absolute-path-to-main-.git/worktrees/…>"
//     Parse that path to derive the main repo root (3 levels up from the
//     worktrees/<name> directory that gitdir points to).
//
// This approach is fully portable: no hard-coded machine paths, works on
// any developer machine and in CI.

function findGitRoot(startDir: string): string | null {
  let dir = startDir
  for (let i = 0; i < 10; i++) {
    const gitEntry = path.join(dir, '.git')
    if (existsSync(gitEntry)) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

function resolveMainRepoRoot(): string | null {
  const worktreeRoot = path.resolve(__dirname, '../..')
  const gitEntry = path.join(worktreeRoot, '.git')
  if (!existsSync(gitEntry)) return null

  const stat = statSync(gitEntry)
  if (stat.isDirectory()) {
    // We are already in the main repo — no worktree indirection needed.
    return null
  }

  // .git is a file: "gitdir: /abs/path/to/main/.git/worktrees/<name>"
  const firstLine = readFileSync(gitEntry, 'utf8').split('\n')[0] ?? ''
  const match = firstLine.match(/^gitdir:\s*(.+)$/)
  if (!match) return null
  const gitdirPath = match[1].trim()
  // gitdirPath = <mainRepo>/.git/worktrees/<name>
  // Strip 3 trailing segments to reach <mainRepo>:
  //   dirname(<name>)      → <mainRepo>/.git/worktrees
  //   dirname(worktrees)   → <mainRepo>/.git
  //   dirname(.git)        → <mainRepo>
  const mainRepo = path.dirname(path.dirname(path.dirname(gitdirPath)))
  return existsSync(path.join(mainRepo, 'node_modules')) ? mainRepo : null
}

const mainRepoRoot = resolveMainRepoRoot()
const isWorktree = mainRepoRoot !== null
const mainApiNodeModules = mainRepoRoot ? `${mainRepoRoot}/apps/api/node_modules` : ''
const mainRootNodeModules = mainRepoRoot ? `${mainRepoRoot}/node_modules` : ''
const worktreeRoot = path.resolve(__dirname, '../..')

// ── Integration-run detection & DB safety ─────────────────────────────────
//
// Load .env.test early (in the vitest config process) so that `test.env`
// below can merge its variables into the test-worker environment.
// `override: false` means shell-exported DATABASE_URL always wins — the
// guard in globalSetup will still catch crm_db regardless.
const envTestPath = path.resolve(__dirname, '.env.test')
const envTestVars: Record<string, string> = {}
if (existsSync(envTestPath)) {
  const result = loadDotenv({ path: envTestPath, processEnv: envTestVars })
  void result // dotenv returns { parsed, error }; we only need the side-effect into envTestVars
}
// Build the effective DATABASE_URL for workers: shell env > .env.test > nothing.
// NOTE: this is NOT "unit runs have no DATABASE_URL" — a developer's shell may
// well export DATABASE_URL (e.g. from the repo-root `.env`, used for `pnpm dev`)
// and Node child processes always inherit it regardless of what we compute here.
// That is fine: for non-integration runs `workerEnv` below is never injected
// (see `isIntegrationRun` gate) AND every integration spec file is excluded
// from test discovery entirely (see INTEGRATION_SPEC_EXCLUDE_GLOB below), so no
// unit spec ever reads DATABASE_URL / opens a Pool — an ambient crm_db URL is
// inert on a non-integration run.
const workerDatabaseUrl = process.env['DATABASE_URL'] ?? envTestVars['DATABASE_URL'] ?? undefined
const workerEnv: Record<string, string> = {}
if (workerDatabaseUrl) {
  workerEnv['DATABASE_URL'] = workerDatabaseUrl
}

// ── Integration-run detection ──────────────────────────────────────────────
//
// The `*.integration.spec.ts` specs hit ONE shared Postgres. Some of them read
// GLOBAL / cross-row aggregate state — e.g. accountant-summary asserts on the
// DELTA of a company-wide `count(*) / sum(amount) / count(distinct party)` over
// the WHOLE `transactions` table (`getAccountantSummary` has no per-caller WHERE
// scoping). When vitest runs those files in PARALLEL worker forks against the
// single DB, another spec's income inserts (receipt-replace, drop.rbac,
// documents-unified, transactions.junior-findall — all insert SENIOR_INCOME /
// DROP_INCOME) land inside accountant-summary's baseline→assert window and
// corrupt its deltas. This is a cross-file data race, reproduced locally on a
// seeded scratch DB on the first full integration run.
//
// CI invokes the integration suite as `vitest run … integration.spec` (a path
// substring filter — see the `integration` job in .github/workflows/ci.yml). We
// detect that filter from argv and, ONLY for an integration run, disable file
// parallelism so the specs no longer share the DB concurrently. `fileParallelism:
// false` forces serial file execution (vitest then pins maxWorkers to 1). This
// fixes the whole CLASS of integration races (current and future specs that read
// global state), not a single assertion — and the asserts stay untouched.
//
// It does NOT affect the unit-test `quality` job: that runs `vitest run` with no
// filter and no DATABASE_URL, so `isIntegrationRun` is false and unit specs keep
// running fully parallel.
//
// DB isolation guard (see src/test/integration-db-guard.ts):
// For integration runs we inject a globalSetup that:
//   1. Loads .env.test (DATABASE_URL defaults to crm_qa) if not already set.
//   2. Fails fast with an explicit error if DATABASE_URL points to crm_db AND
//      CI is not set — preventing local residue in the working database.
//   3. Passes through silently when CI=true (throwaway container DB).
// This globalSetup guard is a second-line safety net for the FILTERED
// integration run itself (crm_db vs crm_qa mixup) — it is NOT what protects a
// non-integration run (see below), because it is only ever registered when
// `isIntegrationRun` is true.
//
// Non-integration-run structural skip (fixes a real incident — found on PR
// #369 / hardened here): a plain, unfiltered `pnpm --filter @crm/api test`
// (exactly what `.husky/pre-push` runs) used to have NO protection at all
// beyond each spec's own DB-reachability probe. If a developer's shell
// exports an ambient `DATABASE_URL` pointing at the live `crm_db` (normal
// dev setup — the repo-root `.env` sets this for `pnpm dev`), that ambient
// value is inherited by the vitest worker pool same as any other env var.
// Every `*.integration.spec.ts` probes DB reachability, not WHICH database it
// is pointed at, so a reachable `crm_db` looked exactly like a valid target
// and the spec would write real residue into it — silently, on every
// developer's ordinary `pnpm test` run. `fileParallelism` also stayed at its
// parallel default in that case, so multiple integration specs could race
// against crm_db concurrently on top of that.
//
// Fix: for ANY non-integration run, every integration spec file is excluded
// from `test.include`/`test.exclude` discovery below (INTEGRATION_SPEC_EXCLUDE_GLOB)
// — vitest never even parses those files, so it is structurally impossible for
// them to open a DB connection, no matter what DATABASE_URL is ambient. This
// closes the crm_db-write bug AND the parallel-race class in one move, without
// requiring every developer to remember to clear DATABASE_URL first. The
// filtered integration run (`vitest run … integration.spec`, used by CI and
// local reproduction) is untouched: the positional `integration.spec` argv
// filter still narrows execution to integration specs only, applied on top of
// this (unaffected, since `isIntegrationRun` is true there) `include`/`exclude`.
const isIntegrationRun = detectIntegrationRun(process.argv)

if (!isIntegrationRun) {
  // Loud, single-line warning — this fires on EVERY non-integration run
  // (including the unit-only CI `quality` job and `.husky/pre-push`), by
  // design: it makes the structural skip visible instead of a silent no-op.
  console.warn(
    '[vitest.config] non-integration run — skipping all *.integration.spec.ts files ' +
      '(they hit a real Postgres and are excluded from test discovery on this run). ' +
      'Run `pnpm --filter @crm/api exec vitest run integration.spec` against crm_qa ' +
      'to execute them.',
  )
}

export default defineConfig({
  ...(isWorktree && {
    resolve: {
      alias: {
        // Point bare-module imports to the main repo's installed packages.
        // pnpm uses a flat node_modules structure via symlinks, so resolving
        // to the api-level node_modules covers NestJS, Drizzle, pdf-lib etc.
        //
        // @crm/shared: point vitest to the TypeScript source so it always
        // reflects the latest schema without requiring a `pnpm build` step.
        // Using dist/index.js masked schema drift between source and compiled
        // output; pointing to src/index.ts eliminates that risk entirely.
        '@crm/shared': path.resolve(worktreeRoot, 'packages/shared/src/index.ts'),
      },
    },
  }),
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.{spec,test}.ts'],
    // Non-integration runs: exclude every DB-backed integration spec file from
    // discovery entirely (see the "Non-integration-run structural skip" comment
    // above) — this is what makes the guard unconditional, independent of
    // DATABASE_URL. Integration runs keep vitest's plain default exclude; the
    // CLI's positional `integration.spec` filter narrows execution from there.
    exclude: isIntegrationRun
      ? configDefaults.exclude
      : [...configDefaults.exclude, INTEGRATION_SPEC_EXCLUDE_GLOB],
    // Generous per-test budget for CPU-bound tests (contract-pdf ~5s, compression ~60s
    // under load). Pre-push hook now runs packages sequentially so each test worker
    // gets the full CPU, but we keep a 90 s ceiling to catch genuine hangs.
    testTimeout: 90000,
    pool: 'forks',
    // Serialize the integration run so specs never share the single Postgres
    // concurrently (see `isIntegrationRun` above). `fileParallelism: false`
    // disables parallel file execution and pins maxWorkers to 1 — the durable
    // fix for the cross-file DB data race. Applies to BOTH main-repo (CI) and
    // worktree integration runs. For non-integration runs we leave file
    // parallelism at its default (true) so the unit suite stays fast.
    ...(isIntegrationRun && { fileParallelism: false }),
    // DB isolation guard — only active for integration runs.
    // globalSetup runs in the main vitest process (before workers), so it can
    // load .env.test and check DATABASE_URL before any Pool connection opens.
    ...(isIntegrationRun && {
      globalSetup: ['src/test/integration-db-guard.ts'],
    }),
    // Inject the effective DATABASE_URL into test workers so specs pick up
    // crm_qa without developers having to export it manually in their shell.
    // `workerEnv` is computed above: shell env wins over .env.test default.
    // Gated to integration runs only: non-integration runs never load any
    // integration spec (see `exclude` above), so no worker ever needs — or
    // should be handed — a DATABASE_URL at all.
    ...(isIntegrationRun &&
      Object.keys(workerEnv).length > 0 && {
        env: workerEnv,
      }),
    ...(isWorktree && {
      // Extend vitest's server module resolution to include main repo's packages.
      server: {
        fs: {
          allow: [worktreeRoot, mainRepoRoot!, mainApiNodeModules, mainRootNodeModules],
        },
      },
      // In a worktree the node_modules resolution chain is longer and heavy
      // tests (JPEG compression, PDF generation) compete for CPU with the
      // shared main-repo process pool. Cap workers so resource-intensive tests
      // get enough CPU time instead of hitting timeouts. (vitest 4 removed
      // `poolOptions.forks.maxForks` — the cap is now the top-level
      // `maxWorkers`. An integration run further narrows this to 1 via
      // `fileParallelism: false` above.)
      maxWorkers: 2,
    }),
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.module.ts', 'src/main.ts', 'src/**/*.spec.ts', 'src/**/*.test.ts'],
    },
  },
})
