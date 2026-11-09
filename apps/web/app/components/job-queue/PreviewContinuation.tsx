import { Trans } from '@lingui/react/macro'
import { Button } from '@/components/ui/button'

/**
 * «Показано 3 із 34 · Показати ще (20)» under a card preview (spec §5.1 item 5). Renders nothing once
 * everything is shown. `pending` keeps the button mounted but inert, so focus is not lost mid-fetch.
 */
export function PreviewContinuation({
  shown,
  total,
  pageSize,
  pending,
  onMore,
  testId,
}: {
  shown: number
  total: number
  pageSize: number
  pending: boolean
  onMore: () => void
  testId: string
}) {
  if (total <= shown) return null
  const next = Math.min(pageSize, total - shown)
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
      <span data-testid={`${testId}-shown`} className="tabular-nums">
        <Trans>
          Показано {shown} із {total}
        </Trans>
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="min-h-11 sm:min-h-9"
        aria-disabled={pending || undefined}
        onClick={() => {
          if (!pending) onMore()
        }}
      >
        <Trans>Показати ще ({next})</Trans>
      </Button>
    </div>
  )
}
