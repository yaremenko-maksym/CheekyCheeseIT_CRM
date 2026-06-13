import { describe, expect, it } from 'vitest'
import { JUNIOR_PROJECTS_QUERY_KEY } from '../use-junior-projects'

/**
 * Tests for useJuniorProjects cache-isolation guarantees.
 *
 * The critical invariant (MED-6 follow-up):
 *   Masked junior project data MUST NOT be persisted to IndexedDB.
 *
 * The persist allow-list in __root.tsx uses `shouldDehydrateQuery`:
 *   PERSISTED_KEY_PREFIXES.has(String(query.queryKey[0]))
 *
 * So the key prefix (queryKey[0]) MUST NOT be in the allow-list.
 * The allow-list contains 'projects' but NOT 'junior'.
 */

// Canonical allow-list copied from apps/web/app/routes/__root.tsx
// (kept in sync manually — if this test fails after a __root.tsx change,
//  review whether 'junior' was accidentally added to the allow-list)
const PERSISTED_KEY_PREFIXES = new Set<string>([
  'teams',
  'team',
  'projects',
  'user-projects',
  'user-team',
  'interviews',
  'contract-templates-all',
  'contract-template',
  'tos-current',
  'tos-versions-all',
])

describe('JUNIOR_PROJECTS_QUERY_KEY persist isolation', () => {
  it('has the expected shape: ["junior", "projects"]', () => {
    expect(JUNIOR_PROJECTS_QUERY_KEY).toEqual(['junior', 'projects'])
  })

  it('prefix ("junior") is NOT in the persist allow-list', () => {
    // This is the core security invariant: masked junior project data
    // must never be written to IndexedDB via persistQueryClient.
    const prefix = String(JUNIOR_PROJECTS_QUERY_KEY[0])
    expect(PERSISTED_KEY_PREFIXES.has(prefix)).toBe(false)
  })

  it('bare "projects" key IS in the allow-list (confirming the namespacing is necessary)', () => {
    // Sanity check: if someone naively used queryKey: ['projects'],
    // data WOULD be persisted — the namespacing to ['junior','projects'] is
    // precisely what prevents this.
    expect(PERSISTED_KEY_PREFIXES.has('projects')).toBe(true)
  })

  it('key prefix differs from the shared projects prefix', () => {
    const juniorPrefix = String(JUNIOR_PROJECTS_QUERY_KEY[0])
    expect(juniorPrefix).not.toBe('projects')
  })

  it('second segment is "projects" (confirms the endpoint intent)', () => {
    expect(JUNIOR_PROJECTS_QUERY_KEY[1]).toBe('projects')
  })
})
