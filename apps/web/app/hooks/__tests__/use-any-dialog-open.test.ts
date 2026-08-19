/**
 * use-any-dialog-open.ts — unit tests (backlog #137).
 *
 * Pins:
 * 1. Starts false when <body> has no data-scroll-locked.
 * 2. Starts true if <body> already carries data-scroll-locked at mount
 *    (matters because the flip can happen before the observer attaches).
 * 3. Flips true when data-scroll-locked is added after mount.
 * 4. Flips back false when data-scroll-locked is removed.
 * 5. Ignores unrelated attribute changes on <body>.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useAnyDialogOpen } from '../use-any-dialog-open'

afterEach(() => {
  document.body.removeAttribute('data-scroll-locked')
  document.body.removeAttribute('data-unrelated')
})

describe('useAnyDialogOpen', () => {
  it('starts false with no lock attribute', () => {
    const { result } = renderHook(() => useAnyDialogOpen())
    expect(result.current).toBe(false)
  })

  it('starts true if the lock attribute is already present at mount', () => {
    document.body.setAttribute('data-scroll-locked', '1')
    const { result } = renderHook(() => useAnyDialogOpen())
    expect(result.current).toBe(true)
  })

  it('flips true when data-scroll-locked is added after mount', async () => {
    const { result } = renderHook(() => useAnyDialogOpen())
    expect(result.current).toBe(false)

    act(() => {
      document.body.setAttribute('data-scroll-locked', '1')
    })

    await waitFor(() => expect(result.current).toBe(true))
  })

  it('flips back false when data-scroll-locked is removed', async () => {
    document.body.setAttribute('data-scroll-locked', '1')
    const { result } = renderHook(() => useAnyDialogOpen())
    expect(result.current).toBe(true)

    act(() => {
      document.body.removeAttribute('data-scroll-locked')
    })

    await waitFor(() => expect(result.current).toBe(false))
  })

  it('ignores unrelated attribute changes on body', async () => {
    const { result } = renderHook(() => useAnyDialogOpen())
    expect(result.current).toBe(false)

    act(() => {
      document.body.setAttribute('data-unrelated', 'x')
    })

    // Give the MutationObserver a microtask/macrotask to fire if it were
    // (incorrectly) going to — it should not, so this stays false.
    await new Promise((r) => setTimeout(r, 0))
    expect(result.current).toBe(false)
  })
})
