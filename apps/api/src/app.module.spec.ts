import 'reflect-metadata'
import { APP_GUARD } from '@nestjs/core'
import { beforeAll, describe, expect, it } from 'vitest'
import { JwtAuthGuard } from './auth/jwt.guard'
import { OnboardingGuard } from './auth/onboarding.guard'
import { UserAwareThrottlerGuard } from './common/guards/user-aware-throttler.guard'
import type { AppModule as AppModuleType } from './app.module'

/**
 * MED-2, security review round on #532: neither existing throttler test
 * builds the REAL `AppModule` — `contracts/throttle.integration.spec.ts` and
 * `common/guards/user-aware-throttler.guard.spec.ts` both construct their OWN
 * sentinel modules that happen to wire guards in the right order. A silent
 * reorder in the ACTUAL `app.module.ts` (e.g. moving
 * `UserAwareThrottlerGuard` back before the auth guards, undoing #52's fix so
 * `getTracker` reads `req.user` before `JwtAuthGuard` ever populates it)
 * would sail through every existing test untouched. This is the exact class
 * of gap `onboarding.guard.integration.spec.ts`'s own header documents
 * (Reviewer #4415687659, PR #83) — same file, same lesson, not yet applied
 * to the guard registered after it.
 *
 * This test reads `AppModule`'s declared `@Module({...})` metadata from the
 * ACTUAL class — not a reconstruction — via `Reflect.getMetadata`. That is
 * how Nest's own `@Module` decorator stores `providers`: a plain
 * `Reflect.defineMetadata(property, metadata[property], target)` inside the
 * decorator function (`@nestjs/common/decorators/modules/module.decorator.js`),
 * unrelated to TypeScript's `emitDecoratorMetadata` that vitest's esbuild
 * transform strips (the thing that forces `useFactory` patterns elsewhere in
 * this codebase's integration specs). Merely IMPORTING `app.module.ts`
 * evaluates its decorator and every module it imports, but instantiates
 * nothing — no DI resolution, so no live Postgres/Redis connection ever
 * opens (that only happens when a provider is actually constructed, e.g. by
 * `Test.createTestingModule(...).compile()`, which this test deliberately
 * never calls). That is what makes this safe to run as a plain unit spec,
 * not an `*.integration.spec.ts`.
 *
 * WHY THE IMPORT IS DYNAMIC, NOT STATIC
 * ---------------------------------------------------------------------
 * `AppModule`'s own `ConfigModule.forRoot({ validate: validateEnv })` runs
 * env validation the moment `app.module.ts` is EVALUATED (not lazily at DI
 * time — measured: a static import with no env vars set threw an unhandled
 * rejection out of `ConfigModule.forRoot` before a single assertion ran).
 * Every required var must therefore exist BEFORE the module is loaded. A
 * static `import { AppModule } from './app.module'` at the top of this file
 * would not allow that: ES module imports are hoisted above all other
 * top-level code, so any `process.env.X = ...` written below it would run
 * too late regardless of source order. `import('./app.module')` inside
 * `beforeAll` executes exactly where it is called, at runtime — after the
 * env stubs below.
 *
 * MUTATION VERIFICATION (manual)
 * -------------------------------------------------------------------------
 * `app.module.ts` matches `src/**\/*.module.ts`, which `mutation-gate.mjs`
 * excludes from EVERY package's scan unconditionally (DI wiring is called
 * out by name in that file's own comment as something a unit suite cannot
 * mutate meaningfully) — so `pnpm mutation:changed` will never generate a
 * mutant here, plain `.spec.ts` or not. Verified by hand instead: (1)
 * reordered `UserAwareThrottlerGuard` before the auth guards in
 * `app.module.ts` — the FIRST test below failed, printing the exact
 * before/after array diff; (2) duplicated the `JwtAuthGuard` entry — BOTH
 * tests failed (order-mismatch and count-mismatch respectively). Both
 * mutations applied, observed red, and reverted (`git diff` against the
 * committed `app.module.ts` empty after each revert).
 */
describe('AppModule — real APP_GUARD registration order (MED-2, #532 review)', () => {
  let AppModule: typeof AppModuleType

  beforeAll(async () => {
    // Harmless placeholders — never connected to, never read for their
    // content by anything this test exercises (see the file doc above).
    // `||=`, not `??=`: this repo's git-policy pushes feature branches as
    // `DATABASE_URL= git push` (an explicit EMPTY string, not unset — see
    // .claude/rules/common/git-policy.md's data-safety section), which the
    // pre-push hook's full `pnpm test` run inherits into every worker's
    // env. `??=` only replaces `null`/`undefined` and leaves an empty
    // string untouched, which is exactly ambient here and is what made this
    // fail its own `DATABASE_URL: Too small` check the first time this ran
    // under a real `git push`. `||=` treats '' as falsy too, and there is no
    // legitimate reason any of these would ever be intentionally empty, so
    // this cannot silently swallow a real ambient value either.
    process.env['DATABASE_URL'] ||= 'postgresql://test:test@localhost:5432/test'
    process.env['REDIS_URL'] ||= 'redis://localhost:6379'
    process.env['GOOGLE_CLIENT_ID'] ||= 'test-google-client-id'
    process.env['GOOGLE_CLIENT_SECRET'] ||= 'test-google-client-secret'
    process.env['GOOGLE_CALLBACK_URL'] ||= 'http://localhost:3001/api/auth/google/callback'
    process.env['JWT_SECRET'] ||= 'x'.repeat(40)
    process.env['SESSION_SECRET'] ||= 'x'.repeat(40)
    ;({ AppModule } = await import('./app.module'))
  })

  it('registers JwtAuthGuard, then OnboardingGuard, then UserAwareThrottlerGuard — in that exact order', () => {
    const providers = Reflect.getMetadata('providers', AppModule) as unknown[]
    expect(Array.isArray(providers)).toBe(true)

    const guardClasses = providers
      .filter(
        (p): p is { provide: unknown; useClass: unknown } =>
          typeof p === 'object' &&
          p !== null &&
          'provide' in p &&
          (p as { provide: unknown }).provide === APP_GUARD,
      )
      .map((p) => p.useClass)

    // `req.user` must exist before OnboardingGuard reads it, and before
    // UserAwareThrottlerGuard's `getTracker` reads it (backlog #52) — both
    // depend on JwtAuthGuard running FIRST. Any reorder, removal, or
    // duplicate breaks this exact-array match.
    expect(guardClasses).toEqual([JwtAuthGuard, OnboardingGuard, UserAwareThrottlerGuard])
  })

  it('registers exactly three APP_GUARD providers — no silent fourth guard slipping in unordered', () => {
    const providers = Reflect.getMetadata('providers', AppModule) as unknown[]
    const guardCount = providers.filter(
      (p) =>
        typeof p === 'object' && p !== null && (p as { provide?: unknown }).provide === APP_GUARD,
    ).length
    expect(guardCount).toBe(3)
  })
})
