/**
 * documents.category-filter.test.ts — unit tests for the pure helper
 * `initialCategoryForRole` (task-ui-header-scroll-overhaul AC3 update).
 *
 * Tests the pure function in isolation — no React / router dependencies.
 * Covers:
 *   - every role without a deep-link → ALL (task-ui-header-scroll-overhaul AC3:
 *     default = «Все категории»)
 *   - an explicit deep-link always wins
 */
import { describe, expect, it } from 'vitest'
import { initialCategoryForRole } from './documents/constants'

describe('initialCategoryForRole', () => {
  // ── Deep-link always wins ──────────────────────────────────────────────────
  it('returns the deep-link category for HR when ?category=INVOICE is set', () => {
    expect(initialCategoryForRole('HR', 'INVOICE')).toBe('INVOICE')
  })

  it('returns the deep-link category for JUNIOR when ?category=SCAN is set', () => {
    expect(initialCategoryForRole('JUNIOR', 'SCAN')).toBe('SCAN')
  })

  // ── Every role defaults to ALL ─────────────────────────────────────────────
  it('returns ALL for ADMIN when no deep-link is provided', () => {
    expect(initialCategoryForRole('ADMIN', undefined)).toBe('ALL')
  })

  it('returns ALL for SENIOR when no deep-link is provided', () => {
    expect(initialCategoryForRole('SENIOR', undefined)).toBe('ALL')
  })

  it('returns ALL for JUNIOR when no deep-link is provided', () => {
    expect(initialCategoryForRole('JUNIOR', undefined)).toBe('ALL')
  })

  it('returns ALL for HR when no deep-link is provided', () => {
    expect(initialCategoryForRole('HR', undefined)).toBe('ALL')
  })

  it('returns ALL for DROP when no deep-link is provided', () => {
    expect(initialCategoryForRole('DROP', undefined)).toBe('ALL')
  })

  it('returns deep-link category for ADMIN when ?category=RECEIPT is set', () => {
    expect(initialCategoryForRole('ADMIN', 'RECEIPT')).toBe('RECEIPT')
  })

  it('returns deep-link category for SENIOR when ?category=CONTRACT is set', () => {
    expect(initialCategoryForRole('SENIOR', 'CONTRACT')).toBe('CONTRACT')
  })
})
