import { describe, expect, it } from 'vitest'
import { type DetailMode, onDemandTypesOf } from './detail-mode'

describe('onDemandTypesOf', () => {
  const t = (type: string, detailMode: DetailMode) => ({ type, detailMode })

  it('keeps the ON_DEMAND types, in order, and drops the IN_LIST ones', () => {
    const types = [t('A', 'IN_LIST'), t('B', 'ON_DEMAND'), t('C', 'ON_DEMAND'), t('D', 'IN_LIST')]
    expect(onDemandTypesOf(types)).toEqual(['B', 'C'])
  })

  it('is empty when every type is IN_LIST', () => {
    expect(onDemandTypesOf([t('A', 'IN_LIST'), t('B', 'IN_LIST')])).toEqual([])
  })
})
