/**
 * crm-dialog.tsx — unit tests for `CrmDialogContent`'s Close button.
 *
 * task-i18n-stage3a (Task 1), fix-round 2 (CR-M-4). `crm-dialog.tsx` has
 * 31 consumers and was DEFERRED in fix-round 1 (FR-8, re-confirmed by
 * SPEC-M-1): wrapping its Close button's `aria-label` with `useLingui()`
 * broke 23 test files / ~230 tests that don't wrap `I18nTestProvider`.
 * This round tries the alternative CR-M-4 itself proposed — `i18n._()` off
 * the MODULE-LEVEL singleton (`@/lib/i18n`), not the `useLingui()` hook —
 * which reads the locale directly without needing a provider ancestor. The
 * full web suite (196 files / 2683 tests) stayed green with this change, so
 * these are this component's own FIRST dedicated tests (mutation-gate
 * debt this round also closes — MUT-1/MUT-2, `crm-dialog.tsx` is part of
 * the diff).
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { loadCatalog } from '@/test/i18n'
import { CrmDialogContent, Dialog, DialogTitle } from '../crm-dialog'

function renderDialog() {
  return render(
    <Dialog open>
      <CrmDialogContent>
        <DialogTitle>Test dialog</DialogTitle>
      </CrmDialogContent>
    </Dialog>,
  )
}

describe('CrmDialogContent — Close button aria-label (CR-M-4)', () => {
  it('reads the uk catalog label WITHOUT an I18nProvider ancestor', async () => {
    await loadCatalog('uk')
    renderDialog()
    expect(screen.getByRole('button', { name: 'Закрити' })).toBeInTheDocument()
  })

  it('reads the en catalog label WITHOUT an I18nProvider ancestor', async () => {
    await loadCatalog('en')
    renderDialog()
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
  })

  it('never falls back to the pre-migration Russian literal', async () => {
    await loadCatalog('uk')
    renderDialog()
    expect(screen.queryByRole('button', { name: 'Закрыть' })).not.toBeInTheDocument()
  })
})
