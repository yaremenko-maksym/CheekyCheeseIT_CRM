/**
 * /crm/documents — PHASE 6 documents module entry.
 *
 * Layout (matches the look/feel of /crm/users and /crm/projects):
 *
 *   ┌───────────────────────────────────────────────────────────────────┐
 *   │  Header  (title + counter + Загрузить button)                     │
 *   │  Tri-state SegmentedToggle (Все / Активные / Архив, ADMIN-only)   │
 *   │  Filter row: Owner (ADMIN/HR) + Category dropdown + internal tgl  │
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
import { useEffect, useMemo, useRef, useState } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { Archive, FileText, Plus, Receipt as ReceiptIcon, Shield } from 'lucide-react'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import {
  SegmentedToggle,
  type SegmentedToggleOption,
} from '@/components/ui/segmented-toggle'
import { useDocuments } from '@/hooks/use-documents'
import { DocumentList } from '@/components/documents/document-list'
import { DocumentDetailDialog } from '@/components/documents/document-detail-dialog'
import { UploadDocumentDialog } from '@/components/documents/upload-document-dialog'

type Role = SessionUser['role']
type StatusTab = 'ALL' | 'ACTIVE' | 'ARCHIVED'
type CategoryFilter = DocumentCategory | 'ALL'

// `openDocId` deep-link param: when set, the matching doc is opened in
// DocumentDetailDialog as soon as the list query resolves.
const searchSchema = z.object({
  openDocId: z.string().uuid().optional(),
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
}

/**
 * RBAC visibility per spec table «Видимость табов по ролям».
 * Maps Role → set of categories that role may see in the dropdown.
 */
const TAB_VISIBILITY: Record<Role, DocumentCategory[]> = {
  ADMIN: ['RESUME', 'SCAN', 'CONTRACT', 'RECEIPT'],
  SENIOR: ['RESUME', 'SCAN', 'CONTRACT', 'RECEIPT'],
  JUNIOR: ['RESUME', 'SCAN'],
  HR: ['RESUME', 'SCAN', 'CONTRACT'],
  ACCOUNTANT: ['SCAN', 'RECEIPT'],
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
}

function canSeeOwnerFilter(role: Role): boolean {
  return role === 'ADMIN' || role === 'HR'
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function DocumentsPage() {
  const { user } = useAuth()
  if (!user) return null

  return <DocumentsPageContent viewer={user} />
}

function DocumentsPageContent({ viewer }: { viewer: SessionUser }) {
  const isAdmin = viewer.role === 'ADMIN'
  const search = Route.useSearch()
  const navigate = useNavigate({ from: '/crm/documents' })

  // ADMIN-only switches. The "showDeleted" flag is now derived from the
  // status tab (ARCHIVED ⇒ true) rather than a separate checkbox so the
  // shape matches /crm/users.
  const [statusTab, setStatusTab] = useState<StatusTab>('ACTIVE')
  const [ownerFilter, setOwnerFilter] = useState<string>('ALL')
  // Category filter: 'ALL' = no category filter (show all accessible to role).
  // Default is 'ALL' per user choice (Variant A) — show everything by default,
  // narrow down via dropdown.
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('ALL')

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
    if (
      categoryFilter !== 'ALL' &&
      !availableCategories.includes(categoryFilter)
    ) {
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

  function openDetail(doc: Document) {
    setDetailDoc(doc)
    setDetailOpen(true)
    // Mirror the open into the URL so users can copy the link.
    void navigate({
      search: (prev) => ({ ...prev, openDocId: doc.id }),
      replace: true,
    })
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

  // Empty-access state — no categories at all.
  if (availableCategories.length === 0) {
    return (
      <div>
        <div className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight">Документы</h1>
          <p className="text-sm text-muted-foreground">Резюме, договора и сканы</p>
        </div>
        <div
          data-testid="documents-no-access"
          className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-24 text-center"
        >
          <Shield className="h-10 w-10 text-muted-foreground/30" />
          <p className="mt-4 text-sm font-medium">У вас нет доступа к документам</p>
        </div>
      </div>
    )
  }

  // Status-tab options. ARCHIVED is ADMIN-only — `disabled` for the rest so
  // the pill renders but isn't clickable, matching /crm/users behavior.
  const statusOptions: ReadonlyArray<SegmentedToggleOption<StatusTab>> = [
    { value: 'ALL', label: 'Все' },
    { value: 'ACTIVE', label: 'Активные' },
    {
      value: 'ARCHIVED',
      label: 'Архив',
      icon: Archive,
      disabled: !isAdmin,
    },
  ]

  return (
    <div className="space-y-6">
      <DocumentsHeader
        viewer={viewer}
        categoryFilter={categoryFilter}
        ownerFilter={ownerFilter}
        onChangeOwnerFilter={setOwnerFilter}
        availableCategories={availableCategories}
        onChangeCategoryFilter={setCategoryFilter}
      />

      {/* Tri-state status filter — matches /crm/users (Все / Активные / Архив).
          ARCHIVED is ADMIN-only — the option renders but is disabled for
          non-admins so the page layout doesn't shift between roles. */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28, delay: 0.05 }}
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

      <DocumentsListSection
        viewer={viewer}
        categoryFilter={categoryFilter}
        ownerId={ownerFilter === 'ALL' ? undefined : ownerFilter}
        includeDeleted={includeDeleted}
        statusTab={statusTab}
        onOpen={openDetail}
        openDocId={search.openDocId}
      />

      <DocumentDetailDialog
        open={detailOpen}
        onOpenChange={closeDetail}
        doc={detailDoc}
        viewer={viewer}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Header sub-component (title + counter + upload button + filters)
// ---------------------------------------------------------------------------

interface HeaderProps {
  viewer: SessionUser
  categoryFilter: CategoryFilter
  ownerFilter: string
  onChangeOwnerFilter: (v: string) => void
  availableCategories: DocumentCategory[]
  onChangeCategoryFilter: (v: CategoryFilter) => void
}

function DocumentsHeader({
  viewer,
  categoryFilter,
  ownerFilter,
  onChangeOwnerFilter,
  availableCategories,
  onChangeCategoryFilter,
}: HeaderProps) {
  const showOwnerFilter = canSeeOwnerFilter(viewer.role)
  // Hide the upload button when viewing the RECEIPT-only filter — receipts
  // come from Finance, not from this page.
  const isReceiptsFilter = categoryFilter === 'RECEIPT'

  const [uploadOpen, setUploadOpen] = useState(false)

  // Users for the owner filter — ADMIN/HR only.
  const { data: users } = useQuery<UserProfileDto[]>({
    queryKey: ['users', { archived: false }],
    queryFn: async () => {
      const res = await api.get<UserProfileDto[]>('/users')
      return res.data
    },
    enabled: showOwnerFilter,
    staleTime: 5 * 60 * 1000,
  })

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
    <div className="flex flex-col gap-4">
      {/* Page header — mirrors /crm/users: motion entrance, title + counter
          on the left, primary action on the right. */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28 }}
        className="flex flex-wrap items-center justify-between gap-4"
      >
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Документы</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Резюме, договоры и сканы
          </p>
        </div>

        {canShowUploadButton ? (
          <Button
            onClick={() => setUploadOpen(true)}
            data-testid="documents-upload-button"
          >
            <Plus className="mr-2 h-4 w-4" />
            Загрузить
          </Button>
        ) : null}
      </motion.div>

      {/* Filter row — owner (ADMIN/HR), category dropdown (everyone). */}
      <motion.div
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2, delay: 0.05 }}
        className="flex flex-wrap items-end gap-3"
      >
        {showOwnerFilter ? (
          <div className="w-full max-w-xs space-y-1.5">
            <Label htmlFor="documents-owner-filter" className="text-xs">
              Владелец
            </Label>
            <Select value={ownerFilter} onValueChange={onChangeOwnerFilter}>
              <SelectTrigger
                id="documents-owner-filter"
                data-testid="documents-owner-filter"
              >
                <SelectValue placeholder="Все" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">Все</SelectItem>
                {(users ?? []).map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.displayName} ({u.email})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}

        <div className="w-full max-w-xs space-y-1.5">
          <Label htmlFor="documents-category-filter" className="text-xs">
            Категория
          </Label>
          <Select
            value={categoryFilter}
            onValueChange={(v) => onChangeCategoryFilter(v as CategoryFilter)}
          >
            <SelectTrigger
              id="documents-category-filter"
              data-testid="documents-category-filter"
              className="w-44"
            >
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
        </div>
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
    </div>
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
}

function DocumentsListSection({
  viewer,
  categoryFilter,
  ownerId,
  includeDeleted,
  statusTab,
  onOpen,
  openDocId,
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
  const filtered = useMemo<Document[]>(() => {
    if (!data) return []
    if (statusTab === 'ARCHIVED') return data.filter((d) => d.deletedAt !== null)
    return data
  }, [data, statusTab])

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

  // For AVATAR / LOGO filters (ADMIN audit view) — neutral empty state.
  const internalEmpty = (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-24 text-center">
      <FileText className="h-10 w-10 text-muted-foreground/30" />
      <p className="mt-4 text-sm font-medium">
        Нет {categoryFilter === 'AVATAR' ? 'аватаров' : 'логотипов'}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        Управление — из{' '}
        {categoryFilter === 'AVATAR'
          ? 'профилей пользователей'
          : 'настроек проектов'}
        .
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

  // Build a minimal uploaders map from the docs themselves — for now we
  // surface the uploader id; resolving full names would require a /users
  // fetch which is already gated on ADMIN/HR in the header. The DocumentCard
  // gracefully falls back to a short id when the map entry is missing.
  const uploaders = useMemo(() => {
    const map: Record<string, { id: string; displayName: string | null }> = {}
    if (data) {
      for (const d of data) {
        if (!map[d.uploadedBy]) {
          map[d.uploadedBy] = { id: d.uploadedBy, displayName: null }
        }
      }
    }
    return map
  }, [data])

  const emptyState =
    categoryFilter === 'RECEIPT'
      ? receiptEmpty
      : categoryFilter === 'AVATAR' || categoryFilter === 'LOGO'
        ? internalEmpty
        : genericEmpty

  // Counter label — when filtering by category, mention which one.
  const counterScope =
    categoryFilter === 'ALL'
      ? ''
      : ` · ${CATEGORY_LABELS_RU[categoryFilter].toLowerCase()}`

  return (
    <div className="space-y-3">
      <div
        className="text-xs text-muted-foreground"
        data-testid={`documents-counter-${categoryFilter}`}
      >
        {isLoading
          ? '...'
          : `${filtered.length} ${pluralizeDocuments(filtered.length)}${
              statusTab === 'ARCHIVED'
                ? ' · в архиве'
                : statusTab === 'ALL'
                  ? ' · все'
                  : ''
            }${counterScope}`}
      </div>

      <DocumentList
        documents={filtered}
        loading={isLoading}
        viewer={viewer}
        uploaders={uploaders}
        emptyState={emptyState}
        onOpen={onOpen}
      />
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
