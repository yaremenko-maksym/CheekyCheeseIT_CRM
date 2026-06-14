import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'
import path from 'path'
import { existsSync, statSync } from 'fs'

// Detect git worktree: .git is a file (not a dir) when inside a worktree.
function isInsideWorktree(): boolean {
  const gitEntry = path.join(__dirname, '../..', '.git')
  if (!existsSync(gitEntry)) return false
  return statSync(gitEntry).isFile()
}

const worktree = isInsideWorktree()

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
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
