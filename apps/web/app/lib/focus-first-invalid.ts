/**
 * After a failed submit: move focus to the first control marked
 * `aria-invalid="true"` inside `root` and bring it into view, so a keyboard or
 * screen-reader user lands on the field that blocked the submit (UX-M-2).
 * Returns whether a control was found; with none, focus stays where it was.
 */
export function focusFirstInvalid(root: ParentNode | null | undefined): boolean {
  const el = root?.querySelector<HTMLElement>('[aria-invalid="true"]')
  if (!el) return false
  // preventScroll + an explicit centred scroll: the plain focus() scroll can
  // leave the field under a sticky dialog footer.
  el.focus({ preventScroll: true })
  el.scrollIntoView({ block: 'center' })
  return true
}
