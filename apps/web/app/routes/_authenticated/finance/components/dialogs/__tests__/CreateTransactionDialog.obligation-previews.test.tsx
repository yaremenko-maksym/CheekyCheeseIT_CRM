/**
 * task-admin-income-unified (2026-08-12) — direct, exhaustive pure-function
 * pins for `computeObligationPreviews`, the function the pre-submit banner
 * (AC5/AC6/AC7/AC8) reads. This is the SAME arithmetic (`roundShareAmount`,
 * `@crm/shared`) and the SAME senior-is-admin exclusion
 * (`senior && senior.role !== 'ADMIN'`) that `bookCompanyObligations` applies
 * server-side — the whole point of predicting it client-side is that it can
 * never promise a number or a beneficiary the backend does not produce.
 *
 * `CreateTransactionDialog.usdt-income.test.tsx` already exercises this
 * function indirectly through the rendered dialog (one or two scenarios).
 * This file pins every branch directly — no rendering, no user-event, no
 * network — so each guard (NaN/negative amount, NaN/non-positive usdRate,
 * missing share, senior-is-admin exclusion, source-label fallback, name
 * fallback) has its own assertion instead of riding along with a UI test
 * that would still pass if that ONE guard were deleted.
 */
import { describe, expect, it } from 'vitest'
import {
  computeObligationPreviews,
  type ObligationPreview,
  type ProjectOption,
} from '../CreateTransactionDialog'

function project(overrides: Partial<ProjectOption> = {}): ProjectOption {
  return {
    id: 'proj-1',
    name: 'Test Project',
    seniorId: 'senior-1',
    paymentType: 'USDT',
    ...overrides,
  }
}

describe('computeObligationPreviews', () => {
  it('returns [] when no project is selected', () => {
    expect(computeObligationPreviews(undefined, 100, false, 1)).toEqual([])
  })

  it('returns [] when the project is not USDT-payment (createAdminIncome never books obligations — AC3)', () => {
    const p = project({ paymentType: 'FOP', dropId: 'drop-1', effectiveDropSharePercent: 5 })
    expect(computeObligationPreviews(p, 100, false, 1)).toEqual([])
  })

  it('returns [] when paymentType is missing entirely', () => {
    const p = project({ paymentType: null, dropId: 'drop-1', effectiveDropSharePercent: 5 })
    expect(computeObligationPreviews(p, 100, false, 1)).toEqual([])
  })

  describe('senior preview', () => {
    it('is OMITTED when the senior is an admin (mirrors bookCompanyObligations — no IOU to yourself)', () => {
      const p = project({ effectiveSeniorSharePercent: 26 })
      const previews = computeObligationPreviews(p, 200, /* seniorIsAdmin */ true, 1)
      expect(previews.find((x) => x.role === 'SENIOR')).toBeUndefined()
    })

    it('appears when the senior is NOT an admin and a share percent is resolved', () => {
      const p = project({ seniorName: 'Oleksiy Kovalenko', effectiveSeniorSharePercent: 26 })
      const previews = computeObligationPreviews(p, 200, /* seniorIsAdmin */ false, 1)
      const senior = previews.find((x) => x.role === 'SENIOR')
      expect(senior).toBeDefined()
      expect(senior!.name).toBe('Oleksiy Kovalenko')
      expect(senior!.roleLabel).toBe('Синьору')
      expect(senior!.percent).toBe(26)
    })

    it('falls back to "—" when the senior has no display name', () => {
      const p = project({ seniorName: null, effectiveSeniorSharePercent: 26 })
      const previews = computeObligationPreviews(p, 200, false, 1)
      expect(previews.find((x) => x.role === 'SENIOR')!.name).toBe('—')
    })

    it('is OMITTED when no senior share percent is resolved (null)', () => {
      const p = project({ effectiveSeniorSharePercent: null })
      const previews = computeObligationPreviews(p, 200, false, 1)
      expect(previews.find((x) => x.role === 'SENIOR')).toBeUndefined()
    })

    it('is OMITTED when seniorId is falsy even if a percent is resolved', () => {
      const p = project({ seniorId: '', effectiveSeniorSharePercent: 26 })
      const previews = computeObligationPreviews(p, 200, false, 1)
      expect(previews.find((x) => x.role === 'SENIOR')).toBeUndefined()
    })

    it.each([
      ['PROJECT', 'проект'],
      ['TEAM', 'команда'],
      ['USER_DEFAULT', 'по умолчанию'],
    ] as const)('maps source %s to the label "%s"', (source, label) => {
      const p = project({ effectiveSeniorSharePercent: 26, effectiveSeniorShareSource: source })
      const previews = computeObligationPreviews(p, 200, false, 1)
      expect(previews.find((x) => x.role === 'SENIOR')!.sourceLabel).toBe(label)
    })

    it('defaults the source label to "по умолчанию" when the source is missing (null)', () => {
      const p = project({ effectiveSeniorSharePercent: 26, effectiveSeniorShareSource: null })
      const previews = computeObligationPreviews(p, 200, false, 1)
      expect(previews.find((x) => x.role === 'SENIOR')!.sourceLabel).toBe('по умолчанию')
    })
  })

  describe('drop preview', () => {
    it('appears when a drop is bound and a share percent is resolved — REGARDLESS of who the senior is', () => {
      const p = project({
        dropId: 'drop-1',
        dropName: 'Dropper One',
        effectiveDropSharePercent: 5,
      })
      // seniorIsAdmin=true excludes the SENIOR preview but must never touch DROP.
      const previews = computeObligationPreviews(p, 200, true, 1)
      const drop = previews.find((x) => x.role === 'DROP')
      expect(drop).toBeDefined()
      expect(drop!.name).toBe('Dropper One')
      expect(drop!.roleLabel).toBe('Дропу')
      expect(drop!.percent).toBe(5)
    })

    it('falls back to "—" when the drop has no display name', () => {
      const p = project({ dropId: 'drop-1', dropName: null, effectiveDropSharePercent: 5 })
      const previews = computeObligationPreviews(p, 200, false, 1)
      expect(previews.find((x) => x.role === 'DROP')!.name).toBe('—')
    })

    it('is OMITTED when no drop is bound (dropId falsy)', () => {
      const p = project({ dropId: null, effectiveDropSharePercent: 5 })
      const previews = computeObligationPreviews(p, 200, false, 1)
      expect(previews.find((x) => x.role === 'DROP')).toBeUndefined()
    })

    it('is OMITTED when no drop share percent is resolved (null)', () => {
      const p = project({ dropId: 'drop-1', effectiveDropSharePercent: null })
      const previews = computeObligationPreviews(p, 200, false, 1)
      expect(previews.find((x) => x.role === 'DROP')).toBeUndefined()
    })

    it.each([
      ['PROJECT', 'проект'],
      ['USER_DEFAULT', 'по умолчанию'],
    ] as const)('maps source %s to the label "%s"', (source, label) => {
      const p = project({
        dropId: 'drop-1',
        effectiveDropSharePercent: 5,
        effectiveDropShareSource: source,
      })
      const previews = computeObligationPreviews(p, 200, false, 1)
      expect(previews.find((x) => x.role === 'DROP')!.sourceLabel).toBe(label)
    })

    it('defaults the source label to "по умолчанию" when the source is missing (null)', () => {
      const p = project({
        dropId: 'drop-1',
        effectiveDropSharePercent: 5,
        effectiveDropShareSource: null,
      })
      const previews = computeObligationPreviews(p, 200, false, 1)
      expect(previews.find((x) => x.role === 'DROP')!.sourceLabel).toBe('по умолчанию')
    })
  })

  it('both previews appear together, senior first then drop (push order)', () => {
    const p = project({
      effectiveSeniorSharePercent: 26,
      dropId: 'drop-1',
      effectiveDropSharePercent: 5,
    })
    const previews = computeObligationPreviews(p, 1000, false, 1)
    expect(previews.map((x) => x.role)).toEqual(['SENIOR', 'DROP'])
  })

  describe('amount arithmetic — must match the server to the cent (AC6)', () => {
    it('reproduces the exact prod incident: 4708.69 USDT at a 5% drop share', () => {
      const p = project({ dropId: 'drop-1', effectiveDropSharePercent: 5 })
      const previews = computeObligationPreviews(p, 4708.69, false, 1)
      // 4708.69 * 0.05 = 235.4345 — the exact incident amount. Cross-checked
      // against `roundShareAmount` directly in `packages/shared/src/utils/money.spec.ts`.
      expect(previews.find((x) => x.role === 'DROP')!.amount).toBe(235.4345)
    })

    it('multiplies by usdRate when a conversion rate is supplied', () => {
      const p = project({ dropId: 'drop-1', effectiveDropSharePercent: 10 })
      // 100 (typed amount) * usdRate 2 = 200 effective USDT * 10% = 20.
      const previews = computeObligationPreviews(p, 100, false, 2)
      expect(previews.find((x) => x.role === 'DROP')!.amount).toBe(20)
    })

    it('treats a NaN usdRate as 1 (no silent NaN propagation into the banner)', () => {
      const p = project({ dropId: 'drop-1', effectiveDropSharePercent: 10 })
      const previews = computeObligationPreviews(p, 100, false, NaN)
      expect(previews.find((x) => x.role === 'DROP')!.amount).toBe(10)
    })

    it('treats a non-positive usdRate as 1', () => {
      const p = project({ dropId: 'drop-1', effectiveDropSharePercent: 10 })
      const previews = computeObligationPreviews(p, 100, false, 0)
      expect(previews.find((x) => x.role === 'DROP')!.amount).toBe(10)
    })

    it.each([
      ['empty/NaN amount', NaN],
      ['zero amount', 0],
      ['negative amount', -50],
    ])(
      'still shows the preview row at amount 0 for %s — the FACT of the obligation must not disappear (AC7)',
      (_label, amount) => {
        const p = project({ dropId: 'drop-1', effectiveDropSharePercent: 10 })
        const previews = computeObligationPreviews(p, amount, false, 1)
        const drop = previews.find((x) => x.role === 'DROP')
        expect(drop).toBeDefined()
        expect(drop!.amount).toBe(0)
      },
    )
  })
})

// Compile-time pin: the exported type must carry every field the banner JSX
// reads (amount/percent/sourceLabel/roleLabel/name) — a Stryker-style "delete
// a field" edit would fail `tsc`, not just a runtime test.
const _typeCheck: ObligationPreview = {
  role: 'DROP',
  roleLabel: 'Дропу',
  name: 'x',
  percent: 1,
  sourceLabel: 'проект',
  amount: 1,
}
void _typeCheck
