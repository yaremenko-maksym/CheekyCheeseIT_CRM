import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'
import path from 'path'
import { existsSync, readFileSync, statSync } from 'fs'

// Detect git worktree and resolve the main repo root.
function resolveMainRepoRoot(): string | null {
  const worktreeRoot = path.resolve(__dirname, '../..')
  const gitEntry = path.join(worktreeRoot, '.git')
  if (!existsSync(gitEntry)) return null
  if (statSync(gitEntry).isDirectory()) return null

  const firstLine = readFileSync(gitEntry, 'utf8').split('\n')[0] ?? ''
  const match = firstLine.match(/^gitdir:\s*(.+)$/)
  if (!match) return null
  const mainRepo = path.dirname(path.dirname(path.dirname(match[1].trim())))
  return existsSync(path.join(mainRepo, 'node_modules')) ? mainRepo : null
}

const mainRepoRoot = resolveMainRepoRoot()
const worktree = mainRepoRoot !== null
const worktreeRoot = path.resolve(__dirname, '../..')

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  // '@crm/shared' resolved straight to TypeScript SOURCE, unconditionally —
  // this config had NO alias at all before (unlike apps/api and apps/web's
  // vitest configs, which at least aliased it in a worktree). Landing specs
  // import real values from '@crm/shared' (VACANCY_DOMAINS, VACANCY_LOCALES —
  // see app/__tests__/{vacancy-domain,seo}.spec.ts) and from the narrow
  // '@crm/shared/public' subpath (app/lib/api.ts), so without this alias
  // EVERY landing test run — worktree or main repo — resolved through pnpm's
  // node_modules symlink to `dist/`: untracked, gitignored, and NOT rebuilt
  // by `git checkout`. See BACKLOG-followups.md #111 for the reproduction
  // (a stale compiled `@crm/shared` made a real fix look like it changed
  // nothing, or a fresh regression look pre-existing) and the sibling fix in
  // apps/api/vitest.config.mts / apps/web/vitest.config.ts
  // (task-infra-shared-build-freshness, 2026-08-25).
  //
  // '@crm/shared/public' MUST be listed before the plain '@crm/shared' entry
  // — Vite/@rollup/plugin-alias matches importee-startsWith in array/object-
  // key order, and '@crm/shared/public'.startsWith('@crm/shared/') is ALSO
  // true, so the general entry would otherwise shadow this one and wrongly
  // resolve to a subpath of a FILE (index.ts), not a directory. Same pattern
  // as apps/landing/vite.config.ts's build-time alias.
  resolve: {
    alias: {
      '@crm/shared/public': path.resolve(worktreeRoot, 'packages/shared/src/public.ts'),
      '@crm/shared': path.resolve(worktreeRoot, 'packages/shared/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'happy-dom',
    setupFiles: ['./app/test/setup.ts'],
    include: ['app/**/*.{spec,test}.{ts,tsx}'],
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
