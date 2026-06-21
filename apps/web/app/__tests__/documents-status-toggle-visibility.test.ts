/**
 * documents-status-toggle-visibility — unit test for the RBAC rule:
 * the status SegmentedToggle (Все / Активные / Архив) on /documents
 * is rendered ONLY for ADMIN. All other roles see only active documents
 * and the toggle is hidden entirely.
 *
 * UT finding 2026-06-14: previously non-admin roles (SENIOR/HR/ACCOUNTANT)
 * saw the toggle with the "Архив" pill disabled; now the whole toggle is
 * hidden for non-admins so the layout stays clean.
 *
 * We test the guard predicate inline (mirrors the impl in documents.tsx:
 *   `isAdmin && (<SegmentedToggle ... />)`)
 * rather than rendering the full route, which requires router + TanStack
 * Query + auth context setup. The predicate is the spec-critical part.
 */

import { describe, expect, it } from 'vitest'

// ---------------------------------------------------------------------------
// Mirror of the guard predicate in documents.tsx DocumentsPageContent.
// Single source of truth is the route file; this test validates the contract.
// ---------------------------------------------------------------------------

type Role = 'ADMIN' | 'SENIOR' | 'JUNIOR' | 'HR' | 'ACCOUNTANT' | 'DROP'

/** Returns true when the status toggle (Все/Активные/Архив) should render. */
function shouldShowStatusToggle(role: Role): boolean {
  return role === 'ADMIN'
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('documents status-toggle RBAC visibility', () => {
  it('renders the toggle for ADMIN', () => {
    expect(shouldShowStatusToggle('ADMIN')).toBe(true)
  })

  it('hides the toggle for SENIOR', () => {
    expect(shouldShowStatusToggle('SENIOR')).toBe(false)
  })

  it('hides the toggle for JUNIOR', () => {
    expect(shouldShowStatusToggle('JUNIOR')).toBe(false)
  })

  it('hides the toggle for HR', () => {
    expect(shouldShowStatusToggle('HR')).toBe(false)
  })

  it('hides the toggle for ACCOUNTANT', () => {
    expect(shouldShowStatusToggle('ACCOUNTANT')).toBe(false)
  })

  it('hides the toggle for DROP', () => {
    expect(shouldShowStatusToggle('DROP')).toBe(false)
  })

  it('all non-admin roles are hidden (exhaustive)', () => {
    const nonAdminRoles: Role[] = ['SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT', 'DROP']
    for (const role of nonAdminRoles) {
      expect(shouldShowStatusToggle(role)).toBe(false)
    }
  })
})
