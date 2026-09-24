/**
 * share-slider.tsx — unit tests for `<ShareSlider>`.
 *
 * task-i18n-stage3a (Task 1), fix-round 2 (MUT-1/MUT-2). ZERO tests existed
 * for this file before this round — the fix-round-1 mutation-gate follow-up
 * flagged it in "Remaining gap, itemized" (17 survived / 0 no-coverage on a
 * scoped `mutation:changed` run) as pre-existing debt from Steps 1-7.
 *
 * `companyPct = 100 - value` (`value` is the role's own share). The bar
 * shows "N% <label>" once there's room (≥ 12%), otherwise a bare "N%".
 * 12 is the EXACT boundary where `>=` and `>` first disagree.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { ShareSlider } from '../share-slider'

function renderSlider(props: Partial<Parameters<typeof ShareSlider>[0]> = {}) {
  return render(<ShareSlider value={50} onChange={vi.fn()} {...props} />, {
    wrapper: I18nTestProvider,
  })
}

describe('ShareSlider — company/role percentage labels (MUT-1)', () => {
  it('shows both sides with their full label when both are ≥ 12%', async () => {
    await loadCatalog('uk')
    renderSlider({ value: 50 })
    // companyPct = 50, seniorPct = 50 — both above the 12% threshold.
    expect(screen.getByText('50% компанії')).toBeInTheDocument()
    expect(screen.getByText('50% сеньйора')).toBeInTheDocument()
  })

  it('shows a bare percentage for the SENIOR side when it drops below 12%', async () => {
    await loadCatalog('uk')
    renderSlider({ value: 5 })
    // seniorPct = 5 (<12, bare); companyPct = 95 (≥12, labeled).
    expect(screen.getByText('5%')).toBeInTheDocument()
    expect(screen.queryByText('5% сеньйора')).not.toBeInTheDocument()
    expect(screen.getByText('95% компанії')).toBeInTheDocument()
  })

  it('shows a bare percentage for the COMPANY side when it drops below 12%', async () => {
    await loadCatalog('uk')
    renderSlider({ value: 95 })
    // companyPct = 5 (<12, bare); seniorPct = 95 (≥12, labeled).
    expect(screen.getByText('5%')).toBeInTheDocument()
    expect(screen.queryByText('5% компанії')).not.toBeInTheDocument()
    expect(screen.getByText('95% сеньйора')).toBeInTheDocument()
  })

  it('labels BOTH sides at the exact 12% boundary (the only value >= and > disagree on)', async () => {
    await loadCatalog('uk')
    const { rerender } = render(<ShareSlider value={12} onChange={vi.fn()} />, {
      wrapper: I18nTestProvider,
    })
    // seniorPct = 12 (boundary, labeled); companyPct = 88 (labeled).
    expect(screen.getByText('12% сеньйора')).toBeInTheDocument()
    expect(screen.getByText('88% компанії')).toBeInTheDocument()

    rerender(<ShareSlider value={88} onChange={vi.fn()} />)
    // companyPct = 12 (boundary, labeled); seniorPct = 88 (labeled).
    expect(screen.getByText('12% компанії')).toBeInTheDocument()
    expect(screen.getByText('88% сеньйора')).toBeInTheDocument()
  })

  it('carries the same label in the title attribute (tooltip on truncation)', async () => {
    await loadCatalog('uk')
    renderSlider({ value: 50 })
    expect(screen.getByText('50% компанії')).toHaveAttribute('title', '50% компанії')
    expect(screen.getByText('50% сеньйора')).toHaveAttribute('title', '50% сеньйора')
  })

  it('uses the DROP role label instead of the default SENIOR one', async () => {
    await loadCatalog('uk')
    renderSlider({ value: 50, role: 'DROP' })
    expect(screen.getByText('50% дропа')).toBeInTheDocument()
  })

  it('both inputs share the role-aware aria-label', async () => {
    await loadCatalog('uk')
    renderSlider({ value: 50, role: 'DROP' })
    const labeled = screen.getAllByLabelText('Частка дропа у відсотках')
    expect(labeled).toHaveLength(2)
  })
})
