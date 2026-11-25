import { describe, expect, it } from 'vitest'
import { MANIFEST_DEFINITIONS } from '../manifest.definitions'
import { BERLIN_NAMESPACE, berlinStartupJobsProvider } from './berlinstartupjobs.provider'
import { HELLOWORLD_NAMESPACE, helloworldProvider } from './helloworld.provider'
import { LARAJOBS_NAMESPACE, larajobsProvider } from './larajobs.provider'
import { PYTHONORG_NAMESPACE, pythonOrgProvider } from './pythonorg.provider'
import { SOLIDJOBS_NAMESPACE, solidJobsProvider } from './solidjobs.provider'

/**
 * The config every RSS source shares. Each source keeps its own schema, so each one runs through the same
 * table: an empty or absent namespace is the source's own, any other namespace is refused, and a feed has
 * no query and no window to ask for.
 */
const SOURCES = [
  { name: 'berlinstartupjobs', provider: berlinStartupJobsProvider, namespace: BERLIN_NAMESPACE },
  { name: 'helloworld', provider: helloworldProvider, namespace: HELLOWORLD_NAMESPACE },
  { name: 'larajobs', provider: larajobsProvider, namespace: LARAJOBS_NAMESPACE },
  { name: 'pythonorg', provider: pythonOrgProvider, namespace: PYTHONORG_NAMESPACE },
  { name: 'solidjobs', provider: solidJobsProvider, namespace: SOLIDJOBS_NAMESPACE },
] as const

describe.each(SOURCES)('$name config', ({ provider, namespace }) => {
  const base = { namespace, configVersion: 1 }

  it('reads an empty namespace as its own namespace', () => {
    expect(provider.parseConfig({ ...base, namespace: '' }).namespace).toBe(namespace)
  })

  it('reads an absent namespace as its own namespace', () => {
    expect(provider.parseConfig({ configVersion: 1 }).namespace).toBe(namespace)
  })

  it('refuses a namespace that is not its own', () => {
    expect(() => provider.parseConfig({ ...base, namespace: 'some-other-board' })).toThrow()
  })

  it('refuses a query: a feed has none to ask for', () => {
    expect(() => provider.parseConfig({ ...base, query: 'engineer' })).toThrow()
  })

  it('refuses a window: a feed shows only its own', () => {
    expect(() =>
      provider.parseConfig({
        ...base,
        window: { from: '2026-11-17T00:00:00Z', to: '2026-11-24T00:00:00Z' },
      }),
    ).toThrow()
  })
})

describe('pythonorg manifest row', () => {
  it('reads its fixture from the pythonorg directory', () => {
    expect(MANIFEST_DEFINITIONS.find((d) => d.type === 'PYTHONORG_RSS')?.fixtureDir).toBe(
      'pythonorg',
    )
  })
})
