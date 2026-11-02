import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ reduced: false as boolean | null }))
vi.mock('framer-motion', () => ({ useReducedMotion: () => state.reduced }))

import { SUBMIT_ERROR_ID, SubmitErrorBanner } from '../SubmitErrorBanner'

const scrollIntoView = vi.fn()

beforeEach(() => {
  state.reduced = false
  scrollIntoView.mockReset()
  Element.prototype.scrollIntoView = scrollIntoView
})

describe('SubmitErrorBanner', () => {
  it('is a polite live region as well (spec 6.5)', () => {
    render(<SubmitErrorBanner message="boom" />)
    expect(screen.getByRole('alert')).toHaveAttribute('aria-live', 'polite')
  })

  it('is an alert with the stable anchor id', () => {
    render(<SubmitErrorBanner message="boom" />)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('boom')
    expect(SUBMIT_ERROR_ID).toBe('admin-edit-submit-error')
    expect(alert).toHaveAttribute('id', 'admin-edit-submit-error')
  })

  it('scrolls itself into view once, smoothly and minimally', () => {
    render(<SubmitErrorBanner message="boom" />)
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'smooth' })
  })

  it('jumps instead of animating under reduced motion', () => {
    state.reduced = true
    render(<SubmitErrorBanner message="boom" />)
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'auto' })
  })

  it('re-scrolls on a new message but not on a re-render with the same one', () => {
    const { rerender } = render(<SubmitErrorBanner message="one" />)
    rerender(<SubmitErrorBanner message="one" />)
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    rerender(<SubmitErrorBanner message="two" />)
    expect(scrollIntoView).toHaveBeenCalledTimes(2)
  })
})
