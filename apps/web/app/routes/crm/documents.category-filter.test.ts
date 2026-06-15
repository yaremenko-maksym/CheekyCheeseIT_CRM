/**
 * documents.category-filter.test.ts — unit tests for the pure helper
 * `initialCategoryForRole` (task-accountant-s2-documents-prefilter AC1-AC4).
 *
 * Tests the pure function in isolation — no React / router dependencies.
 * Covers:
 *   AC1 — ACCOUNTANT without deep-link → RECEIPT
 *   AC2 — ACCOUNTANT with explicit deep-link → deep-link wins
 *   AC3 — Other roles without deep-link → ALL (unchanged behaviour)
 *   AC4 — Guard interaction: RECEIPT is in ACCOUNTANT's availableCategories,
 *          so the reset-to-ALL effect never fires (implicit: RECEIPT is valid).
 */
import { describe, expect, it } from 'vitest'
import { initialCategoryForRole } from './documents'

describe('initialCategoryForRole', () => {
  // ── AC1: ACCOUNTANT default ────────────────────────────────────────────────
  it('returns RECEIPT for ACCOUNTANT when no deep-link is provided', () => {
    expect(initialCategoryForRole('ACCOUNTANT', undefined)).toBe('RECEIPT')
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
