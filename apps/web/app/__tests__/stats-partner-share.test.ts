/**
 * Audit 2026-06-28 (#14) — partner share-% on /stats must never render a
 * negative / garbled percentage.
 *
 * Before the fix the label was `Math.round((balance / total) * 100)` where
 * `total = Σ balance` (which can be ≤ 0 when balances net out or go negative),
 * so a partner with a negative HOLDING balance produced a negative %. The fix
 * computes the share over `Σ|balance|` and shows «—» for a negative balance or a
 * non-positive total. We pin the exported pure helper directly.
 */
import { describe, expect, it } from 'vitest'
import { partnerShare } from '../routes/_authenticated/stats'

describe('partnerShare (#14)', () => {
  it('two positive balances → complementary percentages, no «—»', () => {
    // 78238.34 + 93205.82 = 171444.16 → ~46% / ~54%.
    const a = partnerShare(78238.34, 171444.16)
    const b = partnerShare(93205.82, 171444.16)
    expect(a.label).toBe('46%')
    expect(b.label).toBe('54%')
    expect(a.barPct).toBe(46)
    expect(b.barPct).toBe(54)
  })

  it('negative balance → label «—» (NEVER a negative %)', () => {
    // absTotal = 1000 + 200 = 1200; the −200 partner must not show «-17%».
    const r = partnerShare(-200, 1200)
    expect(r.label).toBe('—')
    expect(r.label).not.toContain('-')
    // The bar still renders a positive magnitude.
    expect(r.barPct).toBe(17)
  })

  it('non-positive total → «—» and 0 bar (no division blow-up)', () => {
    expect(partnerShare(0, 0)).toEqual({ label: '—', barPct: 0 })
    expect(partnerShare(100, 0)).toEqual({ label: '—', barPct: 0 })
  })

  it('zero balance with positive total → 0%', () => {
    expect(partnerShare(0, 500).label).toBe('0%')
  })
})
