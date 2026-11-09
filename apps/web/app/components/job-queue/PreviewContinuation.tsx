import { useEffect } from 'react'
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
 * A running fetch keeps the button mounted but inert, so focus is not lost mid-fetch.
 */
export function PreviewContinuation({
  testId,
  shown,
  total,
  pageSize,
  more,
  started,
  previewCursor,
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
  onStart: () => void
  onAccessLost: () => void
}) {
  useEffect(() => {
    if (more.accessLost) onAccessLost()
  }, [more.accessLost, onAccessLost])

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
        aria-disabled={more.isFetching || undefined}
        onClick={() => {
          if (more.isFetching) return
          if (started) void more.fetchNextPage()
          else onStart()
        }}
      >
        {failed ? <Trans>Спробувати ще раз</Trans> : <Trans>Показати ще ({next})</Trans>}
      </Button>
    </div>
  )
}
