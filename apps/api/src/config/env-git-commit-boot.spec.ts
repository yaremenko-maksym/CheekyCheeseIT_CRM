/**
 * security-review round 2 (task-cascade-apply, SR-H-1) — boot-level proof
 * that a garbage GIT_COMMIT does not crash-loop the API on startup.
 *
 * `env.spec.ts` already proves `validateEnv()` itself does not throw on a
 * garbage GIT_COMMIT — but that calls the function directly, and a direct
 * call was NOT enough the first time this build-fingerprint feature shipped
 * a boot-crashing defect: the EMPTY-STRING case (see env.ts's own doc on
 * GIT_COMMIT/BUILD_TIME) was found only by actually building and booting
 * the real API image, because a synthetic call to `validateEnv()` does not
 * exercise the exact wiring `main.ts`'s bootstrap goes through —
 * `ConfigModule.forRoot({ validate: validateEnv })`, called as part of
 * `AppModule`'s own `@Module({...})` decorator.
 *
 * This spec goes one layer closer to that real wiring without needing a
 * live Postgres/Redis or an actual Docker build: `app.module.ts`'s
 * `ConfigModule.forRoot({ validate: validateEnv })` call runs env
 * validation the MOMENT the module is EVALUATED — before any DI resolution
 * happens (see `app.module.spec.ts`'s own doc block, which measured this
 * exact fact for a *missing* required var, and explains why importing
 * `app.module.ts` never opens a live DB/Redis connection: that only
 * happens when a provider is actually CONSTRUCTED, e.g. by
 * `Test.createTestingModule(...).compile()`, which this file never calls).
 * Importing the real `app.module.ts` with a garbage GIT_COMMIT set is the
 * closest a non-integration spec can get to "does the process crash-loop
 * on boot" for this defect — the same class of gap that made the
 * empty-string case invisible to a `validateEnv()`-only test.
 *
 * Own file, not appended to `app.module.spec.ts`: vitest's default
 * `pool: 'forks'` isolates module state PER SPEC FILE, and `GIT_COMMIT`
 * has to be set on `process.env` BEFORE this file's own dynamic import of
 * `app.module.ts` runs — sharing a file with `app.module.spec.ts`'s own
 * `beforeAll` (which never sets GIT_COMMIT) would race two different
 * env-var setups against ONE shared, cached module import.
 */
import 'reflect-metadata'
import { beforeAll, describe, expect, it } from 'vitest'

describe('AppModule evaluation — a garbage GIT_COMMIT must not crash boot (SR-H-1)', () => {
  beforeAll(() => {
    // Same required-var shape as app.module.spec.ts's own beforeAll — see
    // that file for why `||=`, not `??=`: this repo's git-policy pushes
    // feature branches as `DATABASE_URL=` (an explicit EMPTY string, not
    // unset), which the pre-push hook's full `pnpm test` run inherits into
    // every worker's env.
    process.env['DATABASE_URL'] ||= 'postgresql://test:test@localhost:5432/test'
    process.env['REDIS_URL'] ||= 'redis://localhost:6379'
    process.env['GOOGLE_CLIENT_ID'] ||= 'test-google-client-id'
    process.env['GOOGLE_CLIENT_SECRET'] ||= 'test-google-client-secret'
    process.env['GOOGLE_CALLBACK_URL'] ||= 'http://localhost:3001/api/auth/google/callback'
    process.env['JWT_SECRET'] ||= 'x'.repeat(40)
    process.env['SESSION_SECRET'] ||= 'x'.repeat(40)
    // The exact real-world trigger (SR-H-1): a manual workflow_dispatch
    // `image_tag` that is a moving tag, not a SHA — deploy.yml pushes a
    // `main` tag alongside every SHA-tagged image, and the documented
    // emergency-rollback flow (docs/runbooks/deployment.md §Rollback) sends
    // an operator to exactly that tag list. See env.ts's GIT_COMMIT comment
    // for the full deploy.yml chain.
    process.env['GIT_COMMIT'] = 'main'
  })

  it("AppModule's ConfigModule.forRoot(validateEnv) resolves instead of rejecting", async () => {
    const { AppModule } = await import('../app.module')

    // `ConfigModule.forRoot({ validate: validateEnv, ... })` is `static
    // async` — it calls `validateEnv` SYNCHRONOUSLY inside that async
    // function, before its own first `await`, so a throw there produces an
    // ALREADY-REJECTED promise the instant `app.module.ts`'s `@Module({
    // imports: [ConfigModule.forRoot(...), ...] })` decorator evaluates —
    // i.e. during the `import(...)` above, not later. Nest's `imports`
    // array is typed to accept that promise directly (unawaited); nothing
    // in a plain `import()` ever awaits it. A naive
    // `await expect(import('../app.module')).resolves.toBeDefined()` was
    // tried here first and is why this comment exists: the dynamic import
    // itself always resolves regardless of the defect (the decorator
    // finished evaluating, `AppModule` the CLASS is defined either way) —
    // the rejection instead surfaced as an "unhandled rejection" printed by
    // vitest's own process-level listener, on a DIFFERENT tick, with the
    // `it()` block itself still reporting "passed". That is a real signal
    // (it does fail the overall run — verified: non-zero exit both with
    // `vitest run` locally and via this repo's pre-push hook, which is what
    // actually gates a push) but a misleading one to leave committed: a
    // reviewer reading "1 passed" would reasonably believe this test proved
    // something it did not directly assert.
    //
    // So: read the exact promise instance that decorator argument
    // evaluation produced back out of Nest's own module metadata
    // (`Reflect.getMetadata('imports', AppModule)` — same mechanism
    // `app.module.spec.ts` already uses for `'providers'`) and await THAT
    // directly. This attaches a handler before the "unhandled" window
    // closes and turns the same failure into a normal, local, readable
    // assertion failure instead of a side-channel process warning.
    const imports = Reflect.getMetadata('imports', AppModule) as unknown[]
    await expect(Promise.all(imports)).resolves.toBeDefined()
  })
})
