/**
 * /crm/documents — PHASE 6 documents module entry.
 *
 * Layout (matches the look/feel of /crm/users and /crm/projects):
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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { StickyPageHeader } from '@/components/crm/StickyPageHeader'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import {
  Archive,
  FileSignature,
  FileText,
  LayoutGrid,
  List,
  Plus,
  Receipt as ReceiptIcon,
  Search,
  Shield,
  X,
} from 'lucide-react'
import { z } from 'zod'
import type {
  Document,
  DocumentCategory,
  ProjectDto,
  SessionUser,
  UserProfileDto,
} from '@crm/shared'
import { useAuth } from '@/context/auth'
import { api } from '@/lib/axios'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SegmentedToggle, type SegmentedToggleOption } from '@/components/ui/segmented-toggle'
import { useDocuments } from '@/hooks/use-documents'
import { useRoleGuard } from '@/hooks/use-role-guard'
import { DocumentList } from '@/components/documents/document-list'
import { DocumentRow } from '@/components/documents/document-row'
import { DocumentDetailDialog } from '@/components/documents/document-detail-dialog'
import { UploadDocumentDialog } from '@/components/documents/upload-document-dialog'
import { InvoiceDetailDialog } from '@/components/invoices/invoice-detail-dialog'
import {
  filterDocuments,
  sortDocuments,
  SORT_OPTIONS,
  DEFAULT_SORT,
  type SortKey,
} from '@/lib/documents-filter-sort'

type Role = SessionUser['role']
type StatusTab = 'ALL' | 'ACTIVE' | 'ARCHIVED'
type CategoryFilter = DocumentCategory | 'ALL'

// ---------------------------------------------------------------------------
// useDebounce — generic debounce hook (~250ms for search field AC1)
// ---------------------------------------------------------------------------

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState<T>(value)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(id)
  }, [value, delay])
  return debounced
}

// Deep-link params:
//   - `openDocId` — open DocumentDetailDialog for the matching document
//     id once the list query resolves (used by audit/restore links).
//   - `openTx` — INVOICE-only: open InvoiceDetailDialog for that
//     transaction id (used by notifications «инвойс подписан» / «ожидает
//     подписи»). Also auto-narrows the category filter to INVOICE so the
//     surrounding list reflects the deep-link target.
const VIEW_STORAGE_KEY = 'crm.documents.view'

type DocumentView = 'list' | 'grid'

function getStoredView(): DocumentView {
  try {
    const v = typeof window !== 'undefined' ? localStorage.getItem(VIEW_STORAGE_KEY) : null
    return v === 'grid' ? 'grid' : 'list'
  } catch {
    return 'list'
  }
}

function setStoredView(v: DocumentView): void {
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, v)
  } catch {
    // ignore — storage may be blocked
  }
}

const searchSchema = z.object({
  openDocId: z.string().uuid().optional(),
  category: z
    .enum(['RESUME', 'SCAN', 'CONTRACT', 'RECEIPT', 'AVATAR', 'LOGO', 'INVOICE'])
    .optional(),
  openTx: z.string().uuid().optional(),
  view: z.enum(['list', 'grid']).optional(),
})

export const Route = createFileRoute('/crm/documents')({
  validateSearch: searchSchema,
  component: DocumentsPage,
})

// ---------------------------------------------------------------------------
// Visibility config
// ---------------------------------------------------------------------------

const CATEGORY_LABELS_RU: Record<DocumentCategory, string> = {
  RESUME: 'Резюме',
  SCAN: 'Сканы документов',
  CONTRACT: 'Договоры',
  RECEIPT: 'Чеки',
  AVATAR: 'Аватары',
  LOGO: 'Логотипы',
  // INVOICE документы создаются системой и не отображаются в обычном табе
  // /crm/documents (INTERNAL_CATEGORIES). Лейбл для случая ADMIN-toggle.
  INVOICE: 'Инвойсы',
}

/**
 * RBAC visibility per spec table «Видимость табов по ролям».
 * Maps Role → set of categories that role may see in the dropdown.
 * INVOICE is exposed to all roles except HR — the backend scopes the list
 * to "own invoices" for non-ADMIN/ACCOUNTANT (where ownerId == viewer.id),
 * and HR is never an invoice owner, so the tab would always be empty for HR.
 */
const TAB_VISIBILITY: Record<Role, DocumentCategory[]> = {
  ADMIN: ['RESUME', 'SCAN', 'CONTRACT', 'RECEIPT', 'INVOICE'],
  SENIOR: ['RESUME', 'SCAN', 'CONTRACT', 'RECEIPT', 'INVOICE'],
  JUNIOR: ['RESUME', 'SCAN', 'CONTRACT', 'INVOICE'],
  HR: ['RESUME', 'SCAN', 'CONTRACT'],
  ACCOUNTANT: ['SCAN', 'RECEIPT', 'INVOICE'],
  // Drop role - phase 1 (backend): documents UX for DROP ships in a later
  // phase. Mirror the SENIOR set so the page renders without runtime crash.
  DROP: ['RESUME', 'SCAN', 'CONTRACT', 'RECEIPT', 'INVOICE'],
}

/**
 * Which categories does this role actually upload through /crm/documents?
 * (RECEIPT is uploaded from the Finance dialogs; ACCOUNTANT does not upload
 * at all from this page.)
 */
const UPLOADABLE_PER_ROLE: Record<Role, DocumentCategory[]> = {
  ADMIN: ['RESUME', 'SCAN', 'CONTRACT'],
  SENIOR: ['RESUME', 'SCAN', 'CONTRACT'],
  JUNIOR: ['RESUME', 'SCAN'],
  HR: ['RESUME', 'SCAN'],
  ACCOUNTANT: [],
  // Drop role - phase 1 (backend): drop document UX ships in a later phase.
  DROP: ['RESUME', 'SCAN', 'CONTRACT'],
}

function canSeeOwnerFilter(role: Role): boolean {
  return role === 'ADMIN' || role === 'HR'
}

/**
 * Returns the initial category filter for the documents page.
 *
 * Priority:
 *   1. Explicit deep-link `?category=<X>` — always wins.
 *   2. Role-based default: ACCOUNTANT → 'RECEIPT' (primary workflow: validating
 *      receipts as proof of income). All other roles → 'ALL'.
 *
 * Note: 'RECEIPT' is in TAB_VISIBILITY['ACCOUNTANT'], so the downstream
 * reset-to-ALL effect (which fires when the selected category is not in
 * availableCategories) will never override this default. No conflict.
 *
 * Exported for unit testing; no React dependencies.
 */
export function initialCategoryForRole(
  role: Role,
  deepLinkCategory: DocumentCategory | undefined,
): CategoryFilter {
  if (deepLinkCategory !== undefined) return deepLinkCategory
  // AC3: default = 'ALL' for ALL roles (including ACCOUNTANT).
  // Previously ACCOUNTANT defaulted to 'RECEIPT'; now every role starts
  // on "Все категории" and narrows down via the dropdown.
  void role // role kept in signature for possible future per-role defaults
  return 'ALL'
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function DocumentsPage() {
  // Drop role - phase 3 (UT finding 1): DROP now has a /crm/documents page.
  // They see only their own docs (IDOR-scoped at service layer).
  // Sidebar link, route-access, and backend service all updated together.
  useRoleGuard(['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT', 'DROP'])
  const { user } = useAuth()
  if (!user) return null

  return <DocumentsPageContent viewer={user} />
}

function DocumentsPageContent({ viewer }: { viewer: SessionUser }) {
  const isAdmin = viewer.role === 'ADMIN'
  const search = Route.useSearch()
  const navigate = useNavigate({ from: '/crm/documents' })

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
  // shape matches /crm/users.
  const [statusTab, setStatusTab] = useState<StatusTab>('ACTIVE')
  const [ownerFilter, setOwnerFilter] = useState<string>('ALL')
  // Category filter: 'ALL' = no category filter (show all accessible to role).
  // ACCOUNTANT defaults to 'RECEIPT' (primary workflow: receipt validation).
  // All other roles default to 'ALL'. An explicit `?category=` deep-link
  // (e.g. from a notification → `/crm/documents?category=INVOICE&openTx=…`)
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

  // Pending-signature counter across all INVOICE rows the viewer can see.
  // Drives the amber «У вас N инвойсов ожидает подписи» banner at the top
  // of the page. We query INVOICE specifically (independent of the current
  // category filter) so the banner is visible even when the dropdown is on
  // a different category.
  const { data: invoiceDocs } = useDocuments({ category: 'INVOICE', includeDeleted: false })
  const pendingCount = useMemo(
    () => (invoiceDocs ?? []).filter((d) => d.invoicePendingSignature).length,
    [invoiceDocs],
  )

  // Empty-access state — no categories at all.
  if (availableCategories.length === 0) {
    return (
      <div className="flex flex-col h-full" data-testid="documents-page">
        <div className="px-6 pt-4 pb-3" />
        <div className="flex-1 min-h-0 overflow-y-auto px-6 pt-4 pb-6">
          <div
            data-testid="documents-no-access"
            className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-24 text-center"
          >
            <Shield className="h-10 w-10 text-muted-foreground/30" />
            <p className="mt-4 text-sm font-medium">У вас нет доступа к документам</p>
          </div>
        </div>
      </div>
    )
  }

  // Status-tab options — only rendered for ADMIN (see JSX guard below).
  // Non-admin roles see only their active documents; the entire toggle is
  // hidden so the layout stays clean and there is no disabled-pill confusion.
  const statusOptions: ReadonlyArray<SegmentedToggleOption<StatusTab>> = [
    { value: 'ALL', label: 'Все' },
    { value: 'ACTIVE', label: 'Активные' },
    { value: 'ARCHIVED', label: 'Архив', icon: Archive },
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
              ariaLabel="Фильтр документов"
              variant="tabs"
              size="sm"
              layoutId="documents-status-tabs"
              className="w-fit"
              testId="documents-status-tabs"
            />
          </motion.div>
        )}

        {/* Unified toolbar — canonical Card pattern matching /crm/projects */}
        <Card>
          <CardContent className="flex flex-wrap items-center gap-3 pt-4 pb-4">
            {/* Search */}
            <div className="relative flex-1 min-w-50">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Поиск по имени…"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                className={searchInput ? 'pl-8 pr-8' : 'pl-8'}
                data-testid="documents-search"
              />
              {searchInput ? (
                <button
                  type="button"
                  onClick={handleClearSearch}
                  aria-label="Очистить поиск"
                  className="absolute right-2.5 top-2.5 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              ) : null}
            </div>

            {/* Owner filter — ADMIN/HR only */}
            {showOwnerFilter ? (
              <Select value={ownerFilter} onValueChange={setOwnerFilter}>
                <SelectTrigger className="w-44" data-testid="documents-owner-filter">
                  <SelectValue placeholder="Все владельцы" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">Все владельцы</SelectItem>
                  {(users ?? []).map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {u.displayName} ({u.email})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}

            {/* Category filter */}
            <Select
              value={categoryFilter}
              onValueChange={(v) => setCategoryFilter(v as CategoryFilter)}
            >
              <SelectTrigger className="w-44" data-testid="documents-category-filter">
                <SelectValue placeholder="Все категории" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">Все категории</SelectItem>
                {availableCategories.map((cat) => (
                  <SelectItem key={cat} value={cat}>
                    {CATEGORY_LABELS_RU[cat]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <div className="hidden h-6 w-px bg-border sm:block" aria-hidden />

            {/* Sort */}
            <Select value={sortKey} onValueChange={(v) => setSortKey(v as SortKey)}>
              <SelectTrigger className="w-52" data-testid="documents-sort">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SORT_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* View toggle — list / grid */}
            <div
              className="ml-auto flex items-center gap-1 rounded-md border border-border p-0.5"
              data-testid="documents-view-toggle"
            >
              <button
                type="button"
                aria-label="Список"
                aria-pressed={view === 'list'}
                data-testid="documents-view-list"
                onClick={() => handleViewChange('list')}
                className={`flex h-7 w-7 items-center justify-center rounded transition ${
                  view === 'list'
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <List className="h-4 w-4" />
              </button>
              <button
                type="button"
                aria-label="Сетка"
                aria-pressed={view === 'grid'}
                data-testid="documents-view-grid"
                onClick={() => handleViewChange('grid')}
                className={`flex h-7 w-7 items-center justify-center rounded transition ${
                  view === 'grid'
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <LayoutGrid className="h-4 w-4" />
              </button>
            </div>
          </CardContent>
        </Card>
      </StickyPageHeader>

      <div
        className="flex-1 min-h-0 overflow-y-auto px-6 pt-4 pb-6"
        style={{ scrollbarGutter: 'stable' }}
      >
        {pendingCount > 0 ? (
          // Amber banner — invites the viewer to switch to the INVOICE tab.
          // Scrollable: disappears once user has navigated to the INVOICE filter.
          <div
            className="mb-4 flex items-center justify-between rounded-lg border border-amber-500/30 bg-amber-500/10 p-4"
            data-testid="documents-pending-signature-banner"
          >
            <div className="flex items-center gap-3">
              <FileSignature className="h-5 w-5 text-amber-400" />
              <span className="text-sm">{pluralizeInvoicesPending(pendingCount)}</span>
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setCategoryFilter('INVOICE')}
              data-testid="documents-pending-signature-banner-cta"
            >
              Перейти
            </Button>
          </div>
        ) : null}

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
          notifications. Replaces the standalone /crm/finance/invoices page. */}
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

// ---------------------------------------------------------------------------
// Header sub-component (title + upload button only — toolbar lives in Card below)
// ---------------------------------------------------------------------------

interface HeaderProps {
  viewer: SessionUser
  categoryFilter: CategoryFilter
  users: UserProfileDto[] | undefined
}

function DocumentsHeader({ viewer, categoryFilter, users }: HeaderProps) {
  const showOwnerFilter = canSeeOwnerFilter(viewer.role)
  // Hide the upload button when viewing read-only category filters
  // (RECEIPT / INVOICE) — both are produced by Finance, not by uploads.
  const isReceiptsFilter = categoryFilter === 'RECEIPT'
  const isInvoicesFilter = categoryFilter === 'INVOICE'

  const [uploadOpen, setUploadOpen] = useState(false)

  // Projects — only needed for CONTRACT uploads.
  const { data: projects } = useQuery<ProjectDto[]>({
    queryKey: ['projects', { archived: 'active' }],
    queryFn: async () => {
      const res = await api.get<ProjectDto[]>('/projects')
      return res.data
    },
    enabled: uploadOpen,
    staleTime: 5 * 60 * 1000,
  })

  const uploadableCats = UPLOADABLE_PER_ROLE[viewer.role] ?? []
  // The upload button is hidden when:
  //   - the role can't upload anything from this page (e.g. ACCOUNTANT), OR
  //   - the dropdown is narrowed to Receipts only (uploads via Finance), OR
  //   - the dropdown is narrowed to an internal category (AVATAR/LOGO —
  //     managed in Profile/Project, not bulk-uploaded here).
  const canShowUploadButton =
    uploadableCats.length > 0 &&
    !isReceiptsFilter &&
    !isInvoicesFilter &&
    categoryFilter !== 'AVATAR' &&
    categoryFilter !== 'LOGO'

  // For the dialog we pick a sensible default category from the active
  // filter — fall back to the first uploadable category if the user is on
  // 'ALL' or a filter they can't upload to (e.g. ADMIN on RECEIPT).
  const defaultUploadCategory: DocumentCategory =
    categoryFilter !== 'ALL' && uploadableCats.includes(categoryFilter)
      ? categoryFilter
      : (uploadableCats[0] ?? 'RESUME')

  return (
    <>
      {/* Page header — mirrors /crm/users: motion entrance, title on the left,
          primary action on the right. */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28 }}
        className="flex flex-wrap items-center justify-between gap-4"
      >
        <div />

        {canShowUploadButton ? (
          <Button onClick={() => setUploadOpen(true)} data-testid="documents-upload-button">
            <Plus className="mr-2 h-4 w-4" />
            Загрузить
          </Button>
        ) : null}
      </motion.div>

      {canShowUploadButton ? (
        <UploadDocumentDialog
          open={uploadOpen}
          onOpenChange={setUploadOpen}
          defaultCategory={defaultUploadCategory}
          allowedCategories={uploadableCats}
          projects={(projects ?? []).map((p) => ({
            id: p.id,
            label: `${p.companyName}${p.domain ? ' — ' + p.domain : ''}`,
          }))}
          owners={
            showOwnerFilter && users
              ? users.map((u) => ({
                  id: u.id,
                  label: `${u.displayName} (${u.email})`,
                }))
              : undefined
          }
          defaultOwnerId={viewer.id}
        />
      ) : null}
    </>
  )
}

// ---------------------------------------------------------------------------
// List section (replaces previous per-tab content)
// ---------------------------------------------------------------------------

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

function DocumentsListSection({
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
    result = filterDocuments(result, searchQuery)
    result = sortDocuments(result, sortKey)
    return result
  }, [data, statusTab, searchQuery, sortKey])

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
      <p className="mt-4 text-sm font-medium">Пока нет чеков</p>
      <p className="mt-1 max-w-md text-xs text-muted-foreground">
        Чеки прикрепляются через раздел Финансы при создании транзакции.
      </p>
      <Link
        to="/crm/finance"
        className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
      >
        Перейти к Финансам
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
      <p className="mt-4 text-sm font-medium">Пока нет инвойсов</p>
      <p className="mt-1 max-w-md text-xs text-muted-foreground">
        Инвойсы создаются автоматически после оплаты транзакций. Кликните по карточке инвойса здесь,
        чтобы открыть PDF, увидеть подписи и подписать документ.
      </p>
      <Link
        to="/crm/finance"
        className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
      >
        Перейти к Финансам
      </Link>
    </div>
  )

  // For AVATAR / LOGO filters (ADMIN audit view) — neutral empty state.
  const internalEmpty = (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-24 text-center">
      <FileText className="h-10 w-10 text-muted-foreground/30" />
      <p className="mt-4 text-sm font-medium">
        Нет {categoryFilter === 'AVATAR' ? 'аватаров' : 'логотипов'}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        Управление — из{' '}
        {categoryFilter === 'AVATAR' ? 'профилей пользователей' : 'настроек проектов'}.
      </p>
    </div>
  )

  // Generic empty state — covers `ALL`, RESUME, SCAN, CONTRACT.
  const genericEmpty = (
    <div
      data-testid="documents-empty-generic"
      className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-24 text-center"
    >
      <FileText className="h-10 w-10 text-muted-foreground/30" />
      <p className="mt-4 text-sm font-medium">Нет документов</p>
    </div>
  )

  const emptyState =
    categoryFilter === 'RECEIPT'
      ? receiptEmpty
      : categoryFilter === 'INVOICE'
        ? invoiceEmpty
        : categoryFilter === 'AVATAR' || categoryFilter === 'LOGO'
          ? internalEmpty
          : genericEmpty

  // Counter label — when filtering by category, mention which one.
  const counterScope =
    categoryFilter === 'ALL' ? '' : ` · ${CATEGORY_LABELS_RU[categoryFilter].toLowerCase()}`

  return (
    <div className="space-y-3">
      <div
        className="text-xs text-muted-foreground"
        data-testid={`documents-counter-${categoryFilter}`}
      >
        {isLoading
          ? '...'
          : `${filtered.length} ${pluralizeDocuments(filtered.length)}${
              statusTab === 'ARCHIVED' ? ' · в архиве' : statusTab === 'ALL' ? ' · все' : ''
            }${counterScope}`}
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

// ru-RU plural helper for the counter ("1 документ", "2 документа", "5 документов").
function pluralizeDocuments(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 'документ'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'документа'
  return 'документов'
}

/**
 * ru-RU plural helper for the «У вас N инвойсов ожидает подписи» banner.
 * Returns a fully-formed sentence (not just the noun) because the verb form
 * also depends on the count ("инвойс ожидает" vs "инвойса ожидают" vs
 * "инвойсов ожидают"). Exported via the same module — kept colocated so the
 * call site stays one-liner.
 */
export function pluralizeInvoicesPending(n: number): string {
  const last = n % 10
  const last2 = n % 100
  if (last2 >= 11 && last2 <= 14) return `У вас ${n} инвойсов ожидает подписи`
  if (last === 1) return `У вас ${n} инвойс ожидает подписи`
  if (last >= 2 && last <= 4) return `У вас ${n} инвойса ожидают подписи`
  return `У вас ${n} инвойсов ожидают подписи`
}
