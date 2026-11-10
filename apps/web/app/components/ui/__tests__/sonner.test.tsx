import { act, render, screen } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, describe, expect, it } from 'vitest'
import { Toaster } from '../sonner'

afterEach(() => {
  act(() => toast.dismiss())
})

describe('Toaster', () => {
  // UX-M-1 (r3): a Radix modal sets `pointer-events: none` on <body>; the toaster re-enables itself
  it('keeps its toasts pressable under a modal dialog', async () => {
    render(<Toaster />)
    act(() => {
      toast('Saved')
    })
    const toaster = await screen.findByRole('list')
    expect(toaster).toHaveAttribute('data-sonner-toaster')
    expect(toaster).toHaveClass('pointer-events-auto')
  })
})
