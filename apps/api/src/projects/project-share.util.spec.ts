import { describe, expect, it } from 'vitest'
import {
  buildPendingSeniorShareDto,
  isDropOverrideChange,
  isSeniorOverrideChange,
  pickDropDefault,
  pickSeniorDefault,
  resolveOverrideEffective,
} from './project-share.util'

describe('pickSeniorDefault', () => {
  it('uses the senior percent when set', () => {
    expect(pickSeniorDefault({ seniorSharePercent: 31 })).toBe(31)
  })
  it('keeps an explicit 0 (not coalesced)', () => {
    expect(pickSeniorDefault({ seniorSharePercent: 0 })).toBe(0)
  })
  it('falls back to 26 for null percent, null or missing senior', () => {
    expect(pickSeniorDefault({ seniorSharePercent: null })).toBe(26)
    expect(pickSeniorDefault(null)).toBe(26)
    expect(pickSeniorDefault(undefined)).toBe(26)
  })
})

describe('pickDropDefault', () => {
  it('uses the drop percent when set, including 0', () => {
    expect(pickDropDefault({ dropSharePercent: 12 })).toBe(12)
    expect(pickDropDefault({ dropSharePercent: 0 })).toBe(0)
  })
  it('falls back to the default drop share (5) for null/missing', () => {
    expect(pickDropDefault({ dropSharePercent: null })).toBe(5)
    expect(pickDropDefault(null)).toBe(5)
    expect(pickDropDefault(undefined)).toBe(5)
  })
})

describe('resolveOverrideEffective', () => {
  it('undefined stays undefined (field absent)', () => {
    expect(resolveOverrideEffective(undefined, 26)).toBeUndefined()
  })
  it('explicit null clears', () => {
    expect(resolveOverrideEffective(null, 26)).toBeNull()
  })
  it('value equal to default resets to null', () => {
    expect(resolveOverrideEffective(26, 26)).toBeNull()
    expect(resolveOverrideEffective(0, 0)).toBeNull()
  })
  it('other value is kept, including 0', () => {
    expect(resolveOverrideEffective(30, 26)).toBe(30)
    expect(resolveOverrideEffective(0, 26)).toBe(0)
  })
})

describe('isSeniorOverrideChange', () => {
  it('false when nothing requested', () => {
    expect(isSeniorOverrideChange(undefined, 30)).toBe(false)
    expect(isSeniorOverrideChange(undefined, null)).toBe(false)
  })
  it('false when requested equals active (null vs undefined coalesced)', () => {
    expect(isSeniorOverrideChange(null, null)).toBe(false)
    expect(isSeniorOverrideChange(null, undefined)).toBe(false)
    expect(isSeniorOverrideChange(30, 30)).toBe(false)
  })
  it('true when requested differs from active', () => {
    expect(isSeniorOverrideChange(30, null)).toBe(true)
    expect(isSeniorOverrideChange(null, 30)).toBe(true)
    expect(isSeniorOverrideChange(31, 30)).toBe(true)
    expect(isSeniorOverrideChange(0, null)).toBe(true)
  })
})

describe('isDropOverrideChange', () => {
  it('false when nothing requested', () => {
    expect(isDropOverrideChange(undefined, 5)).toBe(false)
    expect(isDropOverrideChange(undefined, null)).toBe(false)
  })
  it('false when requested equals active', () => {
    expect(isDropOverrideChange(null, null)).toBe(false)
    expect(isDropOverrideChange(5, 5)).toBe(false)
  })
  it('true when requested differs from active', () => {
    expect(isDropOverrideChange(5, null)).toBe(true)
    expect(isDropOverrideChange(null, 5)).toBe(true)
    expect(isDropOverrideChange(6, 5)).toBe(true)
  })
  it('does NOT coalesce undefined current to null (verbatim behaviour)', () => {
    expect(isDropOverrideChange(null, undefined)).toBe(true)
  })
})

describe('buildPendingSeniorShareDto', () => {
  const senior = { id: 's1', displayName: 'Sen', seniorSharePercent: 28 }

  it('pending value wins over senior default', () => {
    const dto = buildPendingSeniorShareDto(senior, 35, new Map())
    expect(dto).toEqual({
      percent: 35,
      effectivePercentAfterApproval: 35,
      approverId: 's1',
      approverName: 'Sen',
    })
  })

  it('null pending resolves to the team override of this senior', () => {
    const teams = new Map([['s1', [{ id: 't1', seniorSharePercentOverride: 33 }]]])
    const dto = buildPendingSeniorShareDto(senior, null, teams)
    expect(dto.percent).toBeNull()
    expect(dto.effectivePercentAfterApproval).toBe(33)
  })

  it('null pending without team override falls back to the senior default', () => {
    const dto = buildPendingSeniorShareDto(senior, null, new Map())
    expect(dto.percent).toBeNull()
    expect(dto.effectivePercentAfterApproval).toBe(28)
  })

  it('ignores team overrides of other seniors', () => {
    const teams = new Map([['other', [{ id: 't1', seniorSharePercentOverride: 40 }]]])
    const dto = buildPendingSeniorShareDto(senior, null, teams)
    expect(dto.effectivePercentAfterApproval).toBe(28)
  })

  it('undefined pending maps to percent null', () => {
    expect(buildPendingSeniorShareDto(senior, undefined, new Map()).percent).toBeNull()
  })
})
