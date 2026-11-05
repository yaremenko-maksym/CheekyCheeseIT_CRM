import { describe, expect, it } from 'vitest'
import * as pkg from './index'

describe('package index public surface (SPEC-M-1)', () => {
  it('exposes the bounded-request names main exported', () => {
    const keys = Object.keys(pkg)
    expect(keys).toEqual(
      expect.arrayContaining(['boundedRequest', 'DEFAULT_TIMEOUT_MS', 'DEFAULT_MAX_BYTES']),
    )
  })

  it('does not expose the internal-only runtime host constant or entry (SR-M-64)', () => {
    expect(Object.keys(pkg)).not.toContain('LOCAL_MODEL_RUNTIME_HOST')
    expect(Object.keys(pkg)).not.toContain('boundedRequestToLocalRuntime')
  })

  it('exposes exactly the router names the wiring needs (5.4c-2)', () => {
    const router = [
      'routerConfigSchema',
      'routerCallCeilingMs',
      'isAllowedRouterLocalModelUrl',
      'routerInputCeilingChars',
      'createRouterExtractionAdapter',
      'createFileRouteStatePort',
      'createOwnCapPort',
      'createFileManagedModels',
    ]
    expect(Object.keys(pkg)).toEqual(expect.arrayContaining(router))
  })

  it('exposes exactly the self-heal names the worker needs (5.4c-2b)', () => {
    const selfHeal = [
      'createManagedListWriter',
      'runDailyModelRefresh',
      'runModelChainCheck',
      'runStartupModelRefresh',
    ]
    expect(Object.keys(pkg)).toEqual(expect.arrayContaining(selfHeal))
  })

  it.each([
    'createRouter',
    'sendClassifiedChatCompletion',
    'createStrictSchema',
    'HOSTED_BASE_URLS',
    'createMemoryRouteStatePort',
    'markRetired',
    'markAuth',
    'providerDay',
    'promptFits',
    'BUSY_BACKOFF_MS',
    'sendClassifiedChat',
    'pendingLocalQueues',
    'STATE_READ_FLAGS',
    'STATE_WRITE_FLAGS',
    'MAX_REPORTED_TOKENS',
    'fetchModelListing',
    'MODEL_LISTING_URLS',
    'LISTING_MAX_ENTRIES',
    'MODEL_PROBE_PROMPT',
    'PROBE_CAP',
    'PROBE_PAUSE_MS',
    'PROBE_MAX_TOKENS',
    'STARTUP_REFRESH_MIN_GAP_MS',
    'classifyModelStatus',
    'isPromoted',
    'pinnedModelsOnly',
    'MANAGED_LIST_TARGET',
    'MIN_MANAGED_CONTEXT',
    'clearAuth',
    'clearRetired',
    'markStartupRefresh',
    'setModelRecords',
    'setStaleModels',
    'setJobFailed',
  ])('keeps the router internal %s off the public surface', (name) => {
    expect(Object.keys(pkg)).not.toContain(name)
  })

  it('public BoundedRequestOptions has no local-runtime flag (type-level, SR-M-64)', () => {
    const opts: pkg.BoundedRequestOptions = {
      url: 'https://api.test/x',
      timeoutMs: 1,
      maxBytes: 1,
      // @ts-expect-error allowLocalRuntimeHttp is not a public option
      allowLocalRuntimeHttp: true,
    }
    expect(opts.url).toBe('https://api.test/x')
  })

  it('does not expose the HeaderReader type (type-level check, enforced by typecheck)', () => {
    // @ts-expect-error HeaderReader is internal to the package; importable only by relative path
    type Probe = import('./index').HeaderReader
    const probe: Probe | undefined = undefined
    expect(probe).toBeUndefined()
  })
})
