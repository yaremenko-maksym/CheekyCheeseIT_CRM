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
  ...(worktree && {
    resolve: {
      alias: {
        // @crm/shared has no dist/ in a fresh worktree — point directly to TS
        // source. IMPORTANT: resolve against THIS worktree's own
        // packages/shared, NOT the primary checkout's — a task branch that
        // edits packages/shared (e.g. new shared schemas/exports) must see
        // its OWN changes, not whatever branch the primary checkout happens
        // to have checked out (previously aliased there — silently resolved
        // to a stale/unrelated shared source and broke tests that exercised
        // freshly-added shared exports).
        '@crm/shared': path.resolve(worktreeRoot, 'packages/shared/src/index.ts'),
      },
    },
  }),
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
