/**
 * dialog.tsx — unit tests for `DialogContent`'s Close button and its own
 * positioning/animation className.
 *
 * task-i18n-stage3a (Task 1), fix-round 2 (MUT-1/MUT-2). ZERO tests existed
 * for this file before this round.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { Dialog, DialogContent, DialogTitle } from '../dialog'

function renderDialog() {
  return render(
    <Dialog open>
      <DialogContent>
        <DialogTitle>Test dialog</DialogTitle>
      </DialogContent>
    </Dialog>,
    { wrapper: I18nTestProvider },
  )
}

describe('DialogContent', () => {
  it('Close button names itself in aria-label (uk catalog)', async () => {
    await loadCatalog('uk')
    renderDialog()
    expect(screen.getByRole('button', { name: 'Закрити' })).toBeInTheDocument()
  })

  it('is positioned as a fixed, centered, rounded panel', async () => {
    await loadCatalog('uk')
    renderDialog()
    expect(screen.getByRole('dialog')).toHaveClass(
      'fixed',
      'left-[50%]',
      'top-[50%]',
      'sm:rounded-xl',
    )
  })
})
