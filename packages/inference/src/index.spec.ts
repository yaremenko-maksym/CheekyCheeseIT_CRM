import { describe, expect, it } from 'vitest'
import * as pkg from './index'

describe('package index public surface (SPEC-M-1)', () => {
  it('exposes the bounded-request names main exported', () => {
    const keys = Object.keys(pkg)
    expect(keys).toEqual(expect.arrayContaining(['boundedRequest', 'DEFAULT_TIMEOUT_MS', 'DEFAULT_MAX_BYTES']))
  })

  it('does not expose the internal-only runtime host constant', () => {
    expect(Object.keys(pkg)).not.toContain('LOCAL_MODEL_RUNTIME_HOST')
  })

  it('does not expose the HeaderReader type (type-level check, enforced by typecheck)', () => {
    // @ts-expect-error HeaderReader is internal to the package; importable only by relative path
    type Probe = import('./index').HeaderReader
    const probe: Probe | undefined = undefined
    expect(probe).toBeUndefined()
  })
})
