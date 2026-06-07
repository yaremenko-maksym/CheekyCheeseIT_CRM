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
