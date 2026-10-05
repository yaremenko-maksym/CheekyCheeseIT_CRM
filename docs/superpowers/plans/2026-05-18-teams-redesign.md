# Teams UI Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign of the team pages: a row list with a toolbar, a team page with RBAC views, edit + add-member dialogs, new telegram/notes fields on the team.

**Architecture:** A DB migration adds two fields to `teams`. The backend extends `mapTeam` and `update`. The frontend list page — a row list with search/filter/sort. The detail page — a single-column layout with a projects section and two dialogs. RBAC is implemented on the frontend based on `user.role`.

**Tech Stack:** Drizzle ORM, NestJS 11, Zod v4, React + TanStack Query, Framer Motion, shadcn/ui, Tailwind v4.

---

## File Map

| File | Action | What changes |
|------|-----|---------------|
| `apps/api/drizzle/migrations/0002_team_telegram_notes.sql` | CREATE | SQL migration |
| `apps/api/src/database/schema.ts` | MODIFY | `+telegram`, `+notes` in the `teams` table |
| `packages/shared/src/schemas/teams.ts` | MODIFY | `+telegram?`, `+notes?` in `teamSchema` and `updateTeamSchema` |
| `apps/api/src/teams/teams.service.ts` | MODIFY | `mapTeam` returns the fields; `update` accepts telegram/notes; `addMember` checks the SENIOR duplicate and a JUNIOR with a project |
| `apps/api/src/teams/teams.controller.ts` | MODIFY | `update` passes `telegram`, `notes` to the service |
| `apps/web/app/routes/crm/team/index.tsx` | MODIFY | Row list, toolbar, remove the add/delete buttons |
| `apps/web/app/routes/crm/team/$teamId.tsx` | MODIFY | Single-column, projects section, edit/addMember dialogs, RBAC |

---

## Task 1: DB Migration + Schema + Shared Types

**Files:**
- Create: `apps/api/drizzle/migrations/0002_team_telegram_notes.sql`
- Modify: `apps/api/src/database/schema.ts`
- Modify: `packages/shared/src/schemas/teams.ts`

- [ ] **Step 1.1: Create the migration file**

```sql
-- apps/api/drizzle/migrations/0002_team_telegram_notes.sql
ALTER TABLE "teams" ADD COLUMN "telegram" varchar(500);
ALTER TABLE "teams" ADD COLUMN "notes" text;
```

- [ ] **Step 1.2: Apply the migration**

```bash
pnpm --filter @crm/api exec drizzle-kit migrate
```

Expected output: `[✓] migrations applied successfully!`

- [ ] **Step 1.3: Update schema.ts — the teams table**

In `apps/api/src/database/schema.ts` replace the `teams` block:

```typescript
export const teams = pgTable('teams', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  telegram: varchar('telegram', { length: 500 }),
  notes: text('notes'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})
```

- [ ] **Step 1.4: Update the shared teamSchema**

In `packages/shared/src/schemas/teams.ts`:

```typescript
export const teamSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  telegram: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  members: z.array(teamMemberSchema),
})

export const updateTeamSchema = z.object({
  name: z.string().min(1).max(255),
  telegram: z.string().max(500).nullable().optional(),
  notes: z.string().nullable().optional(),
})
```

- [ ] **Step 1.5: Typecheck**

```bash
pnpm --filter @crm/shared typecheck
```

Expected output: 0 errors.

- [ ] **Step 1.6: Commit**

```bash
git add apps/api/drizzle/migrations/0002_team_telegram_notes.sql \
        apps/api/src/database/schema.ts \
        packages/shared/src/schemas/teams.ts
git commit -m "feat(teams): add telegram and notes fields to teams table"
```

---

## Task 2: Backend — Service + Controller

**Files:**
- Modify: `apps/api/src/teams/teams.service.ts`
- Modify: `apps/api/src/teams/teams.controller.ts`

- [ ] **Step 2.1: Update `mapTeam` — return telegram and notes**

In `teams.service.ts` in the `mapTeam` method replace the lines `return { id: team.id, name: team.name, ...`:

```typescript
return {
  id: team.id,
  name: team.name,
  telegram: team.telegram ?? null,
  notes: team.notes ?? null,
  createdAt: team.createdAt,
  updatedAt: team.updatedAt,
  members: [
    ...team.members
      .filter((m) => m.user?.role !== 'ADMIN' && m.user?.role !== 'JUNIOR')
      .map((m) => ({
        id: m.id,
        userId: m.userId,
        displayName: m.user?.displayName ?? '',
        email: m.user?.email ?? '',
        avatar: m.user?.avatar ?? null,
        techStack: m.user?.techStack ?? null,
        role: m.user?.role ?? 'SENIOR',
        joinedAt: m.joinedAt,
      })),
    ...filteredJuniorMembers,
  ],
}
```

- [ ] **Step 2.2: Update `update` — accept telegram and notes**

Replace the signature and body of the `update` method:

```typescript
async update(id: string, name: string, telegram: string | null | undefined, notes: string | null | undefined, currentUser: SessionUser) {
  if (currentUser.role !== 'ADMIN' && currentUser.role !== 'HR') {
    throw new ForbiddenException()
  }

  const team = await this.db.db.query.teams.findFirst({
    where: eq(teams.id, id),
    with: { members: { with: { user: true } } },
  })
  if (!team) throw new NotFoundException('Team not found')

  if (currentUser.role === 'HR' && !this.isHrOfTeam(team, currentUser.id)) {
    throw new ForbiddenException()
  }

  const [updated] = await this.db.db
    .update(teams)
    .set({
      name,
      ...(telegram !== undefined ? { telegram } : {}),
      ...(notes !== undefined ? { notes } : {}),
      updatedAt: new Date(),
    })
    .where(eq(teams.id, id))
    .returning()

  return updated
}
```

- [ ] **Step 2.3: Add validation in `addMember` — SENIOR duplicate and a JUNIOR with a project**

In the `addMember` method, after the `if (user.role === 'ADMIN')` check, add:

```typescript
// Prevent adding a second SENIOR
if (user.role === 'SENIOR') {
  const hasSenior = team.members.some((m) => m.user?.role === 'SENIOR')
  if (hasSenior) throw new BadRequestException('Team already has a senior')
}

// Prevent adding a JUNIOR who has an active project
if (user.role === 'JUNIOR') {
  const allProjects = await this.fetchAllProjects()
  const hasActiveProject = allProjects.some((p) =>
    p.members.some((m) => m.userId === userId && m.leftAt === null),
  )
  if (hasActiveProject) throw new BadRequestException('Junior already has an active project')
}
```

- [ ] **Step 2.4: Update the controller — pass telegram and notes**

In `teams.controller.ts` replace the `update` method:

```typescript
@Patch(':id')
update(
  @Param('id', ParseUUIDPipe) id: string,
  @Body() body: unknown,
  @CurrentUser() user: SessionUser,
) {
  const { name, telegram, notes } = updateTeamSchema.parse(body)
  return this.teamsService.update(id, name, telegram, notes, user)
}
```

- [ ] **Step 2.5: Typecheck API**

```bash
pnpm --filter @crm/api typecheck
```

Expected output: 0 errors.

- [ ] **Step 2.6: Commit**

```bash
git add apps/api/src/teams/teams.service.ts \
        apps/api/src/teams/teams.controller.ts
git commit -m "feat(teams): update service — telegram/notes, SENIOR dedup, JUNIOR project guard"
```

---

## Task 3: Frontend — Team list (index.tsx)

**Files:**
- Modify: `apps/web/app/routes/crm/team/index.tsx`

Keep all dialog logic (CreateSenior, EditTeam, DeleteTeam, AddMember) — only change the markup and remove the UserPlus and Trash2 buttons from the cards.

- [ ] **Step 3.1: Add toolbar state**

After the line `const [addMemberTeam, setAddMemberTeam] = useState<TeamDto | null>(null)` add:

```typescript
const [search, setSearch] = useState('')
const [filterRole, setFilterRole] = useState<string>('all')
const [sortBy, setSortBy] = useState<'name' | 'members' | 'projects'>('name')
```

- [ ] **Step 3.2: Compute the filtered and sorted teams**

After the toolbar state, before `if (isLoading)` add:

```typescript
const filteredTeams = useMemo(() => {
  if (!teams) return []
  let result = [...teams]

  if (search.trim()) {
    const q = search.toLowerCase()
    result = result.filter((t) => t.name.toLowerCase().includes(q))
  }

  if (filterRole !== 'all') {
    result = result.filter((t) =>
      t.members.some((m) => m.role === filterRole),
    )
  }

  result.sort((a, b) => {
    if (sortBy === 'name') return a.name.localeCompare(b.name)
    if (sortBy === 'members') return b.members.length - a.members.length
    if (sortBy === 'projects') {
      const aProjects = projects
        ? projects.filter(
            (p) => p.status === 'ACTIVE' && a.members.some((m) => m.role === 'SENIOR' && m.userId === p.seniorId),
          ).length
        : 0
      const bProjects = projects
        ? projects.filter(
            (p) => p.status === 'ACTIVE' && b.members.some((m) => m.role === 'SENIOR' && m.userId === p.seniorId),
          ).length
        : 0
      return bProjects - aProjects
    }
    return 0
  })

  return result
}, [teams, projects, search, filterRole, sortBy])
```

Also make sure `useMemo` is added to the imports at the top of the file along with the other hooks.

- [ ] **Step 3.3: Replace the page heading — without a subtitle**

Find:
```typescript
<div>
  <h1 className="text-2xl font-bold tracking-tight">Команда</h1>
  <p className="text-sm text-muted-foreground">Состав и роли сотрудников</p>
</div>
```

Replace with:
```typescript
<h1 className="text-2xl font-bold tracking-tight">Команда</h1>
```

- [ ] **Step 3.4: Add the toolbar between the heading and the list**

After `</div>` (the empty-team block) and before `<motion.div className="grid ...">` add:

```typescript
<div className="flex gap-2">
  <div className="relative flex-1">
    <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
    <Input
      placeholder="Пошук за назвою…"
      value={search}
      onChange={(e) => setSearch(e.target.value)}
      className="pl-9"
    />
  </div>
  <Select value={filterRole} onValueChange={setFilterRole}>
    <SelectTrigger className="w-36">
      <SelectValue placeholder="Всі ролі" />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="all">Всі ролі</SelectItem>
      <SelectItem value="SENIOR">Senior</SelectItem>
      <SelectItem value="HR">HR</SelectItem>
      <SelectItem value="JUNIOR">Junior</SelectItem>
      <SelectItem value="ACCOUNTANT">Accountant</SelectItem>
    </SelectContent>
  </Select>
  <Select value={sortBy} onValueChange={(v) => setSortBy(v as typeof sortBy)}>
    <SelectTrigger className="w-40">
      <SelectValue placeholder="Сортування" />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="name">Назва A→Z</SelectItem>
      <SelectItem value="members">Учасники ↓</SelectItem>
      <SelectItem value="projects">Проекти ↓</SelectItem>
    </SelectContent>
  </Select>
</div>
```

Add `Search` to the lucide-react imports.

- [ ] **Step 3.5: Replace the grid with a row list**

Find the block:
```typescript
<motion.div
  className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
  variants={container}
  initial="hidden"
  animate="show"
>
  {teams?.map((team) => (
```

Replace `className` and change `teams?.map` to `filteredTeams.map`:

```typescript
<motion.div
  className="flex flex-col gap-1.5"
  variants={container}
  initial="hidden"
  animate="show"
>
  {filteredTeams.length === 0 && (teams?.length ?? 0) > 0 && (
    <p className="py-8 text-center text-sm text-muted-foreground">
      Нічого не знайдено
    </p>
  )}
  {filteredTeams.map((team) => (
```

- [ ] **Step 3.6: Replace Card with a fixed-height row**

Find the whole block from `<motion.div key={team.id} variants={item}>` to the closing `</motion.div>` and replace:

```typescript
<motion.div key={team.id} variants={item}>
  <div
    className="group relative flex h-14 items-center gap-3 rounded-lg border border-border/60 bg-card/50 px-3 transition-all duration-200 hover:border-primary/30 hover:bg-card cursor-pointer"
    onClick={() => navigate({ to: '/crm/team/$teamId', params: { teamId: team.id } })}
  >
    <Link
      to="/crm/team/$teamId"
      params={{ teamId: team.id }}
      className="absolute inset-0 z-10"
      title={`Перейти до команди ${team.name}`}
    />

    {/* Avatars */}
    <div className="flex shrink-0 -space-x-2 relative z-20">
      {team.members.slice(0, 4).map((member, index) => (
        <Avatar
          key={member.id}
          className="h-7 w-7 ring-2 ring-background"
          style={{ zIndex: 4 - index }}
        >
          {member.avatar && <AvatarImage src={member.avatar} alt={member.displayName} />}
          <AvatarFallback className="text-[10px]">{getInitials(member.displayName)}</AvatarFallback>
        </Avatar>
      ))}
      {team.members.length > 4 && (
        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-muted ring-2 ring-background">
          <span className="text-[9px] font-medium text-muted-foreground">
            +{team.members.length - 4}
          </span>
        </div>
      )}
    </div>

    {/* Name + HRs */}
    <div className="relative z-20 min-w-0 flex-1">
      <p className="truncate text-sm font-semibold group-hover:text-primary transition-colors">
        {team.name}
      </p>
      <p className="truncate text-xs text-muted-foreground">
        {team.members.filter((m) => m.role === 'HR').map((m) => m.displayName).join(', ') || 'Без HR'}
      </p>
    </div>

    {/* Pills */}
    <div className="relative z-20 flex shrink-0 items-center gap-2">
      <Badge variant="outline" className="text-[11px] tabular-nums">
        {team.members.length} уч.
      </Badge>
      {(() => {
        const count = projects
          ? projects.filter(
              (p) => p.status === 'ACTIVE' && team.members.some((m) => m.role === 'SENIOR' && m.userId === p.seniorId),
            ).length
          : null
        return (
          <Badge
            variant="outline"
            className={cn(
              'text-[11px] tabular-nums',
              count && count > 0
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                : 'text-muted-foreground',
            )}
          >
            {count ?? '—'} {count === 1 ? 'проект' : count !== null && count < 5 ? 'проекти' : 'проектів'}
          </Badge>
        )
      })()}
    </div>

    {/* Rename only */}
    {canManage && (
      <div className="relative z-30 flex shrink-0 gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={(e) => {
            e.stopPropagation()
            e.preventDefault()
            setEditTeam(team)
            editForm.setFieldValue('name', team.name)
          }}
          title="Перейменувати"
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
      </div>
    )}
  </div>
</motion.div>
```

- [ ] **Step 3.7: Remove unused imports**

Remove from the imports: `Trash2`, `UserPlus`, `Card`, `CardContent`, `CardHeader`, `CardTitle`.  
Add: `Search` from `lucide-react`.

Check that `Users` remains (needed for the empty-state).

- [ ] **Step 3.8: Run dev and check in the browser**

```bash
# In a separate terminal, if not running:
pnpm dev
```

Open http://localhost:3000/crm/team, make sure:
- The heading without a subtitle
- A list of fixed-height rows (even with 3 HR — the height does not change)
- Toolbar: search, role filter, sort
- Only the ✏ button for ADMIN/HR

- [ ] **Step 3.9: Typecheck**

```bash
pnpm --filter @crm/web typecheck
```

Expected output: 0 errors.

- [ ] **Step 3.10: Commit**

```bash
git add apps/web/app/routes/crm/team/index.tsx
git commit -m "feat(teams): redesign list — row layout, toolbar, remove add/delete buttons"
```

---

## Task 4: Frontend — Team page ($teamId.tsx)

**Files:**
- Modify: `apps/web/app/routes/crm/team/$teamId.tsx`

- [ ] **Step 4.1: Add imports**

Fully replace the imports block:

```typescript
import { createFileRoute, Link } from '@tanstack/react-router'
import { useForm } from '@tanstack/react-form'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { ArrowLeft, Briefcase, Calendar, Pencil, UserMinus, UserPlus } from 'lucide-react'
import { useState } from 'react'
import { z } from 'zod'
import type { ProjectDto, TeamDto } from '@crm/shared'
import { useAuth } from '@/context/auth'
import { useRoleGuard } from '@/hooks/use-role-guard'
import { api } from '@/lib/axios'
import { cn } from '@/lib/utils'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  CrmDialogContent,
  CrmDialogHeader,
  CrmDialogBody,
  CrmDialogFooter,
  DialogTitle,
} from '@/components/ui/crm-dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from 'sonner'
```

- [ ] **Step 4.2: Add dialog state and the UserOption type**

After `const queryClient = useQueryClient()` add:

```typescript
const [showEdit, setShowEdit] = useState(false)
const [showAddMember, setShowAddMember] = useState(false)
```

Before the `TeamDetailPage` function add the type:

```typescript
type UserOption = {
  id: string
  displayName: string
  email: string
  role: string
  avatar: string | null
}
```

- [ ] **Step 4.3: Add a query for the user list**

After the `const { data: projects }` block add:

```typescript
const { data: allUsers } = useQuery<UserOption[]>({
  queryKey: ['users'],
  queryFn: () => api.get<UserOption[]>('/users').then((r) => r.data),
  enabled: !!user && canManage,
})
```

- [ ] **Step 4.4: Compute the team's active projects**

After `const canManage = ...` add:

```typescript
const activeProjects = projects?.filter(
  (p) =>
    p.status === 'ACTIVE' &&
    team?.members.some((m) => m.role === 'SENIOR' && m.userId === p.seniorId),
) ?? []

// Junior sees only their own project
const visibleProjects =
  user?.role === 'JUNIOR'
    ? activeProjects.filter((p) =>
        p.members?.some((m: { userId: string; leftAt: string | null }) => m.userId === user.id && m.leftAt === null),
      )
    : activeProjects
```

- [ ] **Step 4.5: Compute the member list for the filtered view**

After `const orderedRoles = ...` add:

```typescript
// Junior does not see other juniors
const visibleMembersByRole =
  user?.role === 'JUNIOR'
    ? Object.fromEntries(
        Object.entries(membersByRole).filter(([role]) => role !== 'JUNIOR'),
      )
    : membersByRole

const visibleOrderedRoles = roleOrder.filter(
  (role) => (visibleMembersByRole[role]?.length ?? 0) > 0,
)
```

- [ ] **Step 4.6: Compute the filtered list for the addMember dialog**

```typescript
const memberUserIds = new Set(team?.members.map((m) => m.userId) ?? [])
const teamHasSenior = team?.members.some((m) => m.role === 'SENIOR') ?? false

const juniorIdsWithProjects = new Set(
  projects?.flatMap((p) =>
    p.status === 'ACTIVE'
      ? p.members
          ?.filter((m: { leftAt: string | null }) => m.leftAt === null)
          .map((m: { userId: string }) => m.userId) ?? []
      : [],
  ) ?? [],
)

type CandidateUser = UserOption & { disabledReason?: string }

const candidateUsers: CandidateUser[] = (allUsers ?? [])
  .filter((u) => u.role !== 'ADMIN')
  .map((u): CandidateUser => {
    if (memberUserIds.has(u.id)) return { ...u, disabledReason: 'в команді' }
    if (u.role === 'SENIOR' && teamHasSenior) return { ...u, disabledReason: 'вже є синьор' }
    if (u.role === 'JUNIOR' && juniorIdsWithProjects.has(u.id)) return { ...u, disabledReason: 'має проект' }
    return u
  })
  .sort((a, b) => {
    const aDisabled = !!a.disabledReason
    const bDisabled = !!b.disabledReason
    if (aDisabled !== bDisabled) return aDisabled ? 1 : -1
    return a.displayName.localeCompare(b.displayName)
  })
```

- [ ] **Step 4.7: Add the team edit form**

```typescript
const editForm = useForm({
  defaultValues: { name: team?.name ?? '', telegram: team?.telegram ?? '', notes: team?.notes ?? '' },
  validators: {
    onChange: z.object({
      name: z.string().min(1, 'Назва обовʼязкова').max(255),
      telegram: z.string().max(500).optional(),
      notes: z.string().optional(),
    }),
  },
  onSubmit: async ({ value }) => {
    await updateMutation.mutateAsync(value)
  },
})

const updateMutation = useMutation({
  mutationFn: (data: { name: string; telegram: string; notes: string }) =>
    api.patch(`/teams/${teamId}`, data),
  onSuccess: () => {
    void queryClient.invalidateQueries({ queryKey: ['team', teamId] })
    void queryClient.invalidateQueries({ queryKey: ['teams'] })
    setShowEdit(false)
    toast.success('Команду оновлено')
  },
  onError: () => toast.error('Не вдалось оновити команду'),
})
```

- [ ] **Step 4.8: Add state and a mutation for addMember**

```typescript
const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set())

const addMemberMutation = useMutation({
  mutationFn: (userId: string) => api.post(`/teams/${teamId}/members`, { userId }),
  onSuccess: () => {
    void queryClient.invalidateQueries({ queryKey: ['team', teamId] })
    void queryClient.invalidateQueries({ queryKey: ['teams'] })
  },
  onError: (err: unknown) => {
    const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message
    toast.error(msg ?? 'Помилка додавання')
  },
})

async function handleAddMembers() {
  for (const userId of selectedUserIds) {
    await addMemberMutation.mutateAsync(userId)
  }
  setSelectedUserIds(new Set())
  setShowAddMember(false)
  toast.success('Учасників додано')
}
```

- [ ] **Step 4.9: Replace the page heading**

Find the whole `{/* Header */}` block and replace:

```typescript
{/* Header */}
<motion.div variants={item} className="flex items-start justify-between gap-4">
  <div className="flex items-center gap-3">
    <Button asChild variant="outline" size="icon" className="shrink-0">
      <Link to="/crm/team">
        <ArrowLeft className="h-4 w-4" />
      </Link>
    </Button>
    <div>
      <h1 className="text-2xl font-bold tracking-tight">{team.name}</h1>
      <p className="text-sm text-muted-foreground flex items-center gap-1.5">
        <Calendar className="h-3.5 w-3.5" />
        Створена {new Date(team.createdAt).toLocaleDateString('uk-UA', {
          day: 'numeric',
          month: 'long',
          year: 'numeric',
        })}
      </p>
    </div>
  </div>
  {canManage && (
    <div className="flex shrink-0 gap-2">
      <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setShowAddMember(true)}>
        <UserPlus className="h-4 w-4" />
        Додати
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5"
        onClick={() => {
          editForm.setFieldValue('name', team.name)
          editForm.setFieldValue('telegram', team.telegram ?? '')
          editForm.setFieldValue('notes', team.notes ?? '')
          setShowEdit(true)
        }}
      >
        <Pencil className="h-4 w-4" />
        Редагувати
      </Button>
    </div>
  )}
</motion.div>
```

- [ ] **Step 4.10: Replace the grid layout with single-column**

Find `<div className="grid gap-6 lg:grid-cols-3">` and replace the whole block from this tag to the closing `</div>` before `</motion.div>`:

```typescript
<div className="space-y-6">
  {/* Members */}
  <motion.div variants={item}>
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Учасники команди
          <Badge variant="outline" className="ml-auto">
            {team.members.length}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {visibleOrderedRoles.map((role) => (
          <div key={role} className="space-y-3">
            <h3 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Badge variant={ROLE_VARIANT[role] ?? 'junior'} className="text-[10px]">
                {ROLE_LABELS[role] ?? role}
              </Badge>
              <span className="text-xs">({visibleMembersByRole[role]!.length})</span>
            </h3>
            <div className="grid gap-2 sm:grid-cols-2">
              {visibleMembersByRole[role]!.map((member) => (
                <motion.div
                  key={member.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-card/50 p-3"
                  whileHover={{ scale: 1.01 }}
                  transition={{ duration: 0.15 }}
                >
                  <Link
                    to="/crm/users/$userId"
                    params={{ userId: member.userId }}
                    className="flex min-w-0 flex-1 items-center gap-3 hover:opacity-80 transition-opacity"
                  >
                    <Avatar className="h-9 w-9 shrink-0">
                      {member.avatar && <AvatarImage src={member.avatar} alt={member.displayName} />}
                      <AvatarFallback className="text-xs">{getInitials(member.displayName)}</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium leading-tight">{member.displayName}</p>
                      <p className="truncate text-xs text-muted-foreground mt-0.5">{member.email}</p>
                      {member.techStack && (
                        <Badge variant="outline" className="mt-1 text-[9px] px-1.5 py-0 font-mono">
                          {member.techStack}
                        </Badge>
                      )}
                    </div>
                  </Link>
                  {canManage && (() => {
                    const isSenior = member.role === 'SENIOR'
                    const isJunior = member.role === 'JUNIOR'
                    const isLastHr = member.role === 'HR' && membersByRole.HR && membersByRole.HR.length <= 1
                    const isLastAccountant = member.role === 'ACCOUNTANT' && membersByRole.ACCOUNTANT && membersByRole.ACCOUNTANT.length <= 1
                    const isSelf = member.userId === user?.id
                    const canRemove = !isSenior && !isJunior && !isLastHr && !isLastAccountant &&
                      (user?.role === 'ADMIN' ? true : isSelf)
                    return canRemove ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                        title="Виключити"
                        onClick={() => removeMemberMutation.mutate(member.userId)}
                      >
                        <UserMinus className="h-3.5 w-3.5" />
                      </Button>
                    ) : null
                  })()}
                </motion.div>
              ))}
            </div>
          </div>
        ))}
        {team.members.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <p className="mt-3 text-sm font-medium">Немає учасників</p>
          </div>
        )}
      </CardContent>
    </Card>
  </motion.div>

  {/* Active Projects */}
  <motion.div variants={item}>
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Briefcase className="h-5 w-5" />
          Активні проекти
          {visibleProjects.length > 0 && (
            <Badge className="ml-auto bg-emerald-500/15 text-emerald-400 border-emerald-500/25 hover:bg-emerald-500/20">
              {visibleProjects.length}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {visibleProjects.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">Немає активних проектів</p>
        ) : (
          <div className="space-y-2">
            {visibleProjects.map((project) => (
              <Link
                key={project.id}
                to="/crm/projects/$projectId"
                params={{ projectId: project.id }}
                className="flex items-center gap-3 rounded-lg border border-border/60 bg-card/50 p-3 transition-all hover:border-primary/30 hover:bg-card"
              >
                <Avatar className="h-8 w-8 rounded-md shrink-0">
                  {project.logoUrl && <AvatarImage src={project.logoUrl} alt={project.name} />}
                  <AvatarFallback className="rounded-md text-xs">
                    {project.companyName.slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{project.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{project.companyName}</p>
                </div>
                <Badge className="shrink-0 bg-emerald-500/15 text-emerald-400 border-emerald-500/25 text-[10px]">
                  Active
                </Badge>
              </Link>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  </motion.div>
</div>
```

- [ ] **Step 4.11: Add the team edit dialog**

Before the closing `</motion.div>` of the main component add:

```typescript
{/* Edit Team Dialog */}
<Dialog open={showEdit} onOpenChange={setShowEdit}>
  <CrmDialogContent>
    <CrmDialogHeader>
      <DialogTitle>Редагувати команду</DialogTitle>
    </CrmDialogHeader>
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void editForm.handleSubmit()
      }}
    >
      <CrmDialogBody className="space-y-4">
        <editForm.Field name="name">
          {(field) => (
            <div className="grid gap-1.5">
              <Label htmlFor="edit-name">
                Назва <span className="text-destructive">*</span>
              </Label>
              <Input
                id="edit-name"
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                placeholder="Назва команди"
              />
              {field.state.meta.errors[0] && (
                <p className="text-xs text-destructive">{field.state.meta.errors[0]}</p>
              )}
            </div>
          )}
        </editForm.Field>
        <editForm.Field name="telegram">
          {(field) => (
            <div className="grid gap-1.5">
              <Label htmlFor="edit-telegram">Telegram</Label>
              <Input
                id="edit-telegram"
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                placeholder="https://t.me/team_chat"
              />
              <p className="text-xs text-muted-foreground">Посилання на Telegram-чат команди</p>
            </div>
          )}
        </editForm.Field>
        <editForm.Field name="notes">
          {(field) => (
            <div className="grid gap-1.5">
              <Label htmlFor="edit-notes">Нотатки</Label>
              <textarea
                id="edit-notes"
                className="min-h-[80px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-none"
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                placeholder="Внутрішні нотатки…"
              />
            </div>
          )}
        </editForm.Field>
      </CrmDialogBody>
      <CrmDialogFooter>
        <Button type="button" variant="outline" onClick={() => setShowEdit(false)}>
          Скасувати
        </Button>
        <Button type="submit" disabled={updateMutation.isPending}>
          {updateMutation.isPending ? 'Збереження…' : 'Зберегти'}
        </Button>
      </CrmDialogFooter>
    </form>
  </CrmDialogContent>
</Dialog>
```

- [ ] **Step 4.12: Add the add-member dialog**

```typescript
{/* Add Member Dialog */}
<Dialog open={showAddMember} onOpenChange={(open) => { setShowAddMember(open); if (!open) setSelectedUserIds(new Set()) }}>
  <CrmDialogContent>
    <CrmDialogHeader>
      <DialogTitle>Додати учасника</DialogTitle>
    </CrmDialogHeader>
    <CrmDialogBody>
      <div className="space-y-1.5 max-h-80 overflow-y-auto pr-1">
        {candidateUsers.length === 0 && (
          <p className="py-4 text-center text-sm text-muted-foreground">Немає доступних користувачів</p>
        )}
        {candidateUsers.map((u, idx) => {
          const isDisabled = !!u.disabledReason
          const isSelected = selectedUserIds.has(u.id)
          const prevDisabled = idx > 0 && !!candidateUsers[idx - 1]?.disabledReason
          const showDivider = isDisabled && !prevDisabled && idx > 0
          return (
            <div key={u.id}>
              {showDivider && <div className="my-2 border-t border-border/50" />}
              <button
                type="button"
                disabled={isDisabled}
                onClick={() => {
                  if (isDisabled) return
                  setSelectedUserIds((prev) => {
                    const next = new Set(prev)
                    next.has(u.id) ? next.delete(u.id) : next.add(u.id)
                    return next
                  })
                }}
                className={cn(
                  'flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors',
                  isDisabled
                    ? 'cursor-not-allowed opacity-35'
                    : isSelected
                    ? 'bg-primary/10'
                    : 'hover:bg-muted/50',
                )}
              >
                {!isDisabled && (
                  <div className={cn(
                    'h-4 w-4 shrink-0 rounded border',
                    isSelected ? 'border-primary bg-primary flex items-center justify-center' : 'border-border',
                  )}>
                    {isSelected && <span className="text-[10px] text-primary-foreground font-bold">✓</span>}
                  </div>
                )}
                {isDisabled && <div className="h-4 w-4 shrink-0" />}
                <Avatar className="h-6 w-6 shrink-0">
                  {u.avatar && <AvatarImage src={u.avatar} alt={u.displayName} />}
                  <AvatarFallback className="text-[9px]">{getInitials(u.displayName)}</AvatarFallback>
                </Avatar>
                <span className="flex-1 truncate text-sm">{u.displayName}</span>
                <Badge variant="outline" className="text-[10px] shrink-0">
                  {ROLE_LABELS[u.role] ?? u.role}
                </Badge>
                {u.disabledReason && (
                  <span className="text-[10px] text-muted-foreground shrink-0">{u.disabledReason}</span>
                )}
              </button>
            </div>
          )
        })}
      </div>
    </CrmDialogBody>
    <CrmDialogFooter>
      <Button variant="outline" onClick={() => { setShowAddMember(false); setSelectedUserIds(new Set()) }}>
        Скасувати
      </Button>
      <Button
        disabled={selectedUserIds.size === 0 || addMemberMutation.isPending}
        onClick={() => void handleAddMembers()}
      >
        Додати{selectedUserIds.size > 0 ? ` (${selectedUserIds.size})` : ''}
      </Button>
    </CrmDialogFooter>
  </CrmDialogContent>
</Dialog>
```

- [ ] **Step 4.13: Remove the old stats sidebar**

Make sure the whole `{/* Sidebar - Team Stats */}` block (`<motion.div variants={item} className="space-y-4">` with the "Statistics" and "Activity" cards) is removed — it is replaced by the new structure in Step 4.10.

- [ ] **Step 4.14: Check in the browser**

Open http://localhost:3000/crm/team → click on a team.

Check:
- The heading + the "Add" and "Edit" buttons (for ADMIN/HR)
- SENIOR: sees all members and all projects, no buttons
- JUNIOR: sees Senior/HR/Accountant, other juniors hidden, only their own project
- Edit dialog: fields name, telegram, notes, saves
- Add dialog: an alphabetical list, disabled with an explanation, a checkbox, the "Add (N)" button

- [ ] **Step 4.15: Typecheck**

```bash
pnpm --filter @crm/web typecheck
```

Expected output: 0 errors.

- [ ] **Step 4.16: Commit**

```bash
git add apps/web/app/routes/crm/team/'$teamId.tsx'
git commit -m "feat(teams): redesign detail page — projects section, edit/add dialogs, RBAC views"
```
