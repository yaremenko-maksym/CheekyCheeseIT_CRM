import { FileText } from 'lucide-react'
import { Trans } from '@lingui/react/macro'

/**
 * `searching` = a search query or owner filter is narrowing the list: say
 * "nothing found" instead of "no documents yet" (which would be false).
 * Exported for a direct unit-test render of both states.
 */
export function DocumentsGenericEmpty({ searching }: { searching: boolean }) {
  return (
    <div
      data-testid={searching ? 'documents-empty-no-results' : 'documents-empty-generic'}
      className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-24 text-center"
    >
      <FileText className="h-10 w-10 text-muted-foreground/30" />
      <p className="mt-4 text-sm font-medium">
        {searching ? <Trans>Нічого не знайдено</Trans> : <Trans>Ще немає документів</Trans>}
      </p>
    </div>
  )
}
