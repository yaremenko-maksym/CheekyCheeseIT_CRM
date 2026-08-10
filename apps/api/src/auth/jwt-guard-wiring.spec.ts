import { Reflector } from '@nestjs/core'
import type { JwtService } from '@nestjs/jwt'
import { describe, expect, it } from 'vitest'

import { UsersService } from '../users/users.service'
import {
  JwtAuthGuardWiringError,
  assertJwtAuthGuardsWired,
  collectDiJwtAuthGuards,
  type ModulesContainerLike,
} from './jwt-guard-wiring'
import { JwtAuthGuard } from './jwt.guard'

/**
 * Scope note — read before adding cases here.
 *
 * These tests cover the ASSERTION's own logic (does it find every guard the
 * container built, and does it refuse loudly). They cannot cover the defect the
 * assertion exists for: under vitest/esbuild no decorator metadata is emitted,
 * so a container-built guard receives no constructor arguments regardless of
 * how the dependency is declared — broken and fixed source are identical here.
 * That is exactly why the real check runs at bootstrap against the compiled
 * artifact. See jwt-guard-wiring.ts.
 */

const jwtStub = {} as JwtService

function makeUsersService(): UsersService {
  return Object.assign(Object.create(UsersService.prototype) as UsersService, {
    findById: () => Promise.resolve(undefined),
  })
}

function wiredGuard(): JwtAuthGuard {
  return new JwtAuthGuard(jwtStub, new Reflector(), makeUsersService())
}

function unwiredGuard(): JwtAuthGuard {
  return new JwtAuthGuard(jwtStub, new Reflector())
}

function makeModule(
  name: string | null,
  collections: { providers?: unknown[]; injectables?: unknown[] } = {},
) {
  const toMap = (instances: unknown[]) =>
    new Map(instances.map((instance, index) => [`token-${index}`, { instance }]))
  return {
    metatype: name === null ? null : { name },
    providers: toMap(collections.providers ?? []),
    injectables: toMap(collections.injectables ?? []),
  }
}

function makeContainer(
  modules: Record<string, ReturnType<typeof makeModule>>,
): ModulesContainerLike {
  return new Map(Object.entries(modules))
}

describe('collectDiJwtAuthGuards', () => {
  it('finds guards in both providers and injectables, tagged with their module', () => {
    const container = makeContainer({
      app: makeModule('AppModule', { providers: [wiredGuard(), { notAGuard: true }] }),
      legends: makeModule('LegendsModule', { injectables: [wiredGuard()] }),
    })

    const found = collectDiJwtAuthGuards(container)

    expect(found.map((entry) => entry.moduleName)).toEqual(['AppModule', 'LegendsModule'])
    expect(found.every((entry) => entry.guard instanceof JwtAuthGuard)).toBe(true)
  })

  it('ignores unrelated and not-yet-resolved provider instances', () => {
    const container = makeContainer({
      misc: makeModule('MiscModule', { providers: [null, undefined, new Reflector(), 'string'] }),
    })

    expect(collectDiJwtAuthGuards(container)).toEqual([])
  })

  it('falls back to a placeholder name for an unnamed module', () => {
    const container = makeContainer({ dynamic: makeModule(null, { providers: [unwiredGuard()] }) })

    expect(collectDiJwtAuthGuards(container)[0]?.moduleName).toBe('<unnamed module>')
  })
})

describe('assertJwtAuthGuardsWired', () => {
  it('passes when every guard received a users service', () => {
    const container = makeContainer({
      app: makeModule('AppModule', { providers: [wiredGuard()] }),
      auth: makeModule('AuthModule', { providers: [wiredGuard()] }),
    })

    expect(() => assertJwtAuthGuardsWired(container)).not.toThrow()
  })

  it('throws and names every module whose guard lacks the users service', () => {
    const container = makeContainer({
      app: makeModule('AppModule', { providers: [unwiredGuard()] }),
      auth: makeModule('AuthModule', { providers: [wiredGuard()] }),
      docs: makeModule('DocumentsModule', { injectables: [unwiredGuard()] }),
    })

    expect(() => assertJwtAuthGuardsWired(container)).toThrow(JwtAuthGuardWiringError)
    expect(() => assertJwtAuthGuardsWired(container)).toThrow(/AppModule, DocumentsModule/)
    expect(() => assertJwtAuthGuardsWired(container)).not.toThrow(/AuthModule/)
  })

  it('throws when the dependency resolved to something that is not a users service', () => {
    // A mis-wired token can resolve to an unrelated provider — truthy, but
    // without the method the request path calls.
    const misWired = new JwtAuthGuard(jwtStub, new Reflector(), {
      somethingElse: true,
    } as unknown as UsersService)
    const container = makeContainer({ app: makeModule('AppModule', { providers: [misWired] }) })

    expect(() => assertJwtAuthGuardsWired(container)).toThrow(/did not receive UsersService/)
  })

  it('throws when the guard is not registered in the container at all', () => {
    const container = makeContainer({
      app: makeModule('AppModule', { providers: [new Reflector()] }),
    })

    expect(() => assertJwtAuthGuardsWired(container)).toThrow(JwtAuthGuardWiringError)
    expect(() => assertJwtAuthGuardsWired(container)).toThrow(/not registered in the DI container/)
  })
})
