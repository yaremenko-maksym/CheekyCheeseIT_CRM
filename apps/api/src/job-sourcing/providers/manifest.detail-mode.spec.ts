import { describe, expect, it } from 'vitest'
import { FIXTURE_ROOT } from '../../test/fixture-provenance'
import { buildManifest, ManifestError, type TypeDefinition } from './manifest'
import { MANIFEST_VALIDATION_ADAPTERS } from './manifest.adapters'
import { MANIFEST_DEFINITIONS } from './manifest.definitions'
import { createGreenhouseProvider } from './sources/greenhouse.provider'
import { fakeCollectionContext } from '../../test/fake-collection-context'

/** U6a: `detailMode` / `detailPerRun` per type (source fetch strategy ADR, 6a). */

const build = (edit: (d: TypeDefinition) => TypeDefinition = (d) => d) =>
  buildManifest({
    definitions: MANIFEST_DEFINITIONS.map((d) => (d.type === 'GREENHOUSE_ATS' ? edit(d) : d)),
    adapters: MANIFEST_VALIDATION_ADAPTERS,
    fixtureRoot: FIXTURE_ROOT,
  })
const typeOf = (m: ReturnType<typeof build>, t: string) => m.types.find((x) => x.type === t)!
const codeOf = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    return e instanceof ManifestError ? e.code : 'OTHER'
  }
  return null
}

describe('detail mode in the manifest', () => {
  it('Greenhouse stays IN_LIST, with its per-run detail budget declared', () => {
    const g = typeOf(build(), 'GREENHOUSE_ATS')
    expect(g.detailMode).toBe('IN_LIST')
    expect(g.detailPerRun).toBe(5)
  })

  it('every other type defaults to IN_LIST with no detail budget', () => {
    const others = build().types.filter((t) => t.type !== 'GREENHOUSE_ATS')
    expect(others.length).toBeGreaterThan(10)
    for (const t of others) {
      expect(t.detailMode).toBe('IN_LIST')
      expect(t.detailPerRun).toBeNull()
    }
  })

  it('ON_DEMAND with a positive whole detailPerRun is accepted', () => {
    const g = typeOf(
      build((d) => ({ ...d, detailMode: 'ON_DEMAND', detailPerRun: 3 })),
      'GREENHOUSE_ATS',
    )
    expect([g.detailMode, g.detailPerRun]).toEqual(['ON_DEMAND', 3])
  })

  it.each([0, -1, 1.5, Number.NaN, 1001])('detailPerRun %s is refused', (n) => {
    expect(codeOf(() => build((d) => ({ ...d, detailMode: 'ON_DEMAND', detailPerRun: n })))).toBe(
      'DETAIL_INVALID',
    )
  })

  it('an IN_LIST type may carry a detailPerRun, so the rollback is the one mode line', () => {
    expect(
      codeOf(() => build((d) => ({ ...d, detailMode: 'IN_LIST', detailPerRun: 2 }))),
    ).toBeNull()
  })

  it('a malformed detailPerRun is refused even on an IN_LIST type', () => {
    expect(codeOf(() => build((d) => ({ ...d, detailMode: 'IN_LIST', detailPerRun: 0 })))).toBe(
      'DETAIL_INVALID',
    )
  })

  it('an ON_DEMAND type must declare how many details a run may fetch', () => {
    expect(
      codeOf(() => build((d) => ({ ...d, detailMode: 'ON_DEMAND', detailPerRun: undefined }))),
    ).toBe('DETAIL_INVALID')
  })
})

describe('the Greenhouse adapter and the manifest agree on the mode', () => {
  it('the manifest mode IN_LIST is the request the default provider sends', async () => {
    const mode = typeOf(build(), 'GREENHOUSE_ATS').detailMode
    const p = createGreenhouseProvider(mode)
    const f = fakeCollectionContext({ responses: [{ bodyText: '{"jobs":[]}' }] })
    await p.collectReport(p.parseConfig({ configVersion: 1, board: 'airbnb' }), f.ctx)
    expect(f.sent[0]?.url).toContain('content=true')
  })
})
