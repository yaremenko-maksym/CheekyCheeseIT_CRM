import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import {
  ArrowUpDown,
  ChevronDown,
  ChevronUp,
  Plus,
  Search,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { z } from 'zod'
import type { UserProfileDto } from '@crm/shared'
import type { AxiosError } from 'axios'
import { toast } from 'sonner'
import { useAuth } from '@/context/auth'
import { api } from '@/lib/axios'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
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

const searchSchema = z.object({
  archived: z.boolean().optional(),
})

export const Route = createFileRoute('/crm/users/')({
  validateSearch: searchSchema,
  component: UsersPage,
})

async function fetchUsers(archived: boolean): Promise<UserProfileDto[]> {
  const res = await api.get<UserProfileDto[]>(`/users${archived ? '?archived=true' : ''}`)
  return res.data
}

function UsersPage() {
  const { user: me } = useAuth()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: '/crm/users' })
  const queryClient = useQueryClient()

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
      queryClient={queryClient}
    />
  )
}

function UsersPageContent({
  meId,
  showArchived,
  onToggleArchived,
  queryClient,
}: {
  meId: string
  showArchived: boolean
  onToggleArchived: (next: boolean) => void
  queryClient: ReturnType<typeof useQueryClient>
}) {
  const [searchQuery, setSearchQuery] = useState('')
  const [roleFilter, setRoleFilter] = useState<Role | 'ALL'>('ALL')
  const [sortKey, setSortKey] = useState<SortKey>('displayName')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [createOpen, setCreateOpen] = useState(false)
  const [createKey, setCreateKey] = useState(0)
  const [editUser, setEditUser] = useState<UserProfileDto | null>(null)
  const [archiveUser, setArchiveUser] = useState<UserProfileDto | null>(null)

  const { data: users, isLoading } = useQuery({
    queryKey: ['users-admin', { archived: showArchived }],
    queryFn: () => fetchUsers(showArchived),
  })

  const unarchiveMutation = useMutation({
    mutationFn: (userId: string) =>
      api.post(`/users/${userId}/unarchive`).then((r) => r.data),
    onSuccess: (_data, userId) => {
      void queryClient.invalidateQueries({ queryKey: ['users-admin'] })
      void queryClient.invalidateQueries({ queryKey: ['user-profile', userId] })
      const user = users?.find((u) => u.id === userId)
      const msg = user?.role === 'SENIOR'
        ? 'Синьор и команда восстановлены'
        : 'Пользователь восстановлен из архива'
      if (user?.role === 'SENIOR') {
        void queryClient.invalidateQueries({ queryKey: ['teams'] })
      }
      toast.success(msg)
    },
    onError: (err: AxiosError<{ message: string }>) => {
      toast.error(err?.response?.data?.message ?? 'Ошибка при восстановлении')
    },
  })

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

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

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
            {showArchived && ' · архив'}
          </p>
        </div>
        <Button
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

      {/* Filters */}
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
            <Label
              className="flex items-center gap-2 cursor-pointer text-sm select-none ml-1"
              data-testid="users-toggle-archived-label"
            >
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => onToggleArchived(e.target.checked)}
                className="accent-primary h-4 w-4 cursor-pointer"
                data-testid="users-toggle-archived"
              />
              Показать архивных
            </Label>
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
            {/* Header / sort bar */}
            <div
              className="grid items-center text-xs text-muted-foreground px-3 py-1.5 border-b border-border/40"
              style={{ gridTemplateColumns: '64px 3fr 1.4fr' }}
            >
              <span aria-hidden />
              <SortHeader
                label="Пользователь"
                k="displayName"
                sortKey={sortKey}
                sortDir={sortDir}
                onToggle={toggleSort}
              />
              <div className="flex items-center justify-end gap-3">
                <SortHeader
                  label="Роль"
                  k="role"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onToggle={toggleSort}
                />
                <SortHeader
                  label="Добавлен"
                  k="createdAt"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onToggle={toggleSort}
                />
              </div>
            </div>

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
              <div className="space-y-1" data-testid="users-list">
                {filtered.map((u) => (
                  <UserRow
                    key={u.id}
                    user={u}
                    isSelf={u.id === meId}
                    onEdit={() => setEditUser(u)}
                    onArchive={() => setArchiveUser(u)}
                    onUnarchive={() => unarchiveMutation.mutate(u.id)}
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>

      <UserDialog
        mode="create"
        key={createKey}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
      />
      <UserDialog mode="edit" user={editUser} onClose={() => setEditUser(null)} />
      <ArchiveConfirmDialog user={archiveUser} onClose={() => setArchiveUser(null)} />
    </div>
  )
}

function SortHeader({
  label,
  k,
  sortKey,
  sortDir,
  onToggle,
}: {
  label: string
  k: SortKey
  sortKey: SortKey
  sortDir: SortDir
  onToggle: (k: SortKey) => void
}) {
  const isActive = sortKey === k
  const Icon = !isActive ? ArrowUpDown : sortDir === 'asc' ? ChevronUp : ChevronDown
  return (
    <button
      type="button"
      onClick={() => onToggle(k)}
      className={cn(
        'flex items-center gap-1 cursor-pointer select-none text-xs font-medium transition-colors',
        'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 rounded',
        isActive ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
      )}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onToggle(k)
        }
      }}
      data-testid={`users-sort-${k}`}
      data-active={isActive}
      data-dir={isActive ? sortDir : undefined}
    >
      {label}
      <Icon className={cn('h-3 w-3', isActive ? 'text-primary' : 'text-muted-foreground/40')} />
    </button>
  )
}
