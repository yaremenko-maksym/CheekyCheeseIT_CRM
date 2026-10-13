/**
 * /documents — PHASE 6 documents module entry.
 *
 * Layout (matches the look/feel of /users and /projects):
 *
 *   ┌───────────────────────────────────────────────────────────────────┐
 *   │  Header  (title + Загрузить button)                               │
 *   │  Tri-state SegmentedToggle (Все / Активные / Архив, ADMIN-only)   │
 *   │  Card toolbar: Search │ Owner │ Category │ ─── │ Sort │ View      │
 *   ├───────────────────────────────────────────────────────────────────┤
 *   │  <DocumentList /> for the active category filter (grid of cards)  │
 *   └───────────────────────────────────────────────────────────────────┘
 *
 * Per user choice (Variant A) — category is a Select dropdown in the toolbar,
 * not a Tabs strip. Default = "Все категории" (no filter); user narrows down
 * via the dropdown. AVATAR/LOGO options are admin-only and live alongside
 * the regular categories (no separate "show internal" toggle needed since the
 * dropdown is compact).
 *
 * Visibility per role is computed once via TAB_VISIBILITY and the role-side
 * filter from the spec — when the viewer's role has zero accessible categories
 * we show a single "no access" panel instead of an empty filter row.
 *
 * Deep-link: `?openDocId=<uuid>` opens the DocumentDetailDialog for that
 * document automatically once the list query resolves. Used by external
 * links (Finance → receipts, audit log → archived doc, etc.).
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { StickyPageHeader } from '@/components/crm/StickyPageHeader'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { Archive, Shield } from 'lucide-react'
import { z } from 'zod'
import { Trans, useLingui } from '@lingui/react/macro'
import type { Document, DocumentCategory, SessionUser, UserProfileDto } from '@crm/shared'
import { useAuth } from '@/context/auth'
import { api } from '@/lib/axios'
import { SegmentedToggle, type SegmentedToggleOption } from '@/components/ui/segmented-toggle'
import { useRoleGuard } from '@/hooks/use-role-guard'
import { DocumentDetailDialog } from '@/components/documents/document-detail-dialog'
import { InvoiceDetailDialog } from '@/components/invoices/invoice-detail-dialog'
import { DEFAULT_SORT, type SortKey } from '@/lib/documents-filter-sort'
import {
  STATUS_TAB_LABEL_MESSAGES,
  TAB_VISIBILITY,
  canSeeOwnerFilter,
  getStoredView,
  initialCategoryForRole,
  setStoredView,
} from './documents/constants'
import { useDebounce } from './documents/hooks/useDebounce'
import type { CategoryFilter, DocumentView, StatusTab } from './documents/types'
import { DocumentsHeader } from './documents/components/DocumentsHeader'
import { DocumentsListSection } from './documents/components/DocumentsListSection'
import { DocumentsToolbar } from './documents/components/DocumentsToolbar'

const searchSchema = z.object({
  openDocId: z.string().uuid().optional(),
  category: z
    .enum(['RESUME', 'SCAN', 'CONTRACT', 'RECEIPT', 'AVATAR', 'LOGO', 'INVOICE'])
    .optional(),
  openTx: z.string().uuid().optional(),
  view: z.enum(['list', 'grid']).optional(),
})

export const Route = createFileRoute('/_authenticated/documents')({
  validateSearch: searchSchema,
  component: DocumentsPage,
})

function DocumentsPage() {
  // Drop role - phase 3 (UT finding 1): DROP now has a /documents page.
  // They see only their own docs (IDOR-scoped at service layer).
  // Sidebar link, route-access, and backend service all updated together.
  useRoleGuard(['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT', 'DROP'])
  const { user } = useAuth()
  if (!user) return null

  return <DocumentsPageContent viewer={user} />
}

function DocumentsPageContent({ viewer }: { viewer: SessionUser }) {
  const { t, i18n } = useLingui()
  const isAdmin = viewer.role === 'ADMIN'
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  // View mode — list (compact rows, default) or grid (cards).
  // URL param `?view=` takes precedence on first load; falls back to
  // localStorage so the preference persists between navigation.
  const [view, setView] = useState<DocumentView>(() => {
    return (search.view as DocumentView | undefined) ?? getStoredView()
  })

  function handleViewChange(next: DocumentView) {
    setView(next)
    setStoredView(next)
    void navigate({
      search: (prev) => ({ ...prev, view: next }),
      replace: true,
    })
  }

  // ADMIN-only switches. The "showDeleted" flag is now derived from the
  // status tab (ARCHIVED ⇒ true) rather than a separate checkbox so the
  // shape matches /users.
  const [statusTab, setStatusTab] = useState<StatusTab>('ACTIVE')
  const [ownerFilter, setOwnerFilter] = useState<string>('ALL')
  // Category filter: 'ALL' = no category filter (show all accessible to role).
  // ACCOUNTANT defaults to 'RECEIPT' (primary workflow: receipt validation).
  // All other roles default to 'ALL'. An explicit `?category=` deep-link
  // (e.g. from a notification → `/documents?category=INVOICE&openTx=…`)
  // always wins over the role-based default.
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>(() =>
    initialCategoryForRole(viewer.role, search.category),
  )

  // AC1 — search input state + debounce 250ms
  const [searchInput, setSearchInput] = useState('')
  const debouncedSearch = useDebounce(searchInput, 250)
  const handleClearSearch = useCallback(() => setSearchInput(''), [])

  // AC2 — sort state (persists across grid/list toggle)
  const [sortKey, setSortKey] = useState<SortKey>(DEFAULT_SORT)

  // Users for the owner filter — ADMIN/HR only.
  const showOwnerFilter = canSeeOwnerFilter(viewer.role)
  const { data: users } = useQuery<UserProfileDto[]>({
    queryKey: ['users', { archived: false }],
    queryFn: async () => {
      const res = await api.get<UserProfileDto[]>('/users')
      return res.data
    },
    enabled: showOwnerFilter,
    staleTime: 5 * 60 * 1000,
  })

  // Categories this viewer is allowed to see in the dropdown.
  // ADMIN additionally gets AVATAR/LOGO (internal categories, kept compact
  // in the dropdown so no separate toggle is needed).
  const availableCategories = useMemo<DocumentCategory[]>(() => {
    const base = TAB_VISIBILITY[viewer.role] ?? []
    if (isAdmin) return [...base, 'AVATAR', 'LOGO']
    return base
  }, [viewer.role, isAdmin])

  // If RBAC changes (role swap is impossible at runtime but defensive) and
  // the selected category is no longer available, reset to 'ALL'.
  useEffect(() => {
    if (categoryFilter !== 'ALL' && !availableCategories.includes(categoryFilter)) {
      setCategoryFilter('ALL')
    }
  }, [availableCategories, categoryFilter])

  // includeDeleted: only ADMIN can ask for deleted docs; non-ADMINs never
  // get the ARCHIVED tab so the flag is unconditionally `false` for them.
  const includeDeleted = isAdmin && statusTab === 'ARCHIVED'

  // Detail dialog wiring. The deep-link `?openDocId=…` opens the dialog
  // as soon as the matching doc shows up in the list query.
  const [detailDoc, setDetailDoc] = useState<Document | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)

  // Invoice dialog: INVOICE documents open InvoiceDetailDialog (signatures
  // table + sign button) instead of the generic DocumentDetailDialog. The
  // dialog is keyed by transaction id which lives on the Document DTO as
  // `invoiceTransactionId` (see API LEFT JOIN with transactions). The
  // `?openTx=<uuid>` URL deep-link (from notifications) bypasses the doc
  // entirely — straight to the dialog by tx id.
  const [invoiceTxId, setInvoiceTxId] = useState<string | undefined>(undefined)
  const [invoiceOpen, setInvoiceOpen] = useState(false)

  function openDetail(doc: Document) {
    if (doc.category === 'INVOICE' && doc.invoiceTransactionId) {
      openInvoice(doc.invoiceTransactionId)
      return
    }
    setDetailDoc(doc)
    setDetailOpen(true)
    // Mirror the open into the URL so users can copy the link.
    // Skip for virtual documents whose id is not a valid UUID4
    // (e.g. employee_contract: "contract-<userId>") — validateSearch
    // z.string().uuid() would throw a ZodError causing a route error boundary.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    if (UUID_RE.test(doc.id)) {
      void navigate({
        search: (prev) => ({ ...prev, openDocId: doc.id }),
        replace: true,
      })
    }
  }

  function openInvoice(txId: string) {
    setInvoiceTxId(txId)
    setInvoiceOpen(true)
    void navigate({
      search: (prev) => ({ ...prev, openTx: txId }),
      replace: true,
    })
  }

  function closeInvoice(open: boolean) {
    setInvoiceOpen(open)
    if (!open) {
      void navigate({
        search: (prev) => {
          const next = { ...prev }
          delete (next as Record<string, unknown>)['openTx']
          return next
        },
        replace: true,
      })
    }
  }

  function closeDetail(open: boolean) {
    setDetailOpen(open)
    if (!open) {
      void navigate({
        search: (prev) => {
          const next = { ...prev }
          delete (next as Record<string, unknown>)['openDocId']
          return next
        },
        replace: true,
      })
    }
  }

  // Auto-open invoice dialog when `?openTx=<uuid>` deep-link arrives.
  useEffect(() => {
    if (search.openTx) {
      setInvoiceTxId(search.openTx)
      setInvoiceOpen(true)
    }
  }, [search.openTx])

  // Empty-access state — no categories at all.
  if (availableCategories.length === 0) {
    return (
      <div className="flex flex-col h-full" data-testid="documents-page">
        <div className="flex-1 min-h-0 overflow-y-auto px-6 pt-4 pb-6">
          <div
            data-testid="documents-no-access"
            className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-24 text-center"
          >
            <Shield className="h-10 w-10 text-muted-foreground/30" />
            {/* COPY-M-docs-13: the old text ("you don't have access") was a
                dead end — no addressee, no next step. Names who to ask. */}
            <p className="mt-4 text-sm font-medium">
              <Trans>Документи вам не відкриті. Потрібен доступ — напишіть адміну</Trans>
            </p>
          </div>
        </div>
      </div>
    )
  }

  // Status-tab options — only rendered for ADMIN (see JSX guard below).
  // Non-admin roles see only their active documents; the entire toggle is
  // hidden so the layout stays clean and there is no disabled-pill confusion.
  const statusOptions: ReadonlyArray<SegmentedToggleOption<StatusTab>> = [
    { value: 'ALL', label: i18n._(STATUS_TAB_LABEL_MESSAGES.ALL) },
    { value: 'ACTIVE', label: i18n._(STATUS_TAB_LABEL_MESSAGES.ACTIVE) },
    { value: 'ARCHIVED', label: i18n._(STATUS_TAB_LABEL_MESSAGES.ARCHIVED), icon: Archive },
  ]

  return (
    <div className="flex flex-col h-full" data-testid="documents-page">
      <StickyPageHeader>
        <DocumentsHeader viewer={viewer} categoryFilter={categoryFilter} users={users} />

        {/* Tri-state status filter — ADMIN-only (UT finding 2026-06-14).
            Non-admin roles only ever see active docs; toggle hidden for them. */}
        {isAdmin && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.28, delay: 0.05 }}
            className="flex items-center"
          >
            <SegmentedToggle<StatusTab>
              value={statusTab}
              onChange={setStatusTab}
              options={statusOptions}
              ariaLabel={t`Фільтр документів`}
              variant="tabs"
              size="sm"
              layoutId="documents-status-tabs"
              className="w-fit"
              testId="documents-status-tabs"
            />
          </motion.div>
        )}

        {/* Unified toolbar — canonical Card pattern matching /projects */}
        <DocumentsToolbar
          searchInput={searchInput}
          onSearchInputChange={setSearchInput}
          onClearSearch={handleClearSearch}
          showOwnerFilter={showOwnerFilter}
          ownerFilter={ownerFilter}
          onOwnerFilterChange={setOwnerFilter}
          users={users}
          categoryFilter={categoryFilter}
          onCategoryFilterChange={setCategoryFilter}
          availableCategories={availableCategories}
          sortKey={sortKey}
          onSortKeyChange={setSortKey}
          view={view}
          onViewChange={handleViewChange}
        />
      </StickyPageHeader>

      <div
        className="flex-1 min-h-0 overflow-y-auto px-6 pt-4 pb-6"
        style={{ scrollbarGutter: 'stable' }}
      >
        <div className="space-y-6">
          <DocumentsListSection
            viewer={viewer}
            categoryFilter={categoryFilter}
            ownerId={ownerFilter === 'ALL' ? undefined : ownerFilter}
            includeDeleted={includeDeleted}
            statusTab={statusTab}
            onOpen={openDetail}
            openDocId={search.openDocId}
            view={view}
            searchQuery={debouncedSearch}
            sortKey={sortKey}
          />

          <DocumentDetailDialog
            open={detailOpen}
            onOpenChange={closeDetail}
            doc={detailDoc}
            viewer={viewer}
          />
          {/* InvoiceDetailDialog — opens for INVOICE documents (signature table +
          «Подписать» button) and via the `?openTx=<uuid>` deep-link from
          notifications. Replaces the standalone /finance/invoices page. */}
          <InvoiceDetailDialog
            open={invoiceOpen}
            onOpenChange={closeInvoice}
            transactionId={invoiceTxId}
            viewer={viewer}
          />
          {/* uploadedByDisplayName comes embedded in each doc DTO (API LEFT JOIN),
          so no /api/users round-trip is needed here. */}
        </div>
      </div>
    </div>
  )
}
