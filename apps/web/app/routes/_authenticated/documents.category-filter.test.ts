/**
 * documents.category-filter.test.ts — unit tests for the pure helper
 * `initialCategoryForRole` (task-ui-header-scroll-overhaul AC3 update).
 *
 * Tests the pure function in isolation — no React / router dependencies.
 * Covers:
 *   AC1 — ALL roles without deep-link → ALL (task-ui-header-scroll-overhaul AC3:
 *          default = «Все категории» for ALL roles including ACCOUNTANT)
 *   AC2 — ACCOUNTANT with explicit deep-link → deep-link wins (unchanged)
 *   AC3 — Other roles unchanged → ALL
 */
import { describe, expect, it } from 'vitest'
import { initialCategoryForRole } from './documents'

describe('initialCategoryForRole', () => {
  // ── AC1: ALL roles default to ALL (task-ui-header-scroll-overhaul AC3) ─────
  it('returns ALL for ACCOUNTANT when no deep-link is provided', () => {
    expect(initialCategoryForRole('ACCOUNTANT', undefined)).toBe('ALL')
  })

  // ── AC2: deep-link always wins ─────────────────────────────────────────────
  it('returns the deep-link category for ACCOUNTANT when ?category=INVOICE is set', () => {
    expect(initialCategoryForRole('ACCOUNTANT', 'INVOICE')).toBe('INVOICE')
  })

  it('returns the deep-link category for ACCOUNTANT when ?category=SCAN is set', () => {
    expect(initialCategoryForRole('ACCOUNTANT', 'SCAN')).toBe('SCAN')
  })

  it('returns the deep-link category for ACCOUNTANT when ?category=RECEIPT is set (explicit wins)', () => {
    expect(initialCategoryForRole('ACCOUNTANT', 'RECEIPT')).toBe('RECEIPT')
  })

  // ── AC3: other roles unchanged ─────────────────────────────────────────────
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
