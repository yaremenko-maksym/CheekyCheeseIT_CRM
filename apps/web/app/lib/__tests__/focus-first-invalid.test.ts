import { afterEach, describe, expect, it, vi } from 'vitest'
import { focusFirstInvalid } from '../focus-first-invalid'

function mount(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.appendChild(root)
  return root
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('focusFirstInvalid', () => {
  it('focuses the FIRST control marked aria-invalid and scrolls it into view', () => {
    const root = mount(
      '<input id="ok" /><input id="a" aria-invalid="true" /><input id="b" aria-invalid="true" />',
    )
    const first = root.querySelector<HTMLInputElement>('#a')!
    const scroll = vi.fn()
    first.scrollIntoView = scroll
    expect(focusFirstInvalid(root)).toBe(true)
    expect(document.activeElement).toBe(first)
    expect(scroll).toHaveBeenCalledWith({ block: 'center' })
  })

  it('focuses without the browser scroll, leaving the centring to scrollIntoView', () => {
    const root = mount('<input id="a" aria-invalid="true" />')
    const el = root.querySelector<HTMLInputElement>('#a')!
    const focus = vi.spyOn(el, 'focus')
    focusFirstInvalid(root)
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })
  })

  it('ignores aria-invalid="false" and leaves focus alone when nothing is invalid', () => {
    const root = mount('<button id="next">Next</button><input aria-invalid="false" />')
    const next = root.querySelector<HTMLButtonElement>('#next')!
    next.focus()
    expect(focusFirstInvalid(root)).toBe(false)
    expect(document.activeElement).toBe(next)
  })

  it('is a no-op without a root', () => {
    expect(focusFirstInvalid(null)).toBe(false)
  })
})
