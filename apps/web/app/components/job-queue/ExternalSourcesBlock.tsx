import { ChevronRight, ExternalLink, Plus } from 'lucide-react'
import { Trans } from '@lingui/react/macro'
import { EXTERNAL_FEEDS, type TechnicalRole } from '@crm/shared'
import { Button } from '@/components/ui/button'

/**
 * Job sites the collector cannot read, as deep links with the filters preset (spec G1). With a
 * senior selected in the queue filter the links search that senior's first role; without one they
 * carry only the general senior / remote / newest filters. Nothing is fetched: HR opens the site in
 * a new tab and records what they find through the external-submission dialog.
 */
export function ExternalSourcesBlock({
  roles,
  seniorName,
  onRegister,
}: {
  roles: readonly TechnicalRole[]
  /** The first selected senior; absent = general filters. */
  seniorName?: string | undefined
  onRegister: () => void
}) {
  const filters = { roles }

  let state: 'general' | 'no-roles' | 'role'
  let summary
  if (seniorName === undefined) {
    state = 'general'
    summary = <Trans>Загальні фільтри: senior, віддалено, нові</Trans>
  } else if (roles.length === 0) {
    state = 'no-roles'
    summary = <Trans>У {seniorName} не вказано ролей, тому фільтри загальні</Trans>
  } else {
    state = 'role'
    summary = <Trans>Фільтри за роллю: {seniorName}</Trans>
  }

  return (
    <details data-testid="external-sources" className="group rounded-lg border border-border/60">
      <summary
        data-testid="external-sources-title"
        className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm [&::-webkit-details-marker]:hidden"
      >
        <ChevronRight
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
        />
        <span className="flex min-w-0 flex-col">
          <span className="font-medium text-foreground">
            <Trans>Зовнішні джерела</Trans>
          </span>
          <span
            data-testid="external-sources-filters"
            data-filters={state}
            className="text-xs text-muted-foreground"
          >
            {summary}
          </span>
        </span>
      </summary>
      <div className="flex flex-col gap-3 px-3 pb-3">
        <p className="text-xs text-muted-foreground">
          <Trans>
            Ці сайти не підключаються до збору. Відкрийте пошук у новій вкладці, а знайдену вакансію
            запишіть як зовнішню подачу.
          </Trans>
        </p>
        <ul data-testid="external-sources-links" className="flex flex-wrap gap-2">
          {EXTERNAL_FEEDS.map((feed) => (
            <li key={feed.id}>
              <Button asChild variant="outline" className="min-h-11">
                <a href={feed.buildUrl(filters)} target="_blank" rel="noopener noreferrer">
                  {feed.label}
                  <ExternalLink aria-hidden="true" />
                </a>
              </Button>
            </li>
          ))}
        </ul>
        <Button
          type="button"
          variant="outline"
          data-testid="external-sources-register"
          className="min-h-11 w-full @min-[560px]:w-auto @min-[560px]:self-start"
          onClick={onRegister}
        >
          <Plus aria-hidden="true" />
          <Trans>Записати зовнішню подачу</Trans>
        </Button>
      </div>
    </details>
  )
}
