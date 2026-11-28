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

  // The 44 px control sits 2 px from the panel edge, so an outer ring could be cut off there.
  it('keeps the close control focus ring inside the button', async () => {
    await loadCatalog('uk')
    renderDialog()
    expect(screen.getByRole('button', { name: 'Закрити' })).toHaveClass(
      'right-0.5',
      'top-0.5',
      'h-11',
      'w-11',
      'focus:ring-inset',
    )
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

  // The enter/exit animations sit on `data-[state=…]` (specificity 0,2,0), so the opt-out must too: a
  // bare `motion-reduce:animate-none` (0,1,0) loses. Computed style is checked in the built CSS, not here.
  it('opts the panel and its overlay out of motion when the user asks for less', async () => {
    await loadCatalog('uk')
    renderDialog()
    const panel = screen.getByRole('dialog')
    expect(panel).toHaveClass(
      'motion-reduce:data-[state=open]:animate-none',
      'motion-reduce:data-[state=closed]:animate-none',
    )
    // eslint-disable-next-line testing-library/no-node-access -- the overlay has no role; it is the panel's sibling in the same portal
    const overlay = panel.previousElementSibling
    expect(overlay).toHaveAttribute('data-state', 'open')
    expect(overlay).toHaveClass(
      'motion-reduce:data-[state=open]:animate-none',
      'motion-reduce:data-[state=closed]:animate-none',
    )
  })
})
