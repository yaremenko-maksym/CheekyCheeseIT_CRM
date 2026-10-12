/**
 * constants.test.ts — pins the /documents RBAC tables and the view-preference
 * storage key. Expected values are hand-written literals (the spec table
 * «Видимость табов по ролям»), not derived from the code under test.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TAB_VISIBILITY,
  UPLOADABLE_PER_ROLE,
  VIEW_STORAGE_KEY,
  canSeeOwnerFilter,
  getStoredView,
  setStoredView,
} from '../constants'

describe('TAB_VISIBILITY', () => {
  it('matches the role visibility table', () => {
    expect(TAB_VISIBILITY).toEqual({
      ADMIN: ['RESUME', 'SCAN', 'CONTRACT', 'RECEIPT', 'INVOICE'],
      SENIOR: ['RESUME', 'SCAN', 'CONTRACT', 'RECEIPT', 'INVOICE'],
      JUNIOR: ['RESUME', 'SCAN', 'CONTRACT', 'INVOICE'],
      HR: ['RESUME', 'SCAN', 'CONTRACT'],
      ACCOUNTANT: ['SCAN', 'RECEIPT', 'INVOICE'],
      DROP: ['RESUME', 'SCAN', 'CONTRACT', 'RECEIPT', 'INVOICE'],
    })
  })
})

describe('UPLOADABLE_PER_ROLE', () => {
  it('matches the per-role upload table', () => {
    expect(UPLOADABLE_PER_ROLE).toEqual({
      ADMIN: ['RESUME', 'SCAN', 'CONTRACT'],
      SENIOR: ['RESUME', 'SCAN', 'CONTRACT'],
      JUNIOR: ['RESUME', 'SCAN'],
      HR: ['RESUME', 'SCAN'],
      ACCOUNTANT: [],
      DROP: ['RESUME', 'SCAN', 'CONTRACT'],
    })
  })
})

describe('canSeeOwnerFilter', () => {
  it.each([
    ['ADMIN', true],
    ['HR', true],
    ['SENIOR', false],
    ['JUNIOR', false],
    ['ACCOUNTANT', false],
    ['DROP', false],
  ] as const)('%s -> %s', (role, expected) => {
    expect(canSeeOwnerFilter(role)).toBe(expected)
  })
})

describe('view preference storage', () => {
  afterEach(() => localStorage.clear())

  it('uses the crm.documents.view key', () => {
    expect(VIEW_STORAGE_KEY).toBe('crm.documents.view')
  })

  it('defaults to list, round-trips grid, ignores unknown values', () => {
    expect(getStoredView()).toBe('list')
    setStoredView('grid')
    expect(localStorage.getItem('crm.documents.view')).toBe('grid')
    expect(getStoredView()).toBe('grid')
    localStorage.setItem('crm.documents.view', 'bogus')
    expect(getStoredView()).toBe('list')
  })

  it('falls back to list when there is no window (SSR guard)', () => {
    localStorage.setItem('crm.documents.view', 'grid')
    vi.stubGlobal('window', undefined)
    try {
      expect(getStoredView()).toBe('list')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
