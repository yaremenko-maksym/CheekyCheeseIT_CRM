import { useEffect, useState } from 'react'

// Matches exactly what Radix itself calls a "dialog": Dialog (role="dialog")
// and AlertDialog (role="alertdialog") — Sheet is @radix-ui/react-dialog
// under a different skin (see components/ui/sheet.tsx), so it's covered by
// "dialog" too. Both packages hard-code this role on the content element
// (verified in the installed @radix-ui/react-dialog and
// @radix-ui/react-alert-dialog source), and `data-state` is "open" for
// exactly as long as the modal is actually up (Radix keeps the node mounted
// with data-state="closed" during its own exit animation).
//
// Deliberately does NOT use react-remove-scroll-bar's `data-scroll-locked`
// attribute on <body> — an earlier version of this hook did, and it looked
// right (every Dialog/AlertDialog/Sheet sets it, since all three use
// `modal=true` by default) but review caught that it's NOT specific to
// dialogs: Radix's Select and DropdownMenu are ALSO `modal=true` by default
// and ALSO drive the same `RemoveScroll` internals, so that attribute is
// live for those too (confirmed: 21 files use <Select>, 5 use
// <DropdownMenu>, none override `modal`). This selector is scoped to
// exactly what the PR describes — Dialog/AlertDialog/Sheet — and nothing
// else; Select/DropdownMenu/Popover content render role="listbox"/"menu"
// (verified in their installed source too), so they never match.
const DIALOG_SELECTOR =
  '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]'

// Exported ONLY so the SSR guard below is reachable from a test without a
// render: `useAnyDialogOpen` calls this during render (useState initialiser),
// so a document-less render is impossible by construction — but a direct call
// with `document` stubbed away is not. That is what makes the guard a real,
// mutation-killable branch instead of a suppressed one.
export function aDialogIsOpen(): boolean {
  if (typeof document === 'undefined') return false
  return document.querySelector(DIALOG_SELECTOR) !== null
}

// Effect body hoisted out of the useEffect call so the dependency array does
// NOT sit on a line beginning with `}` — a Stryker suppression placed there is
// silently ignored (a trap this repo has hit before).
function subscribeToDialogState(setOpen: (value: boolean) => void): () => void {
  setOpen(aDialogIsOpen())
  const observer = new MutationObserver(() => setOpen(aDialogIsOpen()))
  observer.observe(document.body, {
    attributes: true,
    attributeFilter: ['role', 'data-state'],
    childList: true,
    subtree: true,
  })
  return () => observer.disconnect()
}

/**
 * True while at least one Radix Dialog / AlertDialog / Sheet is open
 * anywhere in the app (see DIALOG_SELECTOR above for exactly what counts —
 * notably NOT Select/DropdownMenu/Popover).
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
  const [open, setOpen] = useState(aDialogIsOpen)

  // Stryker disable next-line ArrayDeclaration: exactly one mutant, provably equivalent. Stryker rewrites `[]` to `["Stryker was here"]` — a CONSTANT literal — and React diffs dependency arrays element-wise with Object.is, so a fresh array holding the same constant reads as unchanged and the effect still runs exactly once per mount. No test can distinguish them. The property this array actually encodes IS pinned: see the spec's "attaches exactly ONE observer across re-renders", which fails against an unstable dep such as `[{}]`.
  useEffect(() => subscribeToDialogState(setOpen), [])

  return open
}
