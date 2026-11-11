import type { JobSourceType } from '@crm/shared'
import { describe, expect, it } from 'vitest'
import type { DetailMode } from '../providers/detail-mode'
import {
  catalogFromSnapshot,
  sourceDeadlines,
  type LedgerCatalogSnapshot,
  type SnapshotType,
} from './production-catalog'

/**
 * SFS U10: the production catalog carries each type's `detailMode` / `detailPerRun` onto its entry
 * and reports the ON_DEMAND types. Exercised with a synthetic snapshot so the path is tested before
 * any real source is flipped to ON_DEMAND (the manifest flip is U10 #10, the last step).
 */
const snapshotType = (
  type: JobSourceType,
  detailMode: DetailMode,
  detailPerRun: number | null,
): SnapshotType => ({
  type,
  blockerCodes: [],
  deadlines: [],
  payloadVerified: true,
  quotaDeclared: false,
  floorHours: 0,
  banScope: 'HOST',
  requestsPerRun: 1,
  detailMode,
  detailPerRun,
})

const snapshot: LedgerCatalogSnapshot = {
  types: [
    snapshotType('GREENHOUSE_ATS', 'ON_DEMAND', 5),
    snapshotType('LEVER_ATS', 'IN_LIST', null),
  ],
  entries: [
    { id: 'gh.board', type: 'GREENHOUSE_ATS', blockerCodes: [], deadlines: [], fetchProfile: null },
    { id: 'lv.board', type: 'LEVER_ATS', blockerCodes: [], deadlines: [], fetchProfile: null },
  ],
  hosts: [],
}

describe('catalogFromSnapshot — detail mode (U10)', () => {
  const catalog = catalogFromSnapshot(snapshot)

  it('carries detailMode and detailPerRun onto the ON_DEMAND entry', () => {
    expect(catalog.entry('gh.board')).toMatchObject({ detailMode: 'ON_DEMAND', detailPerRun: 5 })
  })

  it('carries IN_LIST and a null detailPerRun onto a list entry', () => {
    expect(catalog.entry('lv.board')).toMatchObject({ detailMode: 'IN_LIST', detailPerRun: null })
  })

  it('reports exactly the ON_DEMAND types', () => {
    expect(catalog.onDemandTypes()).toEqual(['GREENHOUSE_ATS'])
  })
})

describe('sourceDeadlines — task 7.5 (AC4)', () => {
  const dated = (type: JobSourceType, deadlines: SnapshotType['deadlines']): SnapshotType => ({
    ...snapshotType(type, 'IN_LIST', null),
    deadlines,
  })
  const snap: LedgerCatalogSnapshot = {
    types: [
      dated('RECRUITEE_ATS', [
        { kind: 'AUTH_REQUIRED_FROM', at: '2027-03-01T00:00:00.000Z' },
        { kind: 'POLICY_EXPIRES', at: '2027-09-01T00:00:00.000Z' },
      ]),
      dated('GREENHOUSE_ATS', []),
    ],
    entries: [
      {
        id: 'rt.early',
        type: 'RECRUITEE_ATS',
        blockerCodes: [],
        deadlines: [{ kind: 'AUTH_REQUIRED_FROM', at: '2027-02-10T00:00:00.000Z' }],
        fetchProfile: null,
      },
      {
        id: 'gh.board',
        type: 'GREENHOUSE_ATS',
        blockerCodes: [],
        deadlines: [{ kind: 'POLICY_EXPIRES', at: '2028-01-01T00:00:00.000Z' }],
        fetchProfile: null,
      },
      {
        // earlier than every Recruitee deadline: it must never leak into a Recruitee source
        id: 'gh.early',
        type: 'GREENHOUSE_ATS',
        blockerCodes: [],
        deadlines: [
          { kind: 'AUTH_REQUIRED_FROM', at: '2026-12-01T00:00:00.000Z' },
          { kind: 'POLICY_EXPIRES', at: '2026-12-02T00:00:00.000Z' },
        ],
        fetchProfile: null,
      },
      {
        id: 'rt.plain',
        type: 'RECRUITEE_ATS',
        blockerCodes: [],
        deadlines: [],
        fetchProfile: null,
      },
    ],
    hosts: [],
  }
  const TYPE_ONLY = {
    policyUntil: '2027-09-01T00:00:00.000Z',
    authUntil: '2027-03-01T00:00:00.000Z',
  }

  it('a source with no deadline anywhere reads null / null', () => {
    expect(sourceDeadlines('GREENHOUSE_ATS', null, snap)).toEqual({
      policyUntil: null,
      authUntil: null,
    })
    expect(sourceDeadlines('LEVER_ATS', 'unknown.entry', snap)).toEqual({
      policyUntil: null,
      authUntil: null,
    })
  })

  it('the type deadlines apply to a source without an entry', () => {
    expect(sourceDeadlines('RECRUITEE_ATS', null, snap)).toEqual({
      policyUntil: '2027-09-01T00:00:00.000Z',
      authUntil: '2027-03-01T00:00:00.000Z',
    })
  })

  it('the earlier of the type and the entry deadline wins, per kind', () => {
    expect(sourceDeadlines('RECRUITEE_ATS', 'rt.early', snap)).toEqual({
      policyUntil: '2027-09-01T00:00:00.000Z',
      authUntil: '2027-02-10T00:00:00.000Z',
    })
  })

  it('an entry whose id matches but whose type differs is not resolved for the source', () => {
    expect(sourceDeadlines('RECRUITEE_ATS', 'gh.board', snap)).toEqual(TYPE_ONLY)
    // earlier than the type's own deadlines, so a leak would change both kinds
    expect(sourceDeadlines('RECRUITEE_ATS', 'gh.early', snap)).toEqual(TYPE_ONLY)
    // the reverse: a Greenhouse source with a Recruitee entry id, and a type with no deadlines
    expect(sourceDeadlines('GREENHOUSE_ATS', 'rt.early', snap)).toEqual({
      policyUntil: null,
      authUntil: null,
    })
  })

  it('an entry of the source type with another id is not resolved for the source', () => {
    expect(sourceDeadlines('RECRUITEE_ATS', 'unknown.entry', snap)).toEqual(TYPE_ONLY)
    expect(sourceDeadlines('GREENHOUSE_ATS', 'unknown.entry', snap)).toEqual({
      policyUntil: null,
      authUntil: null,
    })
  })

  it('a null manifest id resolves no entry, even when an entry of the type exists', () => {
    expect(sourceDeadlines('GREENHOUSE_ATS', null, snap)).toEqual({
      policyUntil: null,
      authUntil: null,
    })
  })

  it('an entry with no deadlines adds nothing to the type deadlines', () => {
    expect(sourceDeadlines('RECRUITEE_ATS', 'rt.plain', snap)).toEqual(TYPE_ONLY)
  })

  it('a type absent from the snapshot gets only its entry deadlines', () => {
    const noType: LedgerCatalogSnapshot = { ...snap, types: [] }
    expect(sourceDeadlines('RECRUITEE_ATS', 'rt.early', noType)).toEqual({
      policyUntil: null,
      authUntil: '2027-02-10T00:00:00.000Z',
    })
    expect(sourceDeadlines('RECRUITEE_ATS', null, noType)).toEqual({
      policyUntil: null,
      authUntil: null,
    })
  })

  it('an entry adds its own policy deadline', () => {
    expect(sourceDeadlines('GREENHOUSE_ATS', 'gh.board', snap)).toEqual({
      policyUntil: '2028-01-01T00:00:00.000Z',
      authUntil: null,
    })
  })

  it('reads the shipped snapshot by default: the Recruitee bunq board needs authorization from 2027-02-10', () => {
    expect(sourceDeadlines('RECRUITEE_ATS', 'recruitee.board.bunq')).toEqual({
      policyUntil: null,
      authUntil: '2027-02-10T00:00:00.000Z',
    })
    expect(sourceDeadlines('REMOTIVE_API', null)).toEqual({ policyUntil: null, authUntil: null })
  })
})
