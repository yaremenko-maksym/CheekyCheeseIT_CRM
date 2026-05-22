import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'framer-motion'
import { Archive, ArrowDown, ArrowUp, Plus, Search } from 'lucide-react'
import { useMemo, useRef, useState, useTransition } from 'react'
import { z } from 'zod'
import type { UserProfileDto } from '@crm/shared'
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
import { Skeleton } from '@/components/ui/skeleton'
import { ArchiveConfirmDialog } from '@/components/users/ArchiveConfirmDialog'
import { UserDialog } from '@/components/users/UserDialog'
import { UserRow } from '@/components/users/UserRow'
import {
  ROLE_LABELS,
  ROLES,
  type Role,
  type SortDir,
  type SortKey,
} from '@/components/users/constants'
import { UnarchiveButton } from '@/components/users/UnarchiveButton'

// `archived` may arrive as a query-string ("true"/"false") for deep-links —
// `z.coerce.boolean()` accepts both `boolean` and string forms safely.
const searchSchema = z.object({
  archived: z.coerce.boolean().optional(),
})

export const Route = createFileRoute('/crm/users/')({
  validateSearch: searchSchema,
  component: UsersPage,
})

async function fetchUsers(archivedQuery: '' | 'true' | 'all'): Promise<UserProfileDto[]> {
  const res = await api.get<UserProfileDto[]>(
    `/users${archivedQuery ? `?archived=${archivedQuery}` : ''}`,
  )
  return res.data
}

function UsersPage() {
  const { user: me } = useAuth()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: '/crm/users' })

  const showArchived = search.archived === true

  if (!me) return null

  if (me.role !== 'ADMIN') {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Пользователи</h1>
        </div>
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-24 text-center">
          <p className="text-sm font-medium text-muted-foreground">Доступ только для администратора</p>
        </div>
      </div>
    )
  }

  return (
    <UsersPageContent
      meId={me.id}
      showArchived={showArchived}
      onToggleArchived={(v) => {
        void navigate({
          search: (prev) => ({ ...prev, archived: v || undefined }),
          replace: true,
        })
      }}
    />
  )
}

type StatusTab = 'ALL' | 'ACTIVE' | 'ARCHIVED'

function UsersPageContent({
  meId,
  showArchived,
  onToggleArchived,
}: {
  meId: string
  showArchived: boolean
  onToggleArchived: (next: boolean) => void
}) {
  const [searchQuery, setSearchQuery] = useState('')
  const [roleFilter, setRoleFilter] = useState<Role | 'ALL'>('ALL')
  const [sortKey, setSortKey] = useState<SortKey>('displayName')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [createOpen, setCreateOpen] = useState(false)
  const [createKey, setCreateKey] = useState(0)
  const [editUser, setEditUser] = useState<UserProfileDto | null>(null)
  const [archiveUser, setArchiveUser] = useState<UserProfileDto | null>(null)
  // ut-44: tri-state filter — local "ACTIVE" / "ALL" plus URL-driven "ARCHIVED".
  // Persisting only ARCHIVED in URL keeps deep-links to "active" simple and
  // matches the team / projects pages.
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'ACTIVE'>('ACTIVE')
  // Manual focus restoration for the create-dialog: since the dialog is opened
  // programmatically (not via Radix DialogTrigger) it can't auto-restore focus
  // to the trigger on close — we refocus it ourselves.
  const createTriggerRef = useRef<HTMLButtonElement>(null)

  // ut-44: archivedQuery — '' (active) / 'all' / 'true' depending on the
  // current status tab. URL `archived=true` still selects the archived tab,
  // matching projects and teams pages.
  const currentStatusTab: StatusTab = showArchived ? 'ARCHIVED' : statusFilter
  const archivedQuery: '' | 'true' | 'all' =
    currentStatusTab === 'ARCHIVED' ? 'true' : currentStatusTab === 'ALL' ? 'all' : ''

  const { data: users, isLoading } = useQuery({
    queryKey: ['users-admin', { archived: archivedQuery || 'active' }],
    queryFn: () => fetchUsers(archivedQuery),
    placeholderData: keepPreviousData,
  })

  const [, startTransition] = useTransition()

  const handleStatusTabChange = (next: StatusTab) => {
    // ut-32: wrap in startTransition so the SegmentedToggle's layout pill
    // animation isn't cancelled by the suspended render of the new query.
    startTransition(() => {
      if (next === 'ARCHIVED') {
        onToggleArchived(true)
        return
      }
      if (showArchived) onToggleArchived(false)
      setStatusFilter(next === 'ALL' ? 'ALL' : 'ACTIVE')
    })
  }

  const statusTabs: ReadonlyArray<SegmentedToggleOption<StatusTab>> = [
    { value: 'ALL', label: 'Все' },
    { value: 'ACTIVE', label: 'Активные' },
    { value: 'ARCHIVED', label: 'Архив', testId: 'users-toggle-archived', icon: Archive },
  ]

  const filtered = useMemo(() => {
    if (!users) return []
    let list = [...users]
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      list = list.filter(
        (u) =>
          u.displayName.toLowerCase().includes(q) ||
          u.email.toLowerCase().includes(q) ||
          (u.telegram ?? '').toLowerCase().includes(q) ||
          (Array.isArray(u.techStack)
            ? u.techStack.join(', ')
            : (u.techStack ?? '')
          )
            .toLowerCase()
            .includes(q),
      )
    }
    if (roleFilter !== 'ALL') list = list.filter((u) => u.role === roleFilter)
    list.sort((a, b) => {
      let av: string | number = ''
      let bv: string | number = ''
      if (sortKey === 'displayName') {
        av = a.displayName
        bv = b.displayName
      } else if (sortKey === 'email') {
        av = a.email
        bv = b.email
      } else if (sortKey === 'role') {
        av = a.role
        bv = b.role
      } else if (sortKey === 'createdAt') {
        av = new Date(a.createdAt).getTime()
        bv = new Date(b.createdAt).getTime()
      }
      if (av < bv) return sortDir === 'asc' ? -1 : 1
      if (av > bv) return sortDir === 'asc' ? 1 : -1
      return 0
    })
    return list
  }, [users, searchQuery, roleFilter, sortKey, sortDir])

  // ut-18: sort moved from column headers to the filter bar.
  // `sortKey` choices exclude 'email' — admins rarely re-order by it.
  const sortKeyOptions: Array<{ value: SortKey; label: string }> = [
    { value: 'displayName', label: 'По имени' },
    { value: 'role', label: 'По роли' },
    { value: 'createdAt', label: 'По дате добавления' },
  ]

  return (
    <div className="space-y-6">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28 }}
        className="flex items-center justify-between gap-4 flex-wrap"
      >
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Пользователи</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {isLoading ? '...' : `${filtered.length} из ${users?.length ?? 0}`}
            {currentStatusTab === 'ARCHIVED' && ' · архив'}
            {currentStatusTab === 'ALL' && ' · все'}
          </p>
        </div>
        <Button
          ref={createTriggerRef}
          onClick={() => {
            setCreateKey((k) => k + 1)
            setCreateOpen(true)
          }}
          data-testid="users-create-button"
        >
          <Plus className="mr-2 h-4 w-4" />
          Добавить
        </Button>
      </motion.div>

      {/* ut-44: status tabs row — «Все | Активные | Архив». Replaces the
          legacy «Показать архивных» checkbox; the archive tab keeps the
          `users-toggle-archived` testid so existing E2E (and admin URL
          deep-links via ?archived=true) continue to work. */}
      <SegmentedToggle<StatusTab>
        value={currentStatusTab}
        onChange={handleStatusTabChange}
        options={statusTabs}
        ariaLabel="Фильтр пользователей"
        variant="tabs"
        size="sm"
        layoutId="users-status-tabs"
        className="w-fit"
        testId="users-status-tabs"
      />

      {/* ut-43: unified toolbar — search + role filter + sort key + direction.
          Same shape as projects + team toolbars (Search input, per-page
          filters, sort dropdown + direction toggle button). */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28, delay: 0.05 }}
      >
        <Card>
          <CardContent className="flex flex-wrap items-center gap-3 pt-4 pb-4">
            <div className="relative flex-1 min-w-50">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Поиск по имени, email, telegram, технологии..."
                className="pl-8"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            <Select value={roleFilter} onValueChange={(v) => setRoleFilter(v as Role | 'ALL')}>
              <SelectTrigger className="w-44">
                <SelectValue placeholder="Все роли" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">Все роли</SelectItem>
                {ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* ut-18: sort relocated from column headers. The visual separator
                keeps "filter" controls (search + role) distinct from "ordering"
                controls (sort key + direction). */}
            <div className="hidden h-6 w-px bg-border sm:block" aria-hidden />
            <Select value={sortKey} onValueChange={(v) => setSortKey(v as SortKey)}>
              <SelectTrigger className="w-52" data-testid="users-sort-key">
                <SelectValue placeholder="Сортировка" />
              </SelectTrigger>
              <SelectContent>
                {sortKeyOptions.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setSortDir((d: SortDir) => (d === 'asc' ? 'desc' : 'asc'))}
              aria-label={`Направление сортировки: ${
                sortDir === 'asc' ? 'По возрастанию' : 'По убыванию'
              }`}
              data-testid="users-sort-direction"
              data-dir={sortDir}
              className="h-9 w-9"
            >
              {sortDir === 'asc' ? (
                <ArrowUp className="h-4 w-4" />
              ) : (
                <ArrowDown className="h-4 w-4" />
              )}
            </Button>
          </CardContent>
        </Card>
      </motion.div>

      {/* Table (sort header + rows) */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.28, delay: 0.1 }}
      >
        <Card>
          <CardContent className="p-3 space-y-2">
            {/* ut-19: column headers removed — rows are self-describing
                (avatar / name+email, role badge, дата). Sort controls
                остаются в filter bar выше. */}
            {isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div
                    key={i}
                    className="grid items-center gap-3 px-3 py-3 rounded-md"
                    style={{ gridTemplateColumns: '64px 3fr 1.4fr' }}
                  >
                    <Skeleton className="h-8 w-8 rounded-full mx-auto" />
                    <div className="space-y-2">
                      <Skeleton className="h-4 w-36" />
                      <Skeleton className="h-3 w-48" />
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <Skeleton className="h-5 w-20 rounded-full" />
                      <Skeleton className="h-3 w-16" />
                    </div>
                  </div>
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 gap-2 text-muted-foreground">
                <Search className="h-8 w-8 opacity-30" />
                <p className="text-sm">Пользователи не найдены</p>
              </div>
            ) : (
              <motion.div className="space-y-1" data-testid="users-list">
                <AnimatePresence mode="popLayout" initial={false}>
                  {filtered.map((u) => (
                    <motion.div
                      key={u.id}
                      layout="position"
                      initial={{ opacity: 0, y: -6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.08, ease: 'easeOut' }}
                    >
                      {u.archivedAt ? (
                        <UnarchiveButton
                          user={u}
                          isSelf={u.id === meId}
                          onEdit={() => setEditUser(u)}
                          onArchive={() => setArchiveUser(u)}
                        />
                      ) : (
                        <UserRow
                          user={u}
                          isSelf={u.id === meId}
                          onEdit={() => setEditUser(u)}
                          onArchive={() => setArchiveUser(u)}
                          onUnarchive={() => {
                            // not used for active rows; only archived rows render UnarchiveButton
                          }}
                        />
                      )}
                    </motion.div>
                  ))}
                </AnimatePresence>
              </motion.div>
            )}
          </CardContent>
        </Card>
      </motion.div>

      <UserDialog
        mode="create"
        key={createKey}
        open={createOpen}
        onClose={() => {
          setCreateOpen(false)
          // Restore focus to the trigger so keyboard users land back on the
          // Add button after the dialog closes (mirrors Radix DialogTrigger).
          requestAnimationFrame(() => createTriggerRef.current?.focus())
        }}
      />
      <UserDialog mode="edit" user={editUser} onClose={() => setEditUser(null)} />
      <ArchiveConfirmDialog user={archiveUser} onClose={() => setArchiveUser(null)} />
    </div>
  )
}

