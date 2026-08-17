import 'reflect-metadata'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readdirSync, rmdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Module } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * Backlog #42 — "нет теста, поднимающего приложение целиком".
 *
 * 2026-08-10, #504: the API failed at startup with `UnknownDependenciesException`
 * on `ResumeTypstService` (a constructor parameter typed by a callable
 * INTERFACE degrades to a bare `Function` token once TypeScript erases it —
 * Nest then looks for a provider registered under `Function`, finds none, and
 * throws while building the module graph, before the first request). Every
 * unit test and local E2E run was green: unit tests construct services by
 * hand (`new ResumeTypstService(...)`), never touching Nest's DI container at
 * all, so a broken *wiring* can never surface there.
 *
 * `app.module.spec.ts` (from #532) looks like it closes this gap — it is
 * literally named `AppModule — real APP_GUARD registration order` and reads
 * `AppModule`'s `@Module({...})` metadata — but its own header says plainly
 * that it never calls `.compile()`: it reads `providers` via
 * `Reflect.getMetadata`, which requires nothing more than IMPORTING the
 * class. No provider in that file is ever constructed, so a class whose
 * constructor cannot be satisfied would never be noticed by it. Kept as-is
 * (AC3) — it still correctly pins the three `APP_GUARD`s' registration order,
 * a real and separate regression class.
 *
 * ============================================================================
 * WHY THIS TEST CANNOT SIMPLY DO `Test.createTestingModule({ imports:
 * [AppModule] }).compile()` ON THE SOURCE-LEVEL `AppModule` LIKE EVERY OTHER
 * SPEC IN THIS PACKAGE — AND WHY THAT IS NOT A CHOICE THIS TEST GETS TO MAKE
 * ============================================================================
 * vitest transforms TypeScript with esbuild. esbuild does not implement
 * `emitDecoratorMetadata` — full stop, for EVERY constructor parameter,
 * whether its type is a class or an interface. Measured directly (three
 * throwaway probes, see PR description / commit body for the exact output):
 *
 *   1. A plain `@Injectable()` class with ONE implicit, undecorated,
 *      class-typed constructor parameter and NO other decorator on the same
 *      constructor: `Reflect.getMetadata('design:paramtypes', Ctor)` is
 *      `undefined` under vitest, and `Test.createTestingModule(...).compile()`
 *      does **not** throw — it silently constructs the class with the
 *      parameter bound to `undefined`. No exception, ever, from this shape.
 *   2. The SAME class, but with `@Inject(TOKEN)` explicit and TOKEN never
 *      provided anywhere: `.compile()` DOES throw `UnknownDependenciesException`
 *      — explicit `@Inject()` tokens are plain decorator arguments (real JS
 *      values in the source), not derived from `design:paramtypes`, so they
 *      survive esbuild untouched.
 *   3. The REAL, unmodified `AppModule`, imported at the SOURCE level (exactly
 *      as `app.module.spec.ts` already does dynamically): `.compile()` throws
 *      on `JwtAuthGuard` and then, once that is worked around, on
 *      `UsersService` — NEITHER for a real defect. Both mix an explicit
 *      `@Inject(forwardRef(...))` param (needed for a circular module import,
 *      unrelated to this bug class) with other IMPLICIT class-typed params in
 *      the SAME constructor. That mix is what makes Nest notice the
 *      constructor has multiple parameters at all and then fail to resolve
 *      the undecorated ones (case 1 above, with no decorator anywhere, Nest
 *      silently assumes zero constructor dependencies and never even looks).
 *      `forwardRef` is used across ~8 files in this package for real circular
 *      module graphs (auth ↔ users ↔ teams ↔ projects ↔ finance), so this is
 *      not one or two isolated classes — it is most of the graph's backbone.
 *
 * In short: under vitest, a source-level `.compile()` of the real `AppModule`
 * is BLIND to the entire class of bug #42 exists to catch (case 1 — the exact
 * #504 shape) and simultaneously FALSE-POSITIVES on dozens of already-correct
 * circular-dependency classes (case 3) for a completely unrelated reason. A
 * test built that way would either need to `.overrideProvider()`/stub every
 * single one of those classes (defeating "the graph must resolve for real" —
 * `UsersService` alone is injected, directly or transitively, by more than
 * half the feature modules) or it would silently pass on the one thing it
 * exists to catch. Either is worse than not having the test.
 *
 * `jwt.guard.ts`'s own class doc already documents this exact defect for
 * itself ("Two independent declaration details break [metadata] emission...
 * VITEST TRANSFORMS TYPESCRIPT WITH ESBUILD, WHICH DOES NOT IMPLEMENT
 * `emitDecoratorMetadata`"), as does `onboarding.guard.integration.spec.ts`'s
 * header ("vitest uses esbuild, which does NOT emit TypeScript decorator
 * constructor-parameter metadata... Explicit `useFactory` resolves the
 * dependency via the test module's injector instead of relying on metadata")
 * — this is a KNOWN, repeatedly-hit, structural property of this package's
 * test toolchain, not something newly discovered here.
 *
 * ============================================================================
 * THE FIX: COMPILE THE REAL THING, THEN TEST THE ARTEFACT THAT ACTUALLY SHIPS
 * ============================================================================
 * `scripts/check-di-metadata.cjs` (the #504 fix's own build-time guard) took
 * exactly this position: "the check reads the artefact that actually ships…
 * rather than in a spec that would be structurally blind to it." This test
 * applies the same idea to `.compile()`: `beforeAll` compiles this package's
 * real sources with `tsc -p tsconfig.build.json` (the exact `emitDecoratorMetadata:
 * true` settings `node dist/main.js` boots from in production — the ONLY
 * thing that differs from a plain `pnpm --filter @crm/api build` is the
 * output directory, see "WHERE IT BUILDS TO" below) and `require()`s the
 * compiled `app.module.js` — plain Node `require` of already-compiled JS,
 * never touched by vitest's esbuild transform, so it carries the SAME
 * `design:paramtypes` metadata production carries. `Test.createTestingModule`
 * then resolves the REAL graph exactly as `nest start`/`node dist/main.js`
 * would: no source-level workarounds, no per-class overrides, no guard
 * stubbing needed anywhere (verified — the compiled `AppModule` compiles
 * clean with a bare `{ imports: [AppModule] }` test module and nothing else).
 *
 * `.compile()` is deliberately never followed by `.init()`: `.compile()`
 * alone instantiates every singleton provider (that IS where Nest resolves —
 * or fails to resolve — the DI graph; `UnknownDependenciesException` is
 * thrown from exactly this step) but never invokes `onModuleInit` /
 * `onApplicationBootstrap`. `DatabaseService.onModuleInit` is the only place
 * in this package that opens a real `pg.Pool` — since it never runs, no live
 * Postgres/Redis/S3 connection is ever attempted, and no provider override is
 * needed for any of them either.
 *
 * Relationship to `check-di-metadata.cjs`: complementary, not duplicate.
 * That script is a STATIC pattern scan over compiled output for one specific
 * shape (a bare `Function`/`Object` paramtype with no `@Inject`) — fast, but
 * blind to anything that is not that exact shape: a correctly-typed class
 * dependency whose PROVIDING MODULE was simply never imported (AC2's
 * demonstration below reproduces exactly this second shape), duplicate
 * bindings, wrong scope, etc. This test performs REAL graph resolution via
 * Nest's own injector, so it catches the general class `check-di-metadata.cjs`
 * cannot: any reason the container fails to build, not only this one pattern.
 * Neither replaces the other; together they are defense in depth — one at
 * `pnpm build` time (already wired), one now at `pnpm test` time (this file).
 *
 * ============================================================================
 * AC2 — MANUAL VERIFICATION (this test DOES turn red on the #504 shape)
 * ============================================================================
 * `ResumeTypstService`'s constructor was temporarily reverted to the exact
 * pre-fix #504 shape:
 *
 *     constructor(
 *       runner: TypstRunner = spawnTypst,                              // BUG
 *       @Optional() @Inject(RESUME_SCRATCH_ROOT) scratchRoot?: string,
 *     ) { this.runner = runner; this.scratchRoot = scratchRoot ?? tmpdir() }
 *
 * — an interface-typed parameter with a default value, no `@Inject()` token,
 * exactly what shipped in #504. `pnpm --filter @crm/api exec vitest run
 * src/app.module.container.spec.ts` against that mutation failed with:
 *
 *   Error: Nest can't resolve dependencies of the ResumeTypstService
 *   (?, Symbol(RESUME_SCRATCH_ROOT)). Please make sure that the argument
 *   Function at index [0] is available in the SeniorResumesModule module.
 *
 * — "argument Function at index [0]" is the identical failure signature
 * quoted in the #504 fix commit's own postmortem ("design:paramtypes =
 * ['Function']"). The mutation was then reverted; `git diff` against the
 * committed `resume-typst.service.ts` is empty (verified). This is the same
 * apply → observe red → revert → verify-clean-diff discipline
 * `app.module.spec.ts`'s own "MUTATION VERIFICATION (manual)" section already
 * uses for the guard-order assertions, applied here to the same file's
 * sibling test.
 *
 * The SECOND `it()` below reproduces the alternate shape the task explicitly
 * allows ("провайдер без регистрации") automatically, on every run, without
 * mutating any shipped source: `AdminSummaryService` is depended on via an
 * explicit `@Inject(AdminSummaryService)` token (see `admin.controller.ts`)
 * — immune to the metadata gap above by construction — so simply never
 * registering it as a provider is a clean, permanent, zero-mutation red/green
 * demonstration that the SAME mechanism (`Test.createTestingModule(...).compile()`
 * against the compiled artefact) catches "required dependency, never
 * registered anywhere" every time this file runs, not just once by hand.
 *
 * ============================================================================
 * WHERE IT BUILDS TO, AND WHY (review round on PR #550, MED-1)
 * ============================================================================
 * An earlier version of this file shelled out to `pnpm exec nest build`
 * unconditionally on every single run and described that in the PR body as
 * "reusing" the production build. That description was false: `nest build`
 * runs with this package's `nest-cli.json` `deleteOutDir: true` and no
 * `incremental` setting, against the SAME `dist/` a developer's `pnpm dev` /
 * `pnpm build` / the deploy pipeline also write to — so it was a SECOND full
 * compile on every `pnpm test`, and a real target for a directory-delete race
 * against any of those other writers (a review-caught defect: the honesty gap
 * was the actual finding, not just the missing reuse).
 *
 * This version fixes both problems together:
 *
 *   - Builds via plain `tsc -p tsconfig.build.json` (this package's own
 *     production compiler settings — `nest build` is @nestjs/cli's wrapper
 *     around the SAME `tsc` invocation, plus asset-copying this test never
 *     reads) into a DEDICATED cache directory (`.build-cache/dist/`, see
 *     `CACHE_DIR` below) that `pnpm dev`/`pnpm build`/deploy never touch — no
 *     shared-directory collision with them is possible regardless of timing.
 *   - Before compiling, `isCacheFresh()` compares the cache's newest output
 *     mtime against the newest mtime across EVERY file this build depends on:
 *     all of `src/**`, plus `tsconfig.json`, `tsconfig.build.json`, and the
 *     monorepo root `tsconfig.base.json` `tsconfig.json` extends. Only when
 *     the cache is strictly newer than ALL of them is the compile skipped —
 *     a single stale/missing input fails the freshness check and triggers a
 *     rebuild, so this can under-trust the cache (rebuild when nothing
 *     actually changed) but can never over-trust it (silently run a stale
 *     graph). The one gap inherent to any mtime-based cache: a file DELETION
 *     with no corresponding edit anywhere else touches no mtime this check
 *     reads — accepted as the same class of limitation `tsc --incremental`'s
 *     own `.tsbuildinfo` and every other timestamp-based build cache carries.
 *   - `withBuildLock()` makes concurrent `pnpm test` invocations IN THE SAME
 *     worktree safe against each other (the scenario the review flagged):
 *     an exclusive lock via `fs.mkdirSync` (atomic — EEXIST when another
 *     process holds it), a short poll loop for the holder to finish, and a
 *     freshness RE-check after acquiring the lock — the second process to
 *     arrive almost always finds the first process's build already fresh and
 *     skips its own compile entirely rather than racing it. Two SEPARATE
 *     agents each get their own git worktree (a separate `apps/api` on a
 *     separate filesystem path), so cross-agent collision on this literal
 *     directory does not arise in the first place; this lock exists for the
 *     narrower, still-real case of two processes in ONE checkout (e.g. a
 *     manual re-run racing the pre-push hook's own `pnpm test`).
 *
 * ============================================================================
 * COST (measured, not the "free reuse" the earlier version of this file claimed)
 * ============================================================================
 * Cold (no cache, or a stale one — the common case on CI, which starts from a
 * clean checkout every run): ~5 s for the `tsc -p tsconfig.build.json`
 * compile (measured locally; NOT the same artefact as, and NOT reused from,
 * `pnpm --filter @crm/api build`'s own `dist/` — this really is a second
 * compile, spelled out honestly here). Warm (cache fresh — the common case
 * for a developer or agent re-running `pnpm test` repeatedly against
 * unchanged sources): the freshness check itself, low tens of ms, no compile
 * at all. `.compile()` itself is fast either way (tens of ms). Wired into the
 * ordinary `pnpm test` (`vitest run`, no filter) like every other `*.spec.ts`
 * in this package — no opt-in flag, no separate script, no `describe.skip`:
 * the whole point of backlog #42 is that this class of bug is caught by an
 * ORDINARY run, not an opt-in one.
 */

const API_ROOT = join(__dirname, '..')
const req = createRequire(join(API_ROOT, 'package.json'))
const CACHE_DIR = join(API_ROOT, '.build-cache', 'dist')
const LOCK_DIR = join(API_ROOT, '.build-cache', '.lock')
const MARKER = join(CACHE_DIR, 'app.module.js')

/** Every file this compile's OUTPUT depends on — walked fresh each run. */
function inputFiles(): string[] {
  const files: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else files.push(full)
    }
  }
  walk(join(API_ROOT, 'src'))
  files.push(
    join(API_ROOT, 'tsconfig.json'),
    join(API_ROOT, 'tsconfig.build.json'),
    join(API_ROOT, '..', '..', 'tsconfig.base.json'),
  )
  return files
}

/**
 * Strictly newer than EVERY input, not just one — a single stale/missing
 * input is enough to force a rebuild (see file doc, "WHERE IT BUILDS TO").
 */
function isCacheFresh(): boolean {
  if (!existsSync(MARKER)) return false
  const cacheMtime = statSync(MARKER).mtimeMs
  return inputFiles().every((f) => statSync(f).mtimeMs < cacheMtime)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Exclusive lock across processes sharing this worktree (see file doc).
 *
 * `mkdirSync` is atomic-exclusive ONLY without `{ recursive: true }` — with
 * it, mkdir is `mkdir -p` semantics and returns success (not EEXIST) even
 * when the directory already exists, which would make two concurrent
 * callers BOTH believe they hold the lock (caught live during manual
 * concurrency verification for this exact function — two `vitest run`
 * processes launched back to back, second one crashed on `rmdir ENOENT`
 * because the first had already removed the "shared" lock dir out from
 * under it). The parent `.build-cache` directory is created separately,
 * ONCE, with `recursive: true` — safe for multiple processes to race on,
 * since creating an already-existing directory that way is a no-op, not a
 * mutual-exclusion operation.
 */
async function withBuildLock<T>(fn: () => T): Promise<T> {
  mkdirSync(join(API_ROOT, '.build-cache'), { recursive: true })
  const deadline = Date.now() + 55_000
  for (;;) {
    try {
      mkdirSync(LOCK_DIR)
      break
    } catch (err) {
      if ((err as { code?: string }).code !== 'EEXIST') throw err
      if (Date.now() > deadline) {
        throw new Error(`[app.module.container.spec] timed out waiting for build lock ${LOCK_DIR}`)
      }
      await sleep(200)
    }
  }
  try {
    return fn()
  } finally {
    rmdirSync(LOCK_DIR)
  }
}

function buildContainerTestDist(): void {
  try {
    execFileSync('pnpm', ['exec', 'tsc', '-p', 'tsconfig.build.json', '--outDir', CACHE_DIR], {
      cwd: API_ROOT,
      stdio: 'pipe',
    })
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer }
    console.error(
      '[app.module.container.spec] `tsc -p tsconfig.build.json` failed:\n',
      e.stdout?.toString(),
      e.stderr?.toString(),
    )
    throw err
  }
}

describe('AppModule — the real DI container resolves (backlog #42, #504 regression class)', () => {
  let AppModule: new (...args: unknown[]) => object
  let AdminSummaryService: new (...args: unknown[]) => object
  let AdminController: new (...args: unknown[]) => object
  let UsersService: new (...args: unknown[]) => object
  let TransactionsService: new (...args: unknown[]) => object

  beforeAll(async () => {
    // Same required-var set `app.module.spec.ts` stubs (ConfigModule.forRoot's
    // `validate: validateEnv` runs the moment `app.module.ts` is evaluated —
    // i.e. the instant `require(...)` below executes, so every var must exist
    // before that line, not merely before `.compile()`).
    // `||=` (not `??=`): this repo's git-policy pushes feature branches as
    // `DATABASE_URL= git push` — an explicit EMPTY string the pre-push hook's
    // own `pnpm test` run inherits — and `??=` would leave that empty string
    // untouched, failing `DATABASE_URL: Too small`.
    process.env['DATABASE_URL'] ||= 'postgresql://test:test@localhost:5432/test'
    process.env['REDIS_URL'] ||= 'redis://localhost:6379'
    process.env['GOOGLE_CLIENT_ID'] ||= 'test-google-client-id'
    process.env['GOOGLE_CLIENT_SECRET'] ||= 'test-google-client-secret'
    process.env['GOOGLE_CALLBACK_URL'] ||= 'http://localhost:3001/api/auth/google/callback'
    process.env['JWT_SECRET'] ||= 'x'.repeat(40)
    process.env['SESSION_SECRET'] ||= 'x'.repeat(40)

    await withBuildLock(() => {
      // Re-check freshness UNDER the lock: another process may have just
      // finished building while this one was waiting, in which case there is
      // nothing left to do (see file doc, "WHERE IT BUILDS TO").
      if (!isCacheFresh()) buildContainerTestDist()
    })
    ;({ AppModule } = req(join(CACHE_DIR, 'app.module.js'))) as { AppModule: typeof AppModule }
    ;({ AdminSummaryService } = req(join(CACHE_DIR, 'admin/admin-summary.service.js'))) as {
      AdminSummaryService: typeof AdminSummaryService
    }
    ;({ AdminController } = req(join(CACHE_DIR, 'admin/admin.controller.js'))) as {
      AdminController: typeof AdminController
    }
    ;({ UsersService } = req(join(CACHE_DIR, 'users/users.service.js'))) as {
      UsersService: typeof UsersService
    }
    ;({ TransactionsService } = req(join(CACHE_DIR, 'finance/transactions.service.js'))) as {
      TransactionsService: typeof TransactionsService
    }
  }, 60_000)

  // ── AC1 ────────────────────────────────────────────────────────────────
  it('resolves the ENTIRE real module graph via Test.createTestingModule(...).compile() — no stubs, no reconstruction', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()

    // Not merely "did not throw" — pull back real instances from opposite
    // ends of the graph (admin dashboard; users, which sits in the middle
    // of the auth ↔ users ↔ teams ↔ projects ↔ finance circular cluster via
    // forwardRef; finance's own transactions service) to demonstrate actual
    // resolution happened, not a vacuously-empty compile.
    expect(moduleRef.get(AdminSummaryService)).toBeInstanceOf(AdminSummaryService)
    expect(moduleRef.get(UsersService)).toBeInstanceOf(UsersService)
    expect(moduleRef.get(TransactionsService)).toBeInstanceOf(TransactionsService)
  }, 30_000)

  // ── AC2 (automated form — "provider without registration") ─────────────
  it('goes red on a required, never-registered provider — the #504 class this test exists for, reproduced without touching shipped source', async () => {
    // `AdminController` depends on `AdminSummaryService` via an EXPLICIT
    // `@Inject(AdminSummaryService)` token (immune to the esbuild metadata
    // gap by construction — see the file doc above), so the only way this
    // can fail to resolve is exactly backlog #42's class of bug: a required
    // dependency with no provider anywhere in the graph. A synthetic module
    // wrapping ONLY the real (compiled) controller — deliberately omitting
    // `AdminSummaryService` from `providers`, the mistake #42 exists to
    // catch — reproduces that deterministically, every run, with zero
    // mutation of any shipped file.
    @Module({ controllers: [AdminController as new (...args: never[]) => object] })
    class ProviderMissingProbeModule {}

    await expect(
      Test.createTestingModule({ imports: [ProviderMissingProbeModule] }).compile(),
    ).rejects.toThrow(/AdminSummaryService/)
  }, 30_000)
})
