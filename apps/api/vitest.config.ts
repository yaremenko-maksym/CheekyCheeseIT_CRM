import { defineConfig } from 'vitest/config'
import path from 'path'
import { existsSync } from 'fs'

// When running from a git worktree that has no node_modules of its own,
// resolve packages from the main repo's node_modules so tests can import
// @nestjs/*, pdf-lib, drizzle-orm, etc. without a full `pnpm install`.
const mainRepoRoot = '/Users/maksym/Desktop/programming/CheekyCheeseIT_CRM'
const worktreeRoot = path.resolve(__dirname, '../..')
const isWorktree = worktreeRoot !== mainRepoRoot && existsSync(`${mainRepoRoot}/node_modules`)
const mainApiNodeModules = `${mainRepoRoot}/apps/api/node_modules`
const mainRootNodeModules = `${mainRepoRoot}/node_modules`

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
          allow: [worktreeRoot, mainRepoRoot, mainApiNodeModules, mainRootNodeModules],
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
