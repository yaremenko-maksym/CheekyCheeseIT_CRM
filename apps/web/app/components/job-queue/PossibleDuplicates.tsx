import { Trans } from '@lingui/react/macro'
import { Copy } from 'lucide-react'
import type { JobQueueCardResponseDto } from '@crm/shared'

/**
 * «У черзі є схожа вакансія» (spec §5.8): a bounded preview of the similar vacancies in the actor's
 * own view. The «Уже подано» line names the seniors the actor's own scope submitted
 * there; the server scopes `submittedSeniorNames`, so another team's submission never reaches it (§3).
 */
export function PossibleDuplicates({
  preview,
}: {
  preview: JobQueueCardResponseDto['possibleDuplicates']
}) {
  if (!preview || preview.items.length === 0) return null
  const shown = preview.items.length
  const total = preview.totalCount

  return (
    <div
      data-testid="job-queue-duplicates"
      role="note"
      className="flex items-start gap-2 rounded-lg border bg-card p-3 text-sm"
    >
      <Copy aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <div className="flex min-w-0 flex-col gap-1">
        <p className="font-medium">
          <Trans>У черзі є схожа вакансія</Trans>
        </p>
        <ul className="flex flex-col gap-0.5">
          {preview.items.map((item) => {
            const seniors = item.submittedSeniorNames.join(', ')
            return (
              <li key={item.opportunityId} className="[overflow-wrap:anywhere]">
                {item.title}
                {item.companyName && ` · ${item.companyName}`}
                {seniors && (
                  <p data-testid="job-queue-duplicate-submitted" className="text-muted-foreground">
                    <Trans>Уже подано: {seniors}</Trans>
                  </p>
                )}
              </li>
            )
          })}
        </ul>
        {total > shown && (
          <p
            data-testid="job-queue-duplicates-shown"
            className="text-muted-foreground tabular-nums"
          >
            <Trans>
              Показано {shown} із {total}
            </Trans>
          </p>
        )}
      </div>
    </div>
  )
}
