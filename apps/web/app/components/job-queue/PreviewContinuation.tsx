import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { Trans } from '@lingui/react/macro'
import { Button } from '@/components/ui/button'

/** What a card-preview continuation (`useJobQueueSeniors` / `useJobQueueSources`) reports. */
export interface Continuation {
  data: unknown
  hasNextPage: boolean
  isError: boolean
  isFetching: boolean
  accessLost: boolean
  fetchNextPage: () => Promise<unknown>
}

/**
 * «Показано 3 із 34 · Показати ще (20)» under a card preview (spec §5.1 item 5). The first click
 * starts the continuation from the preview's cursor (`onStart`); every later click, and a retry,
 * asks for the next page (with nothing fetched yet that loads the first). Renders nothing once
 * everything is shown or nothing is left to fetch, so the button is never dead. A 403/404 goes to
 * `onAccessLost`, the card's own close path; any other failure keeps the rows and offers a retry.
 * A running fetch keeps the button mounted but inert, so focus is not lost mid-fetch. When the last
 * page lands the button goes; if it held focus, focus moves to the first new item of `list` (each
 * item is focusable), so a keyboard user carries on reading instead of landing on the dialog.
 */
export function PreviewContinuation({
  testId,
  shown,
  total,
  pageSize,
  more,
  started,
  previewCursor,
  list,
  onStart,
  onAccessLost,
}: {
  testId: string
  shown: number
  total: number
  pageSize: number
  more: Continuation
  started: boolean
  previewCursor: string | null
  /** The list the pages append to; its children are the items, in order. */
  list: RefObject<HTMLUListElement | null>
  onStart: () => void
  onAccessLost: () => void
}) {
  useEffect(() => {
    if (more.accessLost) onAccessLost()
  }, [more.accessLost, onAccessLost])

  const button = useRef<HTMLButtonElement | null>(null)
  const firstNew = useRef(0)
  const handOff = useRef(false)
  // Held in state, not `useCallback`, so it is stable by construction: an unstable ref callback is
  // detached and re-attached on every render, which would set `handOff` while the button is focused.
  const [trackButton] = useState(() => (node: HTMLButtonElement | null) => {
    // null is React detaching the ref; it does so before it removes the button, so the button can
    // still hold focus at this point (on attach `button.current` is null, which is never focused)
    handOff.current = button.current === document.activeElement
    button.current = node
  })
  useLayoutEffect(() => {
    if (!handOff.current) return
    handOff.current = false
    // a list that regroups its items (ADMIN team runs) marks each with its fetch order
    const items = list.current!
    ;(
      (items.querySelector(`:scope > [data-arrival="${firstNew.current}"]`) ??
        items.children[firstNew.current]) as HTMLElement | undefined
    )?.focus()
  })

  const hasMore = more.data ? more.hasNextPage : previewCursor !== null
  if (!hasMore || total <= shown) return null
  const failed = more.isError && !more.accessLost
  const next = Math.min(pageSize, total - shown)
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
      {failed ? (
        <span role="alert" className="font-medium text-foreground">
          <Trans>Не вдалося завантажити ще</Trans>
        </span>
      ) : (
        <span data-testid={`${testId}-shown`} className="tabular-nums">
          <Trans>
            Показано {shown} із {total}
          </Trans>
        </span>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="min-h-11 sm:min-h-9"
        ref={trackButton}
        aria-disabled={more.isFetching || undefined}
        onClick={() => {
          if (more.isFetching) return
          firstNew.current = shown
          if (started) void more.fetchNextPage()
          else onStart()
        }}
      >
        {failed ? <Trans>Спробувати ще раз</Trans> : <Trans>Показати ще ({next})</Trans>}
      </Button>
    </div>
  )
}
