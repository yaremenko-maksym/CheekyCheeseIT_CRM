import { useEffect, useMemo, useRef } from 'react'
import { Link } from '@tanstack/react-router'
import { FileSignature, FileText, Receipt as ReceiptIcon } from 'lucide-react'
import { Trans, useLingui } from '@lingui/react/macro'
import { DEFAULT_LOCALE } from '@crm/shared'
import type { Document, SessionUser } from '@crm/shared'
import { useDocuments } from '@/hooks/use-documents'
import { DocumentList } from '@/components/documents/document-list'
import { DocumentRow } from '@/components/documents/document-row'
import { filterDocuments, sortDocuments, type SortKey } from '@/lib/documents-filter-sort'
import type { CategoryFilter, DocumentView, StatusTab } from '../types'
import { DocumentsCounterText } from './DocumentsCounterText'
import { DocumentsGenericEmpty } from './DocumentsEmptyStates'

interface ListSectionProps {
  viewer: SessionUser
  categoryFilter: CategoryFilter
  ownerId?: string | undefined
  includeDeleted: boolean
  /** Tri-state filter — feeds the empty-state copy + counter chip. */
  statusTab: StatusTab
  onOpen: (doc: Document) => void
  openDocId?: string | undefined
  view: DocumentView
  /** AC1 — debounced search query (client-side, over already loaded list) */
  searchQuery: string
  /** AC2 — sort key (client-side) */
  sortKey: SortKey
}

export function DocumentsListSection({
  viewer,
  categoryFilter,
  ownerId,
  includeDeleted,
  statusTab,
  onOpen,
  openDocId,
  view,
  searchQuery,
  sortKey,
}: ListSectionProps) {
  const { i18n } = useLingui()
  // Only forward `category` to the API when a specific one is picked.
  // 'ALL' ⇒ backend returns everything the role can see.
  const { data, isLoading } = useDocuments({
    ...(categoryFilter !== 'ALL' ? { category: categoryFilter } : {}),
    ownerId,
    includeDeleted,
  })

  // Tri-state local filter: includeDeleted=true returns BOTH deleted + active
  // (the backend treats includeDeleted as "no soft-delete filter"). For
  // 'ARCHIVED' we want only archived rows; for 'ACTIVE' the backend already
  // excludes them; for 'ALL' we leave everything in.
  // AC1+AC2: then apply search filter and sort client-side.
  const filtered = useMemo<Document[]>(() => {
    if (!data) return []
    let result = statusTab === 'ARCHIVED' ? data.filter((d) => d.deletedAt !== null) : data
    result = filterDocuments(result, searchQuery, i18n)
    // TODO(i18n stage 2, Task 6): useLocale() — Task 6 (users.locale +
    // request-locale plumbing) hasn't landed yet, so there is no active
    // locale to read here. `DEFAULT_LOCALE` keeps today's behavior
    // (Cyrillic collation) until that hook exists.
    result = sortDocuments(result, sortKey, DEFAULT_LOCALE, i18n)
    return result
    // `i18n.locale`: the singleton keeps its identity across a locale switch, but
    // a virtual contract's visible name (searched/sorted here) depends on it.
  }, [data, statusTab, searchQuery, sortKey, i18n, i18n.locale])

  // Deep-link: pop the dialog open once the matching doc appears. We only
  // run this when the URL param or the resolved list changes — `onOpen` is
  // an inline callback from the parent and would otherwise re-trigger on
  // every render. The callback is intentionally read via a ref-stable
  // reference inside the effect to avoid stale closures.
  const onOpenRef = useRef(onOpen)
  onOpenRef.current = onOpen
  useEffect(() => {
    if (!openDocId || !data) return
    const target = data.find((d) => d.id === openDocId)
    if (target) onOpenRef.current(target)
  }, [openDocId, data])

  // For the Receipts-only filter on an empty state, show a deep link into
  // Finance rather than the generic "no documents" placeholder.
  const receiptEmpty = (
    <div
      data-testid="documents-empty-receipts"
      className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-24 text-center"
    >
      <ReceiptIcon className="h-10 w-10 text-muted-foreground/30" />
      <p className="mt-4 text-sm font-medium">
        <Trans>Ще немає чеків</Trans>
      </p>
      <p className="mt-1 max-w-md text-xs text-muted-foreground">
        <Trans>Чеки додаються в розділі «Фінанси» під час створення транзакції.</Trans>
      </p>
      <Link
        to="/finance"
        className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
      >
        <Trans>Перейти до Фінансів</Trans>
      </Link>
    </div>
  )

  // Invoices empty state: system-generated, no upload from this page. They
  // surface here once the underlying transaction transitions to PAID.
  const invoiceEmpty = (
    <div
      data-testid="documents-empty-invoices"
      className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-24 text-center"
    >
      <FileSignature className="h-10 w-10 text-muted-foreground/30" />
      {/* COPY-H-docs-5: «Рахунок», not «Інвойс» — glossary term for `invoices`. */}
      <p className="mt-4 text-sm font-medium">
        <Trans>Ще немає рахунків</Trans>
      </p>
      <p className="mt-1 max-w-md text-xs text-muted-foreground">
        <Trans>
          Рахунки створюються автоматично після оплати транзакцій. Натисніть на картку рахунку, щоб
          відкрити PDF, побачити підписи і підписати документ.
        </Trans>
      </p>
      <Link
        to="/finance"
        className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
      >
        <Trans>Перейти до Фінансів</Trans>
      </Link>
    </div>
  )

  // For AVATAR / LOGO filters (ADMIN audit view) — neutral empty state.
  // K-docs template: two FULL, independent `<Trans>` branches per category —
  // NOT a shared sentence with a case-inflected noun spliced in
  // («Немає аватарів»/«Немає логотипів» need genitive plural, which does not
  // come for free from `CATEGORY_LABEL_MESSAGES`'s nominative singular).
  const internalEmpty = (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-24 text-center">
      <FileText className="h-10 w-10 text-muted-foreground/30" />
      <p className="mt-4 text-sm font-medium">
        {categoryFilter === 'AVATAR' ? (
          <Trans>Немає аватарів</Trans>
        ) : (
          <Trans>Немає логотипів</Trans>
        )}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {categoryFilter === 'AVATAR' ? (
          <Trans>Керування — з профілів користувачів.</Trans>
        ) : (
          <Trans>Керування — з налаштувань проєктів.</Trans>
        )}
      </p>
    </div>
  )

  // Active search / owner filter with zero matches → "nothing found" for ANY
  // category (the per-category empties above say "none exist yet", which is
  // false while a query is narrowing the list).
  const hasActiveQuery = searchQuery.trim() !== '' || ownerId !== undefined

  const emptyState = hasActiveQuery ? (
    <DocumentsGenericEmpty searching />
  ) : categoryFilter === 'RECEIPT' ? (
    receiptEmpty
  ) : categoryFilter === 'INVOICE' ? (
    invoiceEmpty
  ) : categoryFilter === 'AVATAR' || categoryFilter === 'LOGO' ? (
    internalEmpty
  ) : (
    <DocumentsGenericEmpty searching={false} />
  )

  return (
    <div className="space-y-3">
      <div
        className="text-xs text-muted-foreground"
        data-testid={`documents-counter-${categoryFilter}`}
      >
        {isLoading ? (
          '…'
        ) : (
          <DocumentsCounterText
            count={filtered.length}
            statusTab={statusTab}
            categoryFilter={categoryFilter}
          />
        )}
      </div>

      {view === 'grid' ? (
        <DocumentList
          documents={filtered}
          loading={isLoading}
          viewer={viewer}
          emptyState={emptyState}
          onOpen={onOpen}
          view="grid"
        />
      ) : // List view — compact rows
      isLoading ? (
        // PR-1 MED fix: pass view='list' so the skeleton renders row-shaped
        // placeholders instead of card-shaped grid skeletons.
        <DocumentList
          documents={[]}
          loading
          viewer={viewer}
          emptyState={emptyState}
          onOpen={onOpen}
          view="list"
        />
      ) : filtered.length === 0 ? (
        <>{emptyState}</>
      ) : (
        <div className="flex flex-col gap-1" data-testid="documents-list-view">
          {filtered.map((doc) => (
            <DocumentRow key={doc.id} doc={doc} viewer={viewer} onOpen={onOpen} />
          ))}
        </div>
      )}
    </div>
  )
}
