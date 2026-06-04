import { defineConfig } from 'vitest/config'
import path from 'path'
import { existsSync, readFileSync, statSync } from 'fs'

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
  // mainRepo   = gitdirPath minus the last 3 segments
  const mainGitDir = path.dirname(path.dirname(path.dirname(gitdirPath))) // → <mainRepo>/.git
  const mainRepo = path.dirname(mainGitDir) // → <mainRepo>
  return existsSync(path.join(mainRepo, 'node_modules')) ? mainRepo : null
}

const mainRepoRoot = resolveMainRepoRoot()
const isWorktree = mainRepoRoot !== null
const mainApiNodeModules = mainRepoRoot ? `${mainRepoRoot}/apps/api/node_modules` : ''
const mainRootNodeModules = mainRepoRoot ? `${mainRepoRoot}/node_modules` : ''
const worktreeRoot = path.resolve(__dirname, '../..')

export default defineConfig({
  ...(isWorktree && {
    resolve: {
      alias: {
        // Point bare-module imports to the main repo's installed packages.
        // pnpm uses a flat node_modules structure via symlinks, so resolving
        // to the api-level node_modules covers NestJS, Drizzle, pdf-lib etc.
      },
    },
  }),
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.{spec,test}.ts'],
    ...(isWorktree && {
      // Extend vitest's server module resolution to include main repo's packages.
      server: {
        fs: {
          allow: [worktreeRoot, mainRepoRoot!, mainApiNodeModules, mainRootNodeModules],
        },
      },
    }),
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.module.ts', 'src/main.ts', 'src/**/*.spec.ts', 'src/**/*.test.ts'],
    },
  },
})
