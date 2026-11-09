import { useState } from 'react'
import { Trans } from '@lingui/react/macro'
import { ExternalLink } from 'lucide-react'
import type { JobQueueCardResponseDto } from '@crm/shared'
import { isSafeExternalUrl, openOriginalPosting } from '@/components/job-sourcing/open-original'
import { useJobQueueSources, type QueueScopeSignature } from '@/hooks/use-job-queue'
import { sourceLabel } from './JobQueueRow'
import { PreviewContinuation } from './PreviewContinuation'

const SOURCES_PAGE = 20

/**
 * «Також опубліковано на:» (spec §5.1 item 5): every other source the vacancy was seen on. The
 * server's list includes the primary source; it is the «Відкрити оригінал» target, so it is left out
 * here and out of the denominator. Rows open through `openOriginalPosting`, never `window.open`.
 */
export function AlsoSeenOn({
  scope,
  card,
}: {
  scope: QueueScopeSignature
  card: JobQueueCardResponseDto
}) {
  const [expanded, setExpanded] = useState(false)
  // the continuation fetches as soon as it has a cursor, so it gets one only after the first click
  const more = useJobQueueSources(
    scope,
    card.opportunityId,
    expanded ? card.sources.nextCursor : null,
  )
  const primaryId = card.primarySource?.sourceRecordId
  const rows = [
    ...card.sources.items,
    ...(more.data?.pages.flatMap((page) => page.items) ?? []),
  ].filter((row) => row.sourceRecordId !== primaryId)
  const total = Math.max(card.sources.totalCount - (card.primarySource ? 1 : 0), 0)

  if (rows.length === 0) return null

  return (
    <section data-testid="job-queue-also-seen" className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">
        <Trans>Також опубліковано на:</Trans>
      </h3>
      <ul className="flex flex-wrap gap-2">
        {rows.map((row) => {
          const name = sourceLabel(row.sourceType)
          const testId = `job-queue-source-${row.sourceRecordId}`
          return (
            <li key={row.sourceRecordId} className="min-w-0 max-w-full">
              {isSafeExternalUrl(row.url) ? (
                <button
                  type="button"
                  data-testid={testId}
                  // synchronous in the click: a popup blocker allows only a user-gesture open
                  onClick={() => openOriginalPosting(row.url)}
                  className="inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-md border px-3 text-sm underline-offset-4 transition-colors hover:bg-muted/50 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-9"
                >
                  <span className="truncate">{name}</span>
                  <ExternalLink aria-hidden="true" className="size-3.5 shrink-0" />
                </button>
              ) : (
                <span
                  data-testid={testId}
                  className="inline-flex min-h-11 max-w-full items-center rounded-md border border-dashed px-3 text-sm text-muted-foreground sm:min-h-9"
                >
                  <span className="truncate">{name}</span>
                </span>
              )}
            </li>
          )
        })}
      </ul>
      <PreviewContinuation
        testId="job-queue-also-seen"
        shown={rows.length}
        total={total}
        pageSize={SOURCES_PAGE}
        pending={more.isFetching}
        onMore={() => {
          if (!expanded) setExpanded(true)
          else if (more.data) void more.fetchNextPage()
          else void more.refetch()
        }}
      />
    </section>
  )
}
