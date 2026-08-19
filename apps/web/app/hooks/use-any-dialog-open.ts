import { useEffect, useState } from 'react'

// react-remove-scroll-bar (a dependency of @radix-ui/react-dialog, used by
// every Dialog/AlertDialog/Sheet in this app — Sheet is @radix-ui/react-dialog
// under a different skin, see components/ui/sheet.tsx) sets this attribute
// on <body> for as long as at least one modal is open, and reference-counts
// it so it stays correct with nested/stacked modals. We piggy-back on it
// instead of building our own "is a dialog open" tracker.
const LOCK_ATTR = 'data-scroll-locked'

function bodyIsLocked(): boolean {
  return typeof document !== 'undefined' && document.body.hasAttribute(LOCK_ATTR)
}

/**
 * True while at least one Radix modal overlay (Dialog / AlertDialog / Sheet)
 * is open anywhere in the app.
 *
 * backlog #137 ("Escape sometimes doesn't close a dialog"): every
 * @radix-ui/react-dismissable-layer instance registers into ONE unscoped,
 * module-global stack shared by every Dialog/Tooltip/DropdownMenu/Popover/
 * Select in the app. Escape only closes the layer at the END of that stack
 * (`index === layers.size - 1` in the library's own source) — an ordering
 * decided purely by MOUNT ORDER, not DOM nesting or z-index. A hover/focus
 * -triggered chrome tooltip (nav-sidebar.tsx) that opens WHILE a Dialog is
 * already open gets appended AFTER the Dialog's layer and briefly becomes
 * "highest", silently swallowing the next Escape meant for the Dialog
 * (Radix's `useEscapeKeydown` early-returns without `preventDefault` when
 * `!isHighestLayer` — see PR #567's instrumented root-cause writeup).
 *
 * Radix doesn't expose that shared stack for us to scope it, so instead we
 * remove the specific competing actor: chrome-level hint tooltips have no
 * legitimate reason to steal keyboard priority from a modal the user just
 * opened, so they simply don't open while one is up. Tooltips/selects INSIDE
 * an open dialog are untouched — they don't consult this hook.
 */
export function useAnyDialogOpen(): boolean {
  const [open, setOpen] = useState(bodyIsLocked)

  useEffect(() => {
    setOpen(bodyIsLocked())
    const observer = new MutationObserver(() => setOpen(bodyIsLocked()))
    observer.observe(document.body, { attributes: true, attributeFilter: [LOCK_ATTR] })
    return () => observer.disconnect()
  }, [])

  return open
}
