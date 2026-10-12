import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { CATEGORY_LABEL_MESSAGES_LOWER } from '@/components/documents/document-labels'
import type { CategoryFilter, StatusTab } from '../types'

/**
 * task-i18n-stage3e-pr1 (J-docs template). Replaces the hardcoded ru-RU
 * `pluralizeDocuments(n)` helper (mod10/mod100 arithmetic, Russian-only
 * forms) with `<Plural>` — the macro `plural()` function is banned at
 * module level for Stryker compatibility (Global Constraints, lesson
 * #700: `#` is not substituted under mutation instrumentation), so this is
 * a small standalone component instead of a plain string helper. Exported
 * for a direct unit-test render (ICU plural rule pins at n=1/2/5/11/21 —
 * AC3), independent of the full `/documents` page (auth/router/react-query
 * wiring `DocumentsPageContent` needs).
 */
export function DocumentsCounterText({
  count,
  statusTab,
  categoryFilter,
}: {
  count: number
  statusTab: StatusTab
  categoryFilter: CategoryFilter
}) {
  const { i18n } = useLingui()
  return (
    <>
      <Plural
        value={count}
        one="# документ"
        few="# документи"
        many="# документів"
        other="# документа"
      />
      {statusTab === 'ARCHIVED' ? (
        <>
          {' · '}
          <Trans>в архіві</Trans>
        </>
      ) : statusTab === 'ALL' ? (
        <>
          {' · '}
          <Trans>усі</Trans>
        </>
      ) : null}
      {categoryFilter !== 'ALL' ? (
        <>
          {' · '}
          {i18n._(CATEGORY_LABEL_MESSAGES_LOWER[categoryFilter])}
        </>
      ) : null}
    </>
  )
}
