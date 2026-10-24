import { describe, expect, it } from 'vitest'
import { FIXTURE_ROOT } from '../../test/fixture-provenance'
import { buildManifest } from './manifest'
import { MANIFEST_VALIDATION_ADAPTERS } from './manifest.adapters'
import { MANIFEST_DEFINITIONS } from './manifest.definitions'

describe('the committed manifest builds', () => {
  it('builds from the committed definitions, fixtures and adapters', () => {
    const m = buildManifest({
      definitions: MANIFEST_DEFINITIONS,
      adapters: MANIFEST_VALIDATION_ADAPTERS,
      fixtureRoot: FIXTURE_ROOT,
    })
    expect(m.types).toHaveLength(31)
  })
})
