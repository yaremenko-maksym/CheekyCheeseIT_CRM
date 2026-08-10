import { JwtAuthGuard } from './jwt.guard'

/**
 * Bootstrap-time assertion that every DI-built `JwtAuthGuard` actually received
 * its `UsersService`.
 *
 * ── Why this exists as a startup check and not as a test ────────────────────
 *
 * `JwtAuthGuard` re-hydrates role + archived status from the database on every
 * request (see that file's AC2 block). That whole path is skipped when the
 * container hands the guard an `undefined` service — and the guard then trusts
 * whatever the JWT says. The failure is silent: no error, no log, every route
 * keeps answering 200.
 *
 * A test cannot catch it. Our unit/integration runner (vitest + esbuild) does
 * not emit decorator metadata at all, so a guard built by the testing container
 * receives NO constructor arguments whatever the source declaration says — the
 * broken and the fixed declaration are indistinguishable there. The defect only
 * exists in the compiled artifact (`tsc` + `emitDecoratorMetadata`), which is
 * precisely what production runs. So the check has to run in the artifact, at
 * startup, and it has to be fatal: a process that cannot enforce role
 * revocation must not accept traffic.
 *
 * Both known root causes are token-emission problems, so the assertion
 * deliberately inspects the RESOLVED INSTANCE rather than the declaration: it
 * is agnostic to how the token was produced and stays valid if the emission
 * rules change again.
 */

/** Structural subset of Nest's `InstanceWrapper` used here. */
interface InstanceWrapperLike {
  instance?: unknown
}

/** Structural subset of Nest's `Module` used here. */
interface ModuleLike {
  metatype?: { name?: string } | null
  providers: ReadonlyMap<unknown, InstanceWrapperLike>
  injectables: ReadonlyMap<unknown, InstanceWrapperLike>
}

/**
 * Structural subset of Nest's `ModulesContainer` (`Map<string, Module>`).
 * Declared structurally so the assertion is unit-testable with a plain Map.
 */
export type ModulesContainerLike = Iterable<[unknown, ModuleLike]>

export interface LocatedJwtAuthGuard {
  moduleName: string
  guard: JwtAuthGuard
}

export class JwtAuthGuardWiringError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JwtAuthGuardWiringError'
  }
}

/**
 * Every `JwtAuthGuard` the container built, across all modules.
 *
 * `providers` covers the globally registered instance (`APP_GUARD` in
 * AppModule — Nest stores global enhancers as regular module providers under a
 * generated token) and the one AuthModule provides. `injectables` covers
 * `@UseGuards(JwtAuthGuard)` on a controller, which Nest instantiates
 * per-hosting-module: no controller uses that form today, but a future one
 * would create an instance that this assertion must not miss.
 */
export function collectDiJwtAuthGuards(modules: ModulesContainerLike): LocatedJwtAuthGuard[] {
  const found: LocatedJwtAuthGuard[] = []

  for (const [, moduleRef] of modules) {
    const moduleName = moduleRef.metatype?.name ?? '<unnamed module>'
    for (const collection of [moduleRef.providers, moduleRef.injectables]) {
      for (const wrapper of collection.values()) {
        const instance: unknown = wrapper.instance
        if (instance instanceof JwtAuthGuard) {
          found.push({ moduleName, guard: instance })
        }
      }
    }
  }

  return found
}

/**
 * Throws unless every DI-built `JwtAuthGuard` can reach `UsersService`.
 *
 * Finding zero instances is also a failure: it would mean the guard is no
 * longer wired into the container at all, which is the same authorization gap
 * wearing a different hat.
 */
export function assertJwtAuthGuardsWired(modules: ModulesContainerLike): void {
  const guards = collectDiJwtAuthGuards(modules)

  if (guards.length === 0) {
    throw new JwtAuthGuardWiringError(
      'JwtAuthGuard is not registered in the DI container — no instance found in any module. ' +
        'Role/archive revocation cannot be enforced; refusing to start.',
    )
  }

  const broken = guards.filter(({ guard }) => !guard.isRoleRevocationWired())
  if (broken.length > 0) {
    const where = broken.map(({ moduleName }) => moduleName).join(', ')
    throw new JwtAuthGuardWiringError(
      `JwtAuthGuard did not receive UsersService in: ${where}. ` +
        'Role and archived-status would be read from the JWT instead of the database ' +
        '(see jwt.guard.ts "How UsersService is injected"). Refusing to start.',
    )
  }
}
