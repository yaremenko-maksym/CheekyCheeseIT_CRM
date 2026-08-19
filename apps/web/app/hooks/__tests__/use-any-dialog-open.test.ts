/**
 * use-any-dialog-open.ts — unit tests (backlog #137).
 *
 * Pins:
 * 1. Starts false with no matching element in the document.
 * 2. Starts true if a role="dialog"[data-state="open"] element is already
 *    present at mount (matters because the flip can happen before the
 *    observer attaches).
 * 3. Flips true when a role="dialog" element opens after mount.
 * 4. Flips true for role="alertdialog" too (AlertDialog, used in 14+ files
 *    across the app — NOT covered by a naive `[role="dialog"]`-only
 *    selector, which would have reopened backlog #137 for every confirm/
 *    delete flow built on AlertDialog).
 * 5. Flips back false when data-state flips to "closed" (Radix keeps the
 *    node mounted mid exit-animation) without the node being removed.
 * 6. Flips back false when the dialog node is removed outright.
 * 7. Does NOT flip true for an open Select (role="listbox") — review found
 *    react-remove-scroll-bar's data-scroll-locked (an earlier version of
 *    this hook's signal) is set by Select/DropdownMenu too, since both are
 *    modal=true by default; this pins that the CURRENT role-based signal is
 *    scoped to true dialogs only, per the PR's actual claim.
 * 8. Does NOT flip true for an open DropdownMenu (role="menu") either.
 * 9. Ignores unrelated attribute changes on body.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useAnyDialogOpen } from '../use-any-dialog-open'

function appendOverlay(role: string, state: string): HTMLElement {
  const el = document.createElement('div')
  el.setAttribute('role', role)
  el.setAttribute('data-state', state)
  document.body.appendChild(el)
  return el
}

afterEach(() => {
  document.body.innerHTML = ''
  document.body.removeAttribute('data-unrelated')
})

describe('useAnyDialogOpen', () => {
  it('starts false with no matching element', () => {
    const { result } = renderHook(() => useAnyDialogOpen())
    expect(result.current).toBe(false)
  })

  it('starts true if a role="dialog" open element is already present at mount', () => {
    appendOverlay('dialog', 'open')
    const { result } = renderHook(() => useAnyDialogOpen())
    expect(result.current).toBe(true)
  })

  it('flips true when a role="dialog" element opens after mount', async () => {
    const { result } = renderHook(() => useAnyDialogOpen())
    expect(result.current).toBe(false)

    act(() => {
      appendOverlay('dialog', 'open')
    })

    await waitFor(() => expect(result.current).toBe(true))
  })

  it('flips true for role="alertdialog" too', async () => {
    const { result } = renderHook(() => useAnyDialogOpen())
    expect(result.current).toBe(false)

    act(() => {
      appendOverlay('alertdialog', 'open')
    })

    await waitFor(() => expect(result.current).toBe(true))
  })

  it('flips back false when data-state flips to closed (element still mounted)', async () => {
    const el = appendOverlay('dialog', 'open')
    const { result } = renderHook(() => useAnyDialogOpen())
    expect(result.current).toBe(true)

    act(() => {
      el.setAttribute('data-state', 'closed')
    })

    await waitFor(() => expect(result.current).toBe(false))
  })

  it('flips back false when the dialog node is removed outright', async () => {
    const el = appendOverlay('dialog', 'open')
    const { result } = renderHook(() => useAnyDialogOpen())
    expect(result.current).toBe(true)

    act(() => {
      el.remove()
    })

    await waitFor(() => expect(result.current).toBe(false))
  })

  it('does NOT flip true for an open Select (role="listbox") without a dialog', async () => {
    const { result } = renderHook(() => useAnyDialogOpen())
    expect(result.current).toBe(false)

    act(() => {
      appendOverlay('listbox', 'open')
    })

    // Give the MutationObserver a tick to fire if it were (incorrectly)
    // going to — it should not, so this stays false.
    await new Promise((r) => setTimeout(r, 0))
    expect(result.current).toBe(false)
  })

  it('does NOT flip true for an open DropdownMenu (role="menu") without a dialog', async () => {
    const { result } = renderHook(() => useAnyDialogOpen())
    expect(result.current).toBe(false)

    act(() => {
      appendOverlay('menu', 'open')
    })

    await new Promise((r) => setTimeout(r, 0))
    expect(result.current).toBe(false)
  })

  it('ignores unrelated attribute changes on body', async () => {
    const { result } = renderHook(() => useAnyDialogOpen())
    expect(result.current).toBe(false)

    act(() => {
      document.body.setAttribute('data-unrelated', 'x')
    })

    await new Promise((r) => setTimeout(r, 0))
    expect(result.current).toBe(false)
  })
})
