/**
 * Source-fetch-strategy U4 — the reporting-type set the detector pass scans over. The pass itself
 * is exercised against a real Postgres in job-source-health-pass.integration.spec.ts; this pins the
 * pure derivation of which source types it considers.
 */
import { jobSourceTypeSchema } from '@crm/shared'
import { describe, expect, it } from 'vitest'
import { REPORTING_TYPES } from './reporting-types'

describe('REPORTING_TYPES', () => {
  it('excludes the legacy DOU feed and every HTML type', () => {
    expect(REPORTING_TYPES).not.toContain('DOU_RSS')
    expect(REPORTING_TYPES.filter((t) => t.endsWith('_HTML'))).toEqual([])
  })

  it('includes an API reporting type (REMOTIVE_API) and omits every HTML one', () => {
    expect(REPORTING_TYPES).toContain('REMOTIVE_API')
    const htmlTypes = jobSourceTypeSchema.options.filter((t) => t.endsWith('_HTML'))
    expect(htmlTypes.length).toBeGreaterThan(0)
    for (const t of htmlTypes) expect(REPORTING_TYPES).not.toContain(t)
  })

  it('is a non-empty strict subset of all source types', () => {
    expect(REPORTING_TYPES.length).toBeGreaterThan(0)
    expect(REPORTING_TYPES.length).toBeLessThan(jobSourceTypeSchema.options.length)
  })
})
