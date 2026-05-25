/**
 * /crm/documents — PHASE 6 documents module entry.
 *
 * Layout (matches the look/feel of /crm/users and /crm/projects):
 *
 *   ┌───────────────────────────────────────────────────────────────────┐
 *   │  Header  (title + counter + Загрузить button)                     │
 *   │  Tri-state SegmentedToggle (Все / Активные / Архив, ADMIN-only)   │
 *   │  ADMIN extras: показать internal toggle + owner filter            │
 *   ├───────────────────────────────────────────────────────────────────┤
 *   │  Tabs: Резюме | Сканы | Договоры | Чеки  [+ Аватары | Логотипы]   │
 *   ├───────────────────────────────────────────────────────────────────┤
 *   │  <DocumentList /> for the active tab (grid of cards)              │
 *   └───────────────────────────────────────────────────────────────────┘
 *
 * Visibility per role is computed once via TAB_VISIBILITY and the role-side
 * filter from the spec — when the viewer's role has zero visible tabs we
 * show a single "no access" panel instead of an empty tab strip.
 *
 * Two "internal" categories (AVATAR, LOGO) live behind an ADMIN-only
 * toggle so they're auditable from one place without leaking into normal
 * users' UX.
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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs'
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

const INTERNAL_TAB_CATEGORIES: DocumentCategory[] = ['AVATAR', 'LOGO']

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
 * Maps Role → set of categories that role may see in the tab strip.
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
  const [showInternal, setShowInternal] = useState(false)
  const [ownerFilter, setOwnerFilter] = useState<string>('ALL')

  // Visible tabs for this viewer + ADMIN-toggled internal tabs.
  const visibleTabs = useMemo<DocumentCategory[]>(() => {
    const base = TAB_VISIBILITY[viewer.role] ?? []
    if (isAdmin && showInternal) return [...base, ...INTERNAL_TAB_CATEGORIES]
    return base
  }, [viewer.role, isAdmin, showInternal])

  const [activeTab, setActiveTab] = useState<DocumentCategory | null>(
    visibleTabs[0] ?? null,
  )

  // If the visible set changes (e.g. ADMIN toggles internal), keep activeTab
  // pointing at a valid value.
  useEffect(() => {
    if (visibleTabs.length === 0) {
      setActiveTab(null)
      return
    }
    if (!activeTab || !visibleTabs.includes(activeTab)) {
      setActiveTab(visibleTabs[0] ?? null)
    }
  }, [visibleTabs, activeTab])

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

  // Empty-access state — no tabs at all.
  if (visibleTabs.length === 0 || activeTab === null) {
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
        activeTab={activeTab}
        ownerFilter={ownerFilter}
        onChangeOwnerFilter={setOwnerFilter}
        showInternal={showInternal}
        onToggleInternal={setShowInternal}
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

      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as DocumentCategory)}
      >
        <TabsList data-testid="documents-tabs" className="flex-wrap">
          {visibleTabs.map((cat) => (
            <TabsTrigger
              key={cat}
              value={cat}
              data-testid={`documents-tab-${cat}`}
            >
              {CATEGORY_LABELS_RU[cat]}
            </TabsTrigger>
          ))}
        </TabsList>

        {visibleTabs.map((cat) => (
          <TabsContent key={cat} value={cat} className="mt-4">
            <DocumentsTabContent
              viewer={viewer}
              category={cat}
              ownerId={ownerFilter === 'ALL' ? undefined : ownerFilter}
              includeDeleted={includeDeleted}
              statusTab={statusTab}
              onOpen={openDetail}
              openDocId={search.openDocId}
            />
          </TabsContent>
        ))}
      </Tabs>

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
  activeTab: DocumentCategory
  ownerFilter: string
  onChangeOwnerFilter: (v: string) => void
  showInternal: boolean
  onToggleInternal: (v: boolean) => void
}

function DocumentsHeader({
  viewer,
  activeTab,
  ownerFilter,
  onChangeOwnerFilter,
  showInternal,
  onToggleInternal,
}: HeaderProps) {
  const isAdmin = viewer.role === 'ADMIN'
  const showOwnerFilter = canSeeOwnerFilter(viewer.role)
  const isReceiptsTab = activeTab === 'RECEIPT'

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
  //   - we're on the Receipts tab (uploads happen via Finance dialogs), OR
  //   - we're on an internal tab (AVATAR/LOGO — managed in Profile/Project).
  const canShowUploadButton =
    uploadableCats.length > 0 &&
    !isReceiptsTab &&
    !(['AVATAR', 'LOGO'] as DocumentCategory[]).includes(activeTab)

  // For the dialog we pick a sensible default category from the active tab —
  // fall back to the first uploadable category if the user is on a tab they
  // can't upload to (e.g. ADMIN viewing Receipts).
  const defaultUploadCategory: DocumentCategory =
    uploadableCats.includes(activeTab) ? activeTab : (uploadableCats[0] ?? 'RESUME')

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

      {/* ADMIN extras row — owner filter + internal toggle. Always rendered
          but only contains controls the viewer is entitled to. */}
      {(showOwnerFilter || isAdmin) ? (
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

          {isAdmin ? (
            <label className="inline-flex cursor-pointer items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={showInternal}
                onChange={(e) => onToggleInternal(e.target.checked)}
                className="h-4 w-4 rounded border-border"
                data-testid="documents-toggle-internal"
              />
              Показать internal (Аватары / Логотипы)
            </label>
          ) : null}
        </motion.div>
      ) : null}

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
// Per-tab content
// ---------------------------------------------------------------------------

interface TabContentProps {
  viewer: SessionUser
  category: DocumentCategory
  ownerId?: string | undefined
  includeDeleted: boolean
  /** Tri-state filter — feeds the empty-state copy + counter chip. */
  statusTab: StatusTab
  onOpen: (doc: Document) => void
  openDocId?: string | undefined
}

function DocumentsTabContent({
  viewer,
  category,
  ownerId,
  includeDeleted,
  statusTab,
  onOpen,
  openDocId,
}: TabContentProps) {
  const { data, isLoading } = useDocuments({
    category,
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

  // For the Receipts tab on an empty state, show a deep link into Finance
  // rather than the generic "no documents" placeholder.
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

  // For AVATAR / LOGO tabs (ADMIN audit view) — neutral empty state.
  const internalEmpty = (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-24 text-center">
      <FileText className="h-10 w-10 text-muted-foreground/30" />
      <p className="mt-4 text-sm font-medium">
        Нет {category === 'AVATAR' ? 'аватаров' : 'логотипов'}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        Управление — из{' '}
        {category === 'AVATAR' ? 'профилей пользователей' : 'настроек проектов'}.
      </p>
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
    category === 'RECEIPT'
      ? receiptEmpty
      : category === 'AVATAR' || category === 'LOGO'
        ? internalEmpty
        : undefined

  return (
    <div className="space-y-3">
      <div
        className="text-xs text-muted-foreground"
        data-testid={`documents-counter-${category}`}
      >
        {isLoading
          ? '...'
          : `${filtered.length} ${pluralizeDocuments(filtered.length)}${statusTab === 'ARCHIVED' ? ' · в архиве' : statusTab === 'ALL' ? ' · все' : ''}`}
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
