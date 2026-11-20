import { describe, expect, it } from 'vitest'
import { config, GEMINI, GROQ, OPENROUTER } from './__test-helpers__/router-harness'
import type { HostedProvider } from './config'
import { allLimitBlocked, routerReadiness } from './readiness'
import {
  createMemoryRouteStatePort,
  createOwnCapPort,
  EMPTY_ROUTE_STATE,
  markAuth,
  markCredit,
  markFlagRejected,
  markProviderSpent,
  markRetired,
  markSpent,
  providerDay,
  type RouteState,
  type RouteStatePort,
} from './state'

const NOON = Date.parse('2026-11-04T12:00:00Z')
const now = () => NOON
const day = (p: HostedProvider) => providerDay(p, NOON)
type Change = (s: RouteState) => RouteState
const spentAll =
  (route: { provider: HostedProvider; models: string[] }): Change =>
  (s) =>
    route.models.reduce((acc, m) => markSpent(route.provider, m, day(route.provider))(acc), s)
const stateOf = (...changes: Change[]) =>
  createMemoryRouteStatePort(changes.reduce((s, c) => c(s), EMPTY_ROUTE_STATE))
/** A free limit of 2 requests: the own cap is 1 (50 %), so one reservation fills it. */
const TINY = { requestsPerDay: 1 }

const ready = (routes: unknown[], routeState: RouteStatePort) =>
  routerReadiness(config(routes), { routeState, now })

describe('routerReadiness (H.3): the answer from route state only', () => {
  it('a fresh state is READY', async () => {
    expect(await ready([GROQ, GEMINI], stateOf())).toBe('READY')
  })

  it.each<[string, Change[]]>([
    ['every model spent on both', [spentAll(GROQ), spentAll(GEMINI)]],
    [
      'the CREDIT bit on both',
      [(s) => markCredit('groq', day('groq'))(s), (s) => markCredit('gemini', day('gemini'))(s)],
    ],
    [
      'spent on one, CREDIT on the other',
      [spentAll(GROQ), (s) => markCredit('gemini', day('gemini'))(s)],
    ],
    ['AUTH on one, spent on the other', [(s) => markAuth('groq')(s), spentAll(GEMINI)]],
    [
      'spent + retired on one (a retired model is not one it could try), spent on the other',
      [
        (s) => markSpent('groq', GROQ.models[0]!, day('groq'))(s),
        (s) => markRetired('groq', GROQ.models[1]!, NOON)(s),
        spentAll(GEMINI),
      ],
    ],
  ])('%s → LIMITS_EXHAUSTED', async (_l, changes) => {
    expect(await ready([GROQ, GEMINI], stateOf(...changes))).toBe('LIMITS_EXHAUSTED')
  })

  it.each<[string, Change[]]>([
    ['one route spent, the other untouched', [spentAll(GROQ)]],
    ['one model of each spent', [(s) => markSpent('groq', GROQ.models[0]!, day('groq'))(s)]],
    [
      'every model retired on one route (nothing left is no limit)',
      [
        spentAll(GEMINI),
        ...GROQ.models.map(
          (m): Change =>
            (s) =>
              markRetired('groq', m, NOON)(s),
        ),
      ],
    ],
    [
      'a spent entry of yesterday',
      [
        (s) => markSpent('groq', GROQ.models[0]!, '2026-11-03')(s),
        (s) => markSpent('groq', GROQ.models[1]!, '2026-11-03')(s),
      ],
    ],
    ['a CREDIT bit of yesterday', [(s) => markCredit('groq', '2026-11-03')(s), spentAll(GEMINI)]],
  ])('%s → READY', async (_l, changes) => {
    expect(await ready([GROQ, GEMINI], stateOf(...changes))).toBe('READY')
  })

  it('every route AUTH-disabled → NO_ROUTE', async () => {
    const state = stateOf(
      (s) => markAuth('groq')(s),
      (s) => markAuth('gemini')(s),
    )
    expect(await ready([GROQ, GEMINI], state)).toBe('NO_ROUTE')
  })

  it.each([
    ['no route configured', []],
    ['a route with no key', [{ ...GROQ, apiKey: '' }]],
    ['a stale local route', [{ provider: 'local' }]],
  ])('%s (the router refuses the config) → NO_ROUTE', async (_l, routes) => {
    expect(await ready(routes, stateOf())).toBe('NO_ROUTE')
  })

  it.each([
    ['a spent OpenRouter day', markProviderSpent('openrouter', day('openrouter'))],
    ['an OpenRouter CREDIT bit from an earlier day', markCredit('openrouter', '2026-11-01')],
  ])('%s is a limit (§3.5, H.2)', async (_l, change) => {
    expect(await ready([OPENROUTER, GROQ], stateOf(change, spentAll(GROQ)))).toBe(
      'LIMITS_EXHAUSTED',
    )
  })

  it('a FLAG_REJECTED OpenRouter is not a limit: the call is not LIMITS_EXHAUSTED (H.2)', async () => {
    const state = stateOf(markFlagRejected('openrouter', OPENROUTER.models[0]!), spentAll(GROQ))
    expect(await ready([OPENROUTER, GROQ], state)).toBe('READY')
  })

  it('a full own cap is a limit, and reading it reserves nothing', async () => {
    const routeState = stateOf()
    const cap = createOwnCapPort({ state: routeState, now })
    for (const p of ['groq', 'gemini'] as const) expect(await cap.reserve(p, TINY)).not.toBeNull()
    const before = JSON.stringify(routeState.snapshot())
    const routes = [
      { ...GROQ, freeLimit: TINY },
      { ...GEMINI, freeLimit: TINY },
    ]
    expect(await ready(routes, routeState)).toBe('LIMITS_EXHAUSTED')
    expect(await ready(routes, routeState)).toBe('LIMITS_EXHAUSTED')
    expect(JSON.stringify(routeState.snapshot())).toBe(before)
  })

  it('a token-full own cap is a limit', async () => {
    const routeState = stateOf()
    const cap = createOwnCapPort({ state: routeState, now })
    const limit = { requestsPerDay: 1000, tokensPerDay: 50 }
    await cap.addTokens('groq', 50)
    expect(await ready([{ ...GROQ, freeLimit: limit }], routeState)).toBe('LIMITS_EXHAUSTED')
    expect(await ready([{ ...GROQ, freeLimit: { ...limit, tokensPerDay: 51 } }], routeState)).toBe(
      'READY',
    )
  })

  it('a cap one request short of full is READY', async () => {
    const routeState = stateOf()
    const cap = createOwnCapPort({ state: routeState, now })
    await cap.reserve('groq', { requestsPerDay: 4 })
    expect(await ready([{ ...GROQ, freeLimit: { requestsPerDay: 4 } }], routeState)).toBe('READY')
  })

  it('reads the managed model list, not only the pins', async () => {
    const state = stateOf((s) => markSpent('groq', 'openai/gpt-oss-120b', day('groq'))(s))
    const managedModels = async () => ['openai/gpt-oss-120b']
    expect(await routerReadiness(config([GROQ]), { routeState: state, now, managedModels })).toBe(
      'LIMITS_EXHAUSTED',
    )
  })

  it('a failing state read never throws: NO_ROUTE', async () => {
    const broken: RouteStatePort = {
      snapshot: () => {
        throw new Error('unreadable')
      },
      update: async () => false,
    } as unknown as RouteStatePort
    expect(await ready([GROQ], broken)).toBe('NO_ROUTE')
  })
})

describe('allLimitBlocked (H.2): never vacuously true', () => {
  it.each<[Parameters<typeof allLimitBlocked>[0], boolean]>([
    [[], false],
    [['UNAVAILABLE'], false],
    [['UNAVAILABLE', 'LIMIT'], true],
    [['LIMIT', 'LIMIT'], true],
    [['LIMIT', 'OTHER'], false],
    [['OTHER'], false],
  ])('%j → %s', (ends, expected) => {
    expect(allLimitBlocked(ends)).toBe(expected)
  })
})
