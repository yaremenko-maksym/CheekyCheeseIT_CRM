import 'reflect-metadata'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
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
 * applies the same idea to `.compile()`: `beforeAll` runs the REAL `nest
 * build` (`tsc` with this package's own `tsconfig.build.json`, which has
 * `emitDecoratorMetadata: true` — the exact settings `node dist/main.js`
 * boots from in production) into `dist/`, then `require()`s the COMPILED
 * `dist/app.module.js` — plain Node `require` of already-compiled JS, never
 * touched by vitest's esbuild transform, so it carries the SAME
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
 * COST
 * ============================================================================
 * `beforeAll` runs a full `nest build` (~6-7 s locally, measured; this is the
 * SAME `tsc` invocation `pnpm --filter @crm/api build` already pays on every
 * deploy — nothing new is compiled that would not be compiled anyway). The
 * `.compile()` calls themselves are fast (tens of ms once the compiled JS is
 * loaded). Total file run time: ~7 s, dominated entirely by the build step.
 * Wired into the ordinary `pnpm test` (`vitest run`, no filter) like every
 * other `*.spec.ts` in this package — no opt-in flag, no separate script.
 * The one-time cost buys the ONLY test in this package that boots the real,
 * complete, unmodified DI graph the way production actually does.
 */

const API_ROOT = join(__dirname, '..')
const req = createRequire(join(API_ROOT, 'package.json'))

describe('AppModule — the real DI container resolves (backlog #42, #504 regression class)', () => {
  let AppModule: new (...args: unknown[]) => object
  let AdminSummaryService: new (...args: unknown[]) => object
  let AdminController: new (...args: unknown[]) => object
  let UsersService: new (...args: unknown[]) => object
  let TransactionsService: new (...args: unknown[]) => object

  beforeAll(() => {
    // Same required-var set `app.module.spec.ts` stubs (ConfigModule.forRoot's
    // `validate: validateEnv` runs the moment `app.module.ts` is evaluated —
    // i.e. the instant `require('./dist/app.module.js')` below executes, so
    // every var must exist before that line, not merely before `.compile()`).
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

    // Real `tsc` build (this package's own `tsconfig.build.json`,
    // `emitDecoratorMetadata: true`) — see the file doc above for why nothing
    // short of the actual compiled artefact can see this bug class under
    // vitest. `pnpm exec` resolves the workspace-local `nest` binary the same
    // way `pnpm --filter @crm/api build` does; `stdio: 'pipe'` keeps a
    // passing run quiet, the catch block surfaces the real compiler output on
    // failure instead of a bare non-zero exit code.
    try {
      execFileSync('pnpm', ['exec', 'nest', 'build'], { cwd: API_ROOT, stdio: 'pipe' })
    } catch (err) {
      const e = err as { stdout?: Buffer; stderr?: Buffer }
      console.error(
        '[app.module.container.spec] `nest build` failed:\n',
        e.stdout?.toString(),
        e.stderr?.toString(),
      )
      throw err
    }

    ;({ AppModule } = req(join(API_ROOT, 'dist/app.module.js'))) as { AppModule: typeof AppModule }
    ;({ AdminSummaryService } = req(join(API_ROOT, 'dist/admin/admin-summary.service.js'))) as {
      AdminSummaryService: typeof AdminSummaryService
    }
    ;({ AdminController } = req(join(API_ROOT, 'dist/admin/admin.controller.js'))) as {
      AdminController: typeof AdminController
    }
    ;({ UsersService } = req(join(API_ROOT, 'dist/users/users.service.js'))) as {
      UsersService: typeof UsersService
    }
    ;({ TransactionsService } = req(join(API_ROOT, 'dist/finance/transactions.service.js'))) as {
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
    // wrapping ONLY the real (dist-compiled) controller — deliberately
    // omitting `AdminSummaryService` from `providers`, the mistake #42
    // exists to catch — reproduces that deterministically, every run, with
    // zero mutation of any shipped file.
    @Module({ controllers: [AdminController as new (...args: never[]) => object] })
    class ProviderMissingProbeModule {}

    await expect(
      Test.createTestingModule({ imports: [ProviderMissingProbeModule] }).compile(),
    ).rejects.toThrow(/AdminSummaryService/)
  }, 30_000)
})
