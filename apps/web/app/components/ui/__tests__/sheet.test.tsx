/**
 * sheet.tsx — the shared Radix side-sheet shell: its default close control, the side variants and
 * the reduced-motion opt-out (PR #1401, fix round 1).
 */
import { render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it } from 'vitest'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'
import { Sheet, SheetContent, SheetTitle } from '../sheet'

type Side = 'top' | 'bottom' | 'left' | 'right'

function renderSheet(side?: Side) {
  render(
    <Sheet open>
      <SheetContent side={side}>
        <SheetTitle>T</SheetTitle>
      </SheetContent>
    </Sheet>,
    { wrapper: I18nTestProvider },
  )
  return screen.getByRole('dialog')
}

beforeAll(() => loadCatalog('uk'), 60_000)

describe('SheetContent', () => {
  it('shows the named close control by default', () => {
    renderSheet()
    expect(screen.getByRole('button', { name: 'Закрити' })).toBeInTheDocument()
  })

  it.each([
    { side: undefined, edge: 'right-0' },
    { side: 'right', edge: 'right-0' },
    { side: 'left', edge: 'left-0' },
    { side: 'top', edge: 'top-0' },
    { side: 'bottom', edge: 'bottom-0' },
  ] as const)('anchors to the $edge edge (side $side)', ({ side, edge }) => {
    expect(renderSheet(side)).toHaveClass(edge)
  })

  // The enter/exit animations sit on `data-[state=…]` (specificity 0,2,0), so the opt-out must too: a
  // bare `motion-reduce:animate-none` (0,1,0) loses. Computed style is checked in the built CSS, not here.
  it('opts the panel and its overlay out of motion when the user asks for less', () => {
    const panel = renderSheet()
    expect(panel).toHaveClass(
      'motion-reduce:data-[state=open]:animate-none',
      'motion-reduce:data-[state=closed]:animate-none',
      'motion-reduce:transition-none',
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
