import { describe, expect, it } from 'vitest'
import {
  AVAILABILITY_EVIDENCE_KINDS,
  availabilityEvidenceSchema,
  type AvailabilityEvidence,
} from './job-availability-evidence'

const RUN = '00000000-0000-4000-8000-000000000001'
const RUN_2 = '00000000-0000-4000-8000-000000000002'
const at = '2026-11-01T10:00:00.000Z'
const base = { runId: RUN, board: 'greenhouse:acme', configVersion: 3, observedAt: at }

const gone = { ...base, kind: 'DETAIL_GONE', httpStatus: 410, adapterVersion: 'gh-1.2' }
const missing = {
  ...base,
  kind: 'INVENTORY_MISSING',
  consecutiveMisses: 3,
  requiredMisses: 3,
  firstMissRunId: RUN_2,
  firstMissAt: '2026-10-30T09:00:00.000Z',
  lastInventorySize: 412,
}
const dropped = { ...base, kind: 'WINDOW_DROPPED' }
const open = { ...base, kind: 'OBSERVED_OPEN', basis: 'DETAIL_FOUND' }

describe('availabilityEvidenceSchema', () => {
  it('lists the four ADR kinds', () => {
    expect([...AVAILABILITY_EVIDENCE_KINDS]).toEqual([
      'DETAIL_GONE',
      'INVENTORY_MISSING',
      'WINDOW_DROPPED',
      'OBSERVED_OPEN',
    ])
  })

  it.each([
    ['DETAIL_GONE', gone],
    ['INVENTORY_MISSING', missing],
    ['WINDOW_DROPPED', dropped],
    ['OBSERVED_OPEN', open],
  ])('accepts a valid %s and keeps its kind', (kind, payload) => {
    const parsed: AvailabilityEvidence = availabilityEvidenceSchema.parse(payload)
    expect(parsed.kind).toBe(kind)
  })

  it('DETAIL_GONE: only 404 and 410 close; other statuses are refused', () => {
    expect(availabilityEvidenceSchema.safeParse({ ...gone, httpStatus: 404 }).success).toBe(true)
    for (const httpStatus of [200, 403, 429, 500, 503])
      expect(availabilityEvidenceSchema.safeParse({ ...gone, httpStatus }).success).toBe(false)
    expect(availabilityEvidenceSchema.safeParse({ ...gone, adapterVersion: '' }).success).toBe(
      false,
    )
  })

  it('INVENTORY_MISSING: counter facts are bounded and consistent', () => {
    const bad = (patch: Record<string, unknown>) =>
      availabilityEvidenceSchema.safeParse({ ...missing, ...patch }).success
    expect(bad({})).toBe(true)
    expect(bad({ consecutiveMisses: 0 })).toBe(false)
    expect(bad({ requiredMisses: 0 })).toBe(false)
    expect(bad({ lastInventorySize: -1 })).toBe(false)
    expect(bad({ lastInventorySize: 1.5 })).toBe(false)
    expect(bad({ firstMissRunId: 'not-a-uuid' })).toBe(false)
    // Closing evidence must have reached the threshold.
    expect(bad({ consecutiveMisses: 2, requiredMisses: 3 })).toBe(false)
  })

  it('OBSERVED_OPEN: basis is a closed set', () => {
    expect(availabilityEvidenceSchema.safeParse({ ...open, basis: 'OBSERVED' }).success).toBe(true)
    expect(availabilityEvidenceSchema.safeParse({ ...open, basis: 'GUESS' }).success).toBe(false)
  })

  it('rejects an unknown kind, a missing common field and unknown keys', () => {
    expect(availabilityEvidenceSchema.safeParse({ ...dropped, kind: 'EXPIRED' }).success).toBe(
      false,
    )
    for (const key of ['runId', 'board', 'configVersion', 'observedAt']) {
      const { [key]: _omitted, ...rest } = dropped as Record<string, unknown>
      expect(availabilityEvidenceSchema.safeParse(rest).success).toBe(false)
    }
    expect(availabilityEvidenceSchema.safeParse({ ...dropped, extra: 1 }).success).toBe(false)
    expect(availabilityEvidenceSchema.safeParse({ ...dropped, configVersion: 0 }).success).toBe(
      false,
    )
    expect(availabilityEvidenceSchema.safeParse({ ...dropped, board: '' }).success).toBe(false)
    expect(
      availabilityEvidenceSchema.safeParse({ ...dropped, observedAt: 'yesterday' }).success,
    ).toBe(false)
  })

  it('bounds the text fields: blank is refused, the maximum length is the edge', () => {
    const ok = (patch: Record<string, unknown>, from: object = dropped) =>
      availabilityEvidenceSchema.safeParse({ ...from, ...patch }).success
    expect(ok({ board: '   ' })).toBe(false)
    expect(ok({ board: 'b'.repeat(200) })).toBe(true)
    expect(ok({ board: 'b'.repeat(201) })).toBe(false)
    expect(ok({ adapterVersion: '   ' }, gone)).toBe(false)
    expect(ok({ adapterVersion: 'v'.repeat(100) }, gone)).toBe(true)
    expect(ok({ adapterVersion: 'v'.repeat(101) }, gone)).toBe(false)
    expect(ok({ runId: 'not-a-uuid' })).toBe(false)
  })

  it('a threshold shortfall is reported on consecutiveMisses with a readable message', () => {
    const r = availabilityEvidenceSchema.safeParse({
      ...missing,
      consecutiveMisses: 2,
      requiredMisses: 3,
    })
    expect(r.success).toBe(false)
    const issue = r.success ? undefined : r.error.issues[0]
    expect(issue?.path).toEqual(['consecutiveMisses'])
    expect(issue?.message).toBe('closing evidence must have reached the miss threshold')
  })

  it('the column default {} is not valid evidence (the writer must always set a kind)', () => {
    expect(availabilityEvidenceSchema.safeParse({}).success).toBe(false)
  })
})
