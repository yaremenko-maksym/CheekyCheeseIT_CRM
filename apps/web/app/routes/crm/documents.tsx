/**
 * /crm/documents — PHASE 6 documents module entry.
 *
 * Layout overview:
 *
 *   ┌───────────────────────────────────────────────────────────────────┐
 *   │  Header (title + ADMIN toggles + owner filter + upload button)    │
 *   ├───────────────────────────────────────────────────────────────────┤
 *   │  Tabs: Резюме | Сканы | Договори | Чеки  [+ Аватары | Логотипы]   │
 *   ├───────────────────────────────────────────────────────────────────┤
 *   │  <DocumentList /> for the active tab                              │
 *   └───────────────────────────────────────────────────────────────────┘
 *
 * Visibility per role is computed once via TAB_VISIBILITY and the role-side
 * filter from the spec — when the viewer's role has zero visible tabs we
 * show a single "no access" panel instead of an empty tab strip.
 *
 * The two "internal" categories (AVATAR, LOGO) live behind an ADMIN-only
 * toggle so they're auditable from one place without leaking into normal
 * users' UX.
 */
import { useEffect, useMemo, useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { FileText, Plus, Receipt as ReceiptIcon, Shield } from 'lucide-react'
import type {
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
import { useDocuments } from '@/hooks/use-documents'
import { DocumentList } from '@/components/documents/document-list'
import { UploadDocumentDialog } from '@/components/documents/upload-document-dialog'

type Role = SessionUser['role']

export const Route = createFileRoute('/crm/documents')({
  component: DocumentsPage,
})

// ---------------------------------------------------------------------------
// Visibility config
// ---------------------------------------------------------------------------

const VISIBLE_CATEGORIES: DocumentCategory[] = ['RESUME', 'SCAN', 'CONTRACT', 'RECEIPT']
const INTERNAL_TAB_CATEGORIES: DocumentCategory[] = ['AVATAR', 'LOGO']

const CATEGORY_LABELS_RU: Record<DocumentCategory, string> = {
  RESUME: 'Резюме',
  SCAN: 'Сканы документов',
  CONTRACT: 'Договори',
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

  // ADMIN-only switches.
  const [showDeleted, setShowDeleted] = useState(false)
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

  return (
    <div className="space-y-6">
      <DocumentsHeader
        viewer={viewer}
        activeTab={activeTab}
        showDeleted={showDeleted}
        onToggleDeleted={setShowDeleted}
        showInternal={showInternal}
        onToggleInternal={setShowInternal}
        ownerFilter={ownerFilter}
        onChangeOwnerFilter={setOwnerFilter}
      />

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
              includeDeleted={isAdmin && showDeleted}
            />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Header sub-component (filters + upload button)
// ---------------------------------------------------------------------------

interface HeaderProps {
  viewer: SessionUser
  activeTab: DocumentCategory
  showDeleted: boolean
  onToggleDeleted: (v: boolean) => void
  showInternal: boolean
  onToggleInternal: (v: boolean) => void
  ownerFilter: string
  onChangeOwnerFilter: (v: string) => void
}

function DocumentsHeader({
  viewer,
  activeTab,
  showDeleted,
  onToggleDeleted,
  showInternal,
  onToggleInternal,
  ownerFilter,
  onChangeOwnerFilter,
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
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Документы</h1>
          <p className="text-sm text-muted-foreground">Резюме, договора и сканы</p>
        </div>

        {canShowUploadButton ? (
          <Button
            onClick={() => setUploadOpen(true)}
            data-testid="documents-upload-button"
          >
            <Plus className="mr-1 h-4 w-4" />
            Загрузить
          </Button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-end gap-3">
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
          <div className="flex flex-wrap items-center gap-3">
            <label className="inline-flex cursor-pointer items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={showDeleted}
                onChange={(e) => onToggleDeleted(e.target.checked)}
                className="h-4 w-4 rounded border-border"
                data-testid="documents-toggle-deleted"
              />
              Показать удалённые
            </label>
            <label className="inline-flex cursor-pointer items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={showInternal}
                onChange={(e) => onToggleInternal(e.target.checked)}
                className="h-4 w-4 rounded border-border"
                data-testid="documents-toggle-internal"
              />
              Показать internal
            </label>
          </div>
        ) : null}
      </div>

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
  ownerId?: string
  includeDeleted: boolean
}

function DocumentsTabContent({
  viewer,
  category,
  ownerId,
  includeDeleted,
}: TabContentProps) {
  const { data, isLoading } = useDocuments({
    category,
    ownerId,
    includeDeleted,
  })

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
    <DocumentList
      documents={data ?? []}
      loading={isLoading}
      viewer={viewer}
      uploaders={uploaders}
      emptyState={emptyState}
    />
  )
}
