import path from 'path'
import { existsSync } from 'fs'

/**
 * Walks up from `startDir` looking for `pnpm-workspace.yaml` — the one
 * marker file that identifies the monorepo root in EVERY context either
 * `vite.config.ts` or `vitest.config.ts` can be loaded from:
 *
 *   - the primary checkout, and a `git worktree` checkout of it (both have
 *     `pnpm-workspace.yaml` at the same relative depth as `.git`);
 *   - a StrykerJS mutation-testing sandbox
 *     (`apps/web/.stryker-tmp/sandbox-<id>/`, TWO levels deeper than
 *     `apps/web` itself — Stryker copies just the `apps/web` package tree
 *     into the sandbox, so the walk-up has to escape the sandbox and
 *     `.stryker-tmp` before it reaches anything real);
 *   - the Docker build context (`nginx/Dockerfile`'s `crm-builder` stage
 *     `COPY`s `pnpm-workspace.yaml` to the image root, but `.dockerignore`
 *     excludes `.git/` entirely — a `.git`-anchored walk-up throws there
 *     the moment anything tries to use it, which is why this file exists:
 *     this used to be a `.git`-anchored `findGitRoot()` living only in
 *     `vitest.config.ts`, correct for the sandbox case above but a latent
 *     Docker landmine and duplicated nowhere `vite.config.ts` needed the
 *     same computation).
 *
 * A wrong root does not error immediately — it silently mis-resolves
 * `@crm/shared` / `@crm/shared-i18n-locales` to a path that looks plausible
 * until something imports it. Refuse to guess: return `null` and let the
 * caller fail loud.
 */
export function findMonorepoRoot(startDir: string): string | null {
  let dir = startDir
  for (let i = 0; i < 10; i++) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}
