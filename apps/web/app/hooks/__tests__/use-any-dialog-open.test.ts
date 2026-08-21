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
 * 10. Observes the `role` attribute specifically — an element already in the
 *     DOM that becomes a dialog by role change alone (no childList mutation,
 *     no data-state change) still flips the hook. Without 'role' in
 *     attributeFilter this is invisible.
 * 11. Disconnects the observer on unmount — a leaked observer keeps calling
 *     setState on an unmounted hook for the lifetime of the page.
 * 12. Attaches exactly ONE observer across re-renders (the effect's empty
 *     dependency array). A non-empty/unstable dep array re-runs the effect
 *     every render, stacking one live observer per render.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { aDialogIsOpen, useAnyDialogOpen } from '../use-any-dialog-open'

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

  it('observes the role attribute itself — an already-mounted node that BECOMES a dialog flips the hook', async () => {
    // Mutates `role` only: the node is already in the DOM (no childList
    // mutation) and its data-state never changes. The sole signal is the
    // `role` attribute, so this fails if 'role' is missing from
    // attributeFilter — the other tests all ride on childList or data-state
    // and cannot tell the two filter entries apart.
    const el = appendOverlay('listbox', 'open')
    const { result } = renderHook(() => useAnyDialogOpen())
    expect(result.current).toBe(false)

    act(() => {
      el.setAttribute('role', 'dialog')
    })

    await waitFor(() => expect(result.current).toBe(true))
  })

  it('disconnects the observer on unmount — no further callbacks after teardown', async () => {
    const disconnect = vi.fn()
    const observe = vi.fn()
    const RealObserver = globalThis.MutationObserver
    class SpyObserver {
      observe = observe
      disconnect = disconnect
      takeRecords = () => []
      constructor(_cb: MutationCallback) {}
    }
    vi.stubGlobal('MutationObserver', SpyObserver)

    try {
      const { unmount } = renderHook(() => useAnyDialogOpen())
      expect(observe).toHaveBeenCalledTimes(1)
      expect(disconnect).not.toHaveBeenCalled()

      unmount()

      expect(disconnect).toHaveBeenCalledTimes(1)
    } finally {
      vi.stubGlobal('MutationObserver', RealObserver)
    }
  })

  it('aDialogIsOpen returns false (never throws) when there is no document at all — SSR', () => {
    // The hook itself cannot be rendered without a document (its useState
    // initialiser calls this during render), so the guard is only reachable
    // through a direct call. Without the guard this throws a TypeError on
    // `document.querySelector`; with it inverted it would return false even
    // when a dialog IS present, which the case below pins.
    vi.stubGlobal('document', undefined)
    try {
      expect(aDialogIsOpen()).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('aDialogIsOpen returns true for a present open dialog — the guard must not short-circuit that', () => {
    appendOverlay('dialog', 'open')
    expect(aDialogIsOpen()).toBe(true)
  })

  it('attaches exactly ONE observer across re-renders (empty dep array)', () => {
    const disconnect = vi.fn()
    const observe = vi.fn()
    const RealObserver = globalThis.MutationObserver
    class SpyObserver {
      observe = observe
      disconnect = disconnect
      takeRecords = () => []
      constructor(_cb: MutationCallback) {}
    }
    vi.stubGlobal('MutationObserver', SpyObserver)

    try {
      const { rerender } = renderHook(() => useAnyDialogOpen())
      rerender()
      rerender()

      // An unstable/non-empty dep array re-runs the effect on every render,
      // which would show up here as one observe() (and one disconnect()) per
      // render instead of a single attach for the hook's whole lifetime.
      expect(observe).toHaveBeenCalledTimes(1)
      expect(disconnect).not.toHaveBeenCalled()
    } finally {
      vi.stubGlobal('MutationObserver', RealObserver)
    }
  })
})
