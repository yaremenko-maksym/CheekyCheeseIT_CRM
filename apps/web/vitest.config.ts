import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'
import path from 'path'
import { existsSync, readFileSync, statSync } from 'fs'

// Detect git worktree (vs. the primary checkout). `.git` is a FILE (not a
// dir) when inside a worktree; its content is:
//   "gitdir: <mainRepo>/.git/worktrees/<name>"
// We only use this to confirm we're really in a worktree (so the sibling
// primary checkout — needed for `existsSync` sanity below — actually
// exists); the alias itself resolves to THIS worktree's own source (see
// note below), not the primary checkout's.
function isGitWorktree(): boolean {
  const worktreeRoot = path.resolve(__dirname, '../..')
  const gitEntry = path.join(worktreeRoot, '.git')
  if (!existsSync(gitEntry)) return false
  if (statSync(gitEntry).isDirectory()) return false // primary checkout, no indirection

  const firstLine = readFileSync(gitEntry, 'utf8').split('\n')[0] ?? ''
  const match = firstLine.match(/^gitdir:\s*(.+)$/)
  if (!match) return false
  // gitdirPath = <mainRepo>/.git/worktrees/<name> — 3× dirname → <mainRepo>.
  const mainRepo = path.dirname(path.dirname(path.dirname(match[1].trim())))
  return existsSync(path.join(mainRepo, 'node_modules'))
}

const worktreeRoot = path.resolve(__dirname, '../..')
const worktree = isGitWorktree()

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  // '@crm/shared' is aliased straight to TypeScript SOURCE unconditionally —
  // in the main repo as well as in a worktree (previously this lived inside
  // the `worktree &&` block below and only applied there, which left the
  // main-repo checkout resolving the bare specifier through pnpm's
  // node_modules symlink to `dist/` — untracked, gitignored, and NOT
  // rebuilt by `git checkout`). `turbo.json`/`package.json`
  // (task-infra-shared-build-freshness, 2026-08-25) close that gap for
  // turbo-routed runs (`pnpm test`, `pnpm test --filter=@crm/web`); this
  // closes it for the OTHER, documented per-package form
  // (`pnpm --filter @crm/web test`, also what `.husky/pre-push` runs),
  // which bypasses turbo's task graph entirely and was still exposed — see
  // BACKLOG-followups.md #111 for the reproduction (a stale compiled
  // `@crm/shared` made a real fix look like it changed nothing, or a fresh
  // regression look pre-existing). Resolving THIS worktree's own
  // packages/shared (not the primary checkout's — a task branch editing
  // shared schemas must see its OWN changes) removes the dependency on a
  // build step for tests altogether: nothing is left that can go stale.
  resolve: {
    alias: {
      '@crm/shared': path.resolve(worktreeRoot, 'packages/shared/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'happy-dom',
    // happy-dom navigates a freshly-connected `<iframe src=…>` for real
    // (HTMLIFrameElement.#loadPage → BrowserFrame.goto). For the `blob:` URLs
    // our PDF-preview components feed an iframe, that navigation rejects
    // asynchronously with `DOMException [NotSupportedError]` ("URL scheme
    // \"blob\" is not supported") inside a microtask OUTSIDE the owning test's
    // stack. Under the parallel pre-push run (@crm/shared + @crm/api + @crm/web
    // competing for CPU in worktree fork pools) the timing shifts so vitest 4
    // attributes that stray unhandled rejection to whichever web test happens
    // to own the event-loop window — a load-dependent flake that surfaced on
    // ContractPdfPreview / pdf-preview specs.
    //
    // `disableIframePageLoading` is happy-dom's official switch for test
    // environments: it short-circuits #loadPage synchronously, so no `blob:`
    // fetch is ever issued and no async rejection can escape. Iframes still
    // mount with their real `src`, so assertions on iframe presence/src stay
    // valid. Test-environment only — real browsers render `blob:` iframes
    // fine, so production behaviour is unaffected.
    environmentOptions: {
      happyDOM: {
        settings: {
          disableIframePageLoading: true,
        },
      },
    },
    setupFiles: ['./app/test/setup.ts'],
    include: ['app/**/*.{spec,test}.{ts,tsx}'],
    // In a worktree the happy-dom environment startup is slower and React
    // component tests compete for CPU with API tests running in parallel.
    // Raise testTimeout and limit forks so heavy tests don't hit the wall.
    testTimeout: worktree ? 30000 : 15000,
    ...(worktree && {
      pool: 'forks',
      poolOptions: { forks: { maxForks: 2 } },
    }),
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['app/**/*.{ts,tsx}'],
      exclude: [
        'app/routeTree.gen.ts',
        'app/client.tsx',
        'app/**/*.spec.*',
        'app/**/*.test.*',
        'app/test/**',
      ],
    },
  },
})
