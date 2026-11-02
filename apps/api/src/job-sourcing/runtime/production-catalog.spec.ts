import type { JobSourceType } from '@crm/shared'
import { describe, expect, it } from 'vitest'
import type { DetailMode } from '../providers/detail-mode'
import {
  catalogFromSnapshot,
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
