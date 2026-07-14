import { describe, expect, it } from 'vitest'

import { INTEGRATION_SPEC_EXCLUDE_GLOB, isIntegrationRun } from './integration-run-mode'

describe('isIntegrationRun', () => {
  it('returns false for a plain unfiltered run (what .husky/pre-push runs)', () => {
    expect(isIntegrationRun(['node', '.../vitest/vitest.mjs', 'run'])).toBe(false)
  })

  it('returns true for the CI/reproduction integration-run positional filter', () => {
    expect(
      isIntegrationRun([
        'node',
        '.../vitest/vitest.mjs',
        'run',
        '--reporter=verbose',
        'integration.spec',
      ]),
    ).toBe(true)
  })

  it('returns true when a specific integration spec file path is passed', () => {
    expect(
      isIntegrationRun([
        'node',
        '.../vitest/vitest.mjs',
        'run',
        'src/finance/drop.rbac.integration.spec.ts',
      ]),
    ).toBe(true)
  })

  it('returns true for the realdb integration spec naming convention', () => {
    expect(
      isIntegrationRun([
        'node',
        '.../vitest/vitest.mjs',
        'run',
        'legend-defaults.realdb.integration.spec.ts',
      ]),
    ).toBe(true)
  })

  it('returns false for an unrelated positional filter (unit spec)', () => {
    expect(
      isIntegrationRun(['node', '.../vitest/vitest.mjs', 'run', 'src/finance/pay-salary.spec.ts']),
    ).toBe(false)
  })

  it('returns false for an empty argv', () => {
    expect(isIntegrationRun([])).toBe(false)
  })
})

describe('INTEGRATION_SPEC_EXCLUDE_GLOB', () => {
  it('pins the literal glob so an accidental edit cannot silently disable the guard', () => {
    expect(INTEGRATION_SPEC_EXCLUDE_GLOB).toBe('**/*.integration.spec.ts')
  })

  it('matches every DB-backed integration spec filename convention used in this repo', () => {
    // The glob's discriminating suffix is `.integration.spec.ts` — pin that
    // invariant directly rather than re-implementing glob matching here.
    const suffix = INTEGRATION_SPEC_EXCLUDE_GLOB.replace('**/*', '')
    expect('src/finance/drop.rbac.integration.spec.ts'.endsWith(suffix)).toBe(true)
    expect('src/legends/legend-defaults.realdb.integration.spec.ts'.endsWith(suffix)).toBe(true)
    expect('src/finance/pay-salary.spec.ts'.endsWith(suffix)).toBe(false)
  })
})
