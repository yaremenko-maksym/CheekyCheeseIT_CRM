# Team Page Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Полный рефактор страниц команды — добавить `telegramGroupUrl` на команду, вынести диалоги в компоненты, починить нерабочие кнопки на detail-странице, убрать дублирование кода, применить RBAC для JUNIOR.

**Architecture:** Backend получает новое поле `telegram_group_url` через миграцию + обновлённую shared-схему. Frontend разбивается на thin pages (index.tsx, $teamId.tsx) + 6 отдельных dialog-компонентов + 3 переиспользуемых компонента (TeamCard, MemberRow, team-constants). Управление участниками переезжает с list-карточек на detail-страницу.

**Tech Stack:** NestJS 11, Drizzle ORM, PostgreSQL, React, TanStack Query, TanStack Form, Zod v4, shadcn/ui, Framer Motion, Vitest.

**Spec:** `docs/superpowers/specs/2026-05-17-team-page-refactor-design.md`

---

## File Map

### New Files
```
apps/api/drizzle/migrations/0012_<generated_name>.sql
apps/web/app/lib/team-constants.ts
apps/web/app/routes/crm/team/components/TeamCard.tsx
apps/web/app/routes/crm/team/components/MemberRow.tsx
apps/web/app/routes/crm/team/components/DeleteTeamDialog.tsx
apps/web/app/routes/crm/team/components/EditTeamDialog.tsx
apps/web/app/routes/crm/team/components/AddMemberDialog.tsx
apps/web/app/routes/crm/team/components/CreateSeniorDialog.tsx
```

### Modified Files
```
apps/api/src/database/schema.ts                  ← add telegramGroupUrl to teams table
apps/api/src/teams/teams.service.ts              ← mapTeam + update() accept telegramGroupUrl
apps/api/src/teams/teams.service.spec.ts         ← add update + mapTeam tests
apps/api/src/teams/teams.controller.ts           ← pass full dto to service.update()
packages/shared/src/schemas/teams.ts             ← telegramGroupUrl in updateTeamSchema + teamSchema
packages/shared/src/schemas/teams.spec.ts        ← extend updateTeamSchema + teamSchema tests
apps/web/app/routes/crm/team/index.tsx           ← thin page: grid + CreateSenior + DeleteTeam only
apps/web/app/routes/crm/team/$teamId.tsx         ← full detail page using new components
```

---

### Task 1: DB + Drizzle Schema

**Files:**
- Modify: `apps/api/src/database/schema.ts:89-94`
- Create: `apps/api/drizzle/migrations/0012_<generated>.sql` (via drizzle-kit)

- [ ] **Step 1: Add `telegramGroupUrl` to the teams table in `schema.ts`**

Replace lines 89–94 in `apps/api/src/database/schema.ts`:

```ts
export const teams = pgTable('teams', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  telegramGroupUrl: text('telegram_group_url'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})
```

- [ ] **Step 2: Generate the migration**

```bash
pnpm --filter @crm/api drizzle-kit generate
```

Expected: a new file `apps/api/drizzle/migrations/0012_*.sql` containing:
```sql
ALTER TABLE "teams" ADD COLUMN "telegram_group_url" text;
```

- [ ] **Step 3: Apply the migration**

```bash
pnpm --filter @crm/api drizzle-kit migrate
```

Expected: `✓ Migrations applied` with no errors.

- [ ] **Step 4: Verify with postgres MCP**

```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'teams'
ORDER BY ordinal_position;
```

Expected: row `telegram_group_url | text | YES` is present.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/database/schema.ts apps/api/drizzle/
git commit -m "feat(teams): add telegram_group_url column (migration 0012)"
```

---

### Task 2: Shared Schema — telegramGroupUrl

**Files:**
- Modify: `packages/shared/src/schemas/teams.ts`
- Modify: `packages/shared/src/schemas/teams.spec.ts`

- [ ] **Step 1: Add failing tests**

In `packages/shared/src/schemas/teams.spec.ts`, after the existing `updateTeamSchema` tests, add:

```ts
describe('updateTeamSchema — telegramGroupUrl', () => {
  const base = { name: 'My Team' }

  it('accepts valid telegram URL', () => {
    expect(() => updateTeamSchema.parse({ ...base, telegramGroupUrl: 'https://t.me/mygroup' })).not.toThrow()
  })

  it('accepts null telegramGroupUrl', () => {
    expect(() => updateTeamSchema.parse({ ...base, telegramGroupUrl: null })).not.toThrow()
  })

  it('accepts missing telegramGroupUrl', () => {
    expect(() => updateTeamSchema.parse(base)).not.toThrow()
  })

  it('rejects invalid URL', () => {
    expect(() => updateTeamSchema.parse({ ...base, telegramGroupUrl: 'not-a-url' })).toThrow()
  })
})

describe('teamSchema — telegramGroupUrl', () => {
  const validTeam = {
    id: '123e4567-e89b-12d3-a456-426614174000',
    name: 'My Team',
    telegramGroupUrl: 'https://t.me/mygroup',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    members: [],
  }

  it('accepts teamSchema with telegramGroupUrl', () => {
    expect(() => teamSchema.parse(validTeam)).not.toThrow()
  })

  it('accepts teamSchema with null telegramGroupUrl', () => {
    expect(() => teamSchema.parse({ ...validTeam, telegramGroupUrl: null })).not.toThrow()
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pnpm --filter @crm/shared test
```

Expected: `FAIL packages/shared/src/schemas/teams.spec.ts` — tests referencing `telegramGroupUrl` fail.

- [ ] **Step 3: Update `packages/shared/src/schemas/teams.ts`**

```ts
import { z } from 'zod'

export const teamMemberSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  displayName: z.string(),
  email: z.string().email(),
  avatar: z.string().url().nullable(),
  role: z.enum(['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT']),
  techStack: z.string().nullable(),
  joinedAt: z.string().or(z.date()),
})

export const teamSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  telegramGroupUrl: z.string().url().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  members: z.array(teamMemberSchema),
})

export const createTeamSchema = z.object({
  name: z.string().min(1).max(255),
  seniorId: z.string().uuid(),
  hrIds: z.array(z.string().uuid()).min(1),
  accountantId: z.string().uuid().nullable(),
})

export const updateTeamSchema = z.object({
  name: z.string().min(1).max(255),
  telegramGroupUrl: z.string().url().optional().nullable(),
})

export const addTeamMemberSchema = z.object({
  userId: z.string().uuid(),
})

export type TeamMemberDto = z.infer<typeof teamMemberSchema>
export type TeamDto = z.infer<typeof teamSchema>
export type CreateTeamDto = z.infer<typeof createTeamSchema>
export type UpdateTeamDto = z.infer<typeof updateTeamSchema>
export type AddTeamMemberDto = z.infer<typeof addTeamMemberSchema>
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @crm/shared test
```

Expected: `Test Files 3 passed (3)` — all 20+ tests green.

- [ ] **Step 5: Typecheck shared**

```bash
pnpm --filter @crm/shared typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/
git commit -m "feat(shared/teams): add telegramGroupUrl to teamSchema + updateTeamSchema"
```

---

### Task 3: Backend Service + Controller

**Files:**
- Modify: `apps/api/src/teams/teams.service.ts`
- Modify: `apps/api/src/teams/teams.service.spec.ts`
- Modify: `apps/api/src/teams/teams.controller.ts`

- [ ] **Step 1: Add failing tests for `update` with `telegramGroupUrl`**

In `apps/api/src/teams/teams.service.spec.ts`, find the `makeTeam` factory and add `telegramGroupUrl: null` to it:

```ts
const makeTeam = (overrides: Record<string, unknown> = {}) => ({
  id: 'team-1',
  name: 'Team Alpha',
  telegramGroupUrl: null as string | null,
  hrId: 'hr-1',
  members: [] as ReturnType<typeof makeMember>[],
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
})
```

Then add a new `describe` block for `update` with telegramGroupUrl:

```ts
describe('update — telegramGroupUrl', () => {
  it('saves telegramGroupUrl when provided', async () => {
    const team = makeTeam({ members: [makeMember('hr-1', 'HR')] })
    const db = makeDb({ team })
    db.db.update = vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ ...team, telegramGroupUrl: 'https://t.me/grp' }]),
        }),
      }),
    })
    const svc = new TeamsService(db as unknown as DrizzleDb)
    const result = await svc.update('team-1', { name: 'Team Alpha', telegramGroupUrl: 'https://t.me/grp' }, adminUser)
    expect(result).toMatchObject({ telegramGroupUrl: 'https://t.me/grp' })
  })

  it('clears telegramGroupUrl when null is passed', async () => {
    const team = makeTeam({ members: [makeMember('hr-1', 'HR')], telegramGroupUrl: 'https://t.me/old' })
    const db = makeDb({ team })
    db.db.update = vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ ...team, telegramGroupUrl: null }]),
        }),
      }),
    })
    const svc = new TeamsService(db as unknown as DrizzleDb)
    const result = await svc.update('team-1', { name: 'Team Alpha', telegramGroupUrl: null }, adminUser)
    expect(result).toMatchObject({ telegramGroupUrl: null })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter @crm/api test
```

Expected: new tests fail with type errors or runtime failures.

- [ ] **Step 3: Update `mapTeam` in `teams.service.ts`**

Find the `return {` block in `mapTeam` (around line 76) and add `telegramGroupUrl`:

```ts
return {
  id: team.id,
  name: team.name,
  telegramGroupUrl: team.telegramGroupUrl ?? null,
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

- [ ] **Step 4: Update `update()` method signature and body in `teams.service.ts`**

Replace the `async update(...)` method:

```ts
async update(id: string, dto: { name: string; telegramGroupUrl?: string | null }, currentUser: SessionUser) {
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
    .set({ name: dto.name, telegramGroupUrl: dto.telegramGroupUrl ?? null, updatedAt: new Date() })
    .where(eq(teams.id, id))
    .returning()

  return updated
}
```

- [ ] **Step 5: Update `teams.controller.ts`**

Replace the `@Patch(':id')` handler:

```ts
@Patch(':id')
update(
  @Param('id', ParseUUIDPipe) id: string,
  @Body() body: unknown,
  @CurrentUser() user: SessionUser,
) {
  const dto = updateTeamSchema.parse(body)
  return this.teamsService.update(id, dto, user)
}
```

- [ ] **Step 6: Run tests**

```bash
pnpm --filter @crm/api test
```

Expected: `Test Files 4 passed (4)` — all 74+ tests green.

- [ ] **Step 7: Typecheck**

```bash
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/teams/
git commit -m "feat(teams): telegramGroupUrl in service + controller update"
```

---

### Task 4: team-constants.ts

**Files:**
- Create: `apps/web/app/lib/team-constants.ts`

- [ ] **Step 1: Create `apps/web/app/lib/team-constants.ts`**

```ts
export const ROLE_LABELS: Record<string, string> = {
  ADMIN: 'Администратор',
  SENIOR: 'Синьор',
  JUNIOR: 'Джун',
  HR: 'HR',
  ACCOUNTANT: 'Бухгалтер',
}

export const ROLE_VARIANT: Record<string, 'admin' | 'senior' | 'junior' | 'hr' | 'accountant'> = {
  ADMIN: 'admin',
  SENIOR: 'senior',
  JUNIOR: 'junior',
  HR: 'hr',
  ACCOUNTANT: 'accountant',
}

export function getInitials(name: string): string {
  return (name || '?')
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

export const ROLE_ORDER = ['SENIOR', 'HR', 'ACCOUNTANT', 'JUNIOR'] as const

export const TECH_STACK_OPTIONS = [
  'JavaScript FE', 'JavaScript BE', 'TypeScript FE', 'TypeScript BE',
  'Python', 'Java', 'Kotlin', 'Swift', 'Go', 'PHP', 'Ruby', 'C#', 'C++',
  'Rust', 'Flutter/Dart', 'React Native',
] as const
```

- [ ] **Step 2: Run typecheck**

```bash
pnpm --filter @crm/web typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/lib/team-constants.ts
git commit -m "feat(web/team): extract shared team constants to team-constants.ts"
```

---

### Task 5: DeleteTeamDialog

**Files:**
- Create: `apps/web/app/routes/crm/team/components/DeleteTeamDialog.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { TeamDto } from '@crm/shared'
import { api } from '@/lib/axios'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  CrmDialogContent,
  CrmDialogHeader,
  CrmDialogBody,
  CrmDialogFooter,
  DialogTitle,
} from '@/components/ui/crm-dialog'

export function DeleteTeamDialog({
  team,
  onClose,
}: {
  team: TeamDto | null
  onClose: () => void
}) {
  const queryClient = useQueryClient()

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/teams/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['teams'] })
      void queryClient.invalidateQueries({ queryKey: ['projects'] })
      onClose()
    },
  })

  return (
    <Dialog open={!!team} onOpenChange={(open) => !open && onClose()}>
      <CrmDialogContent maxWidth="sm:max-w-sm">
        <CrmDialogHeader>
          <DialogTitle>Удалить команду «{team?.name}»?</DialogTitle>
        </CrmDialogHeader>
        <CrmDialogBody className="pb-2">
          <p className="text-sm text-muted-foreground">
            Вместе с командой будут удалены её синьор и все его проекты. Это действие нельзя отменить.
          </p>
        </CrmDialogBody>
        <CrmDialogFooter>
          <Button variant="outline" onClick={onClose}>Отмена</Button>
          <Button
            variant="destructive"
            onClick={() => team && deleteMutation.mutate(team.id)}
            disabled={deleteMutation.isPending}
          >
            Удалить
          </Button>
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @crm/web typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/routes/crm/team/components/DeleteTeamDialog.tsx
git commit -m "feat(web/team): extract DeleteTeamDialog component"
```

---

### Task 6: EditTeamDialog

**Files:**
- Create: `apps/web/app/routes/crm/team/components/EditTeamDialog.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { useForm } from '@tanstack/react-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import type { TeamDto } from '@crm/shared'
import { api } from '@/lib/axios'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
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

const teamNameSchema = z.string().min(1, 'Обязательное поле').max(255, 'Максимум 255 символов')
const telegramUrlSchema = z
  .string()
  .url('Введите корректный URL')
  .optional()
  .or(z.literal(''))

export function EditTeamDialog({
  team,
  onClose,
}: {
  team: TeamDto | null
  onClose: () => void
}) {
  const queryClient = useQueryClient()

  const updateMutation = useMutation({
    mutationFn: ({ id, name, telegramGroupUrl }: { id: string; name: string; telegramGroupUrl: string | null }) =>
      api.patch(`/teams/${id}`, { name, telegramGroupUrl }),
    onSuccess: (_, vars) => {
      void queryClient.invalidateQueries({ queryKey: ['teams'] })
      void queryClient.invalidateQueries({ queryKey: ['team', vars.id] })
      onClose()
    },
  })

  const form = useForm({
    defaultValues: {
      name: team?.name ?? '',
      telegramGroupUrl: team?.telegramGroupUrl ?? '',
    },
    onSubmit: async ({ value }) => {
      if (!team) return
      updateMutation.mutate({
        id: team.id,
        name: value.name.trim(),
        telegramGroupUrl: value.telegramGroupUrl.trim() || null,
      })
    },
  })

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      form.reset()
      onClose()
    }
  }

  // Re-sync form when a different team is opened
  useEffect(() => {
    if (!team) return
    form.setFieldValue('name', team.name)
    form.setFieldValue('telegramGroupUrl', team.telegramGroupUrl ?? '')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [team?.id])

  return (
    <Dialog open={!!team} onOpenChange={handleOpenChange}>
      <CrmDialogContent maxWidth="sm:max-w-sm">
        <CrmDialogHeader>
          <DialogTitle>Редактировать команду</DialogTitle>
        </CrmDialogHeader>
        <CrmDialogBody className="pb-2">
          <div className="space-y-4">
            {/* Name */}
            <form.Field
              name="name"
              validators={{
                onBlur: ({ value }) => {
                  const r = teamNameSchema.safeParse(value.trim())
                  return r.success ? undefined : r.error.issues[0]?.message
                },
              }}
            >
              {(field) => {
                const err = field.state.meta.isTouched ? (field.state.meta.errors[0] as string | undefined) : undefined
                return (
                  <div className="grid gap-1.5">
                    <Label className={cn(err && 'text-destructive')}>
                      Название <span className="text-destructive">*</span>
                    </Label>
                    <Input
                      value={field.state.value}
                      onChange={(e) => field.handleChange(e.target.value)}
                      onBlur={field.handleBlur}
                      placeholder="Название команды"
                      className={cn(err && 'border-destructive focus-visible:ring-destructive/30')}
                      onKeyDown={(e) => { if (e.key === 'Enter') void form.handleSubmit() }}
                    />
                    {err && <p className="text-xs text-destructive">{err}</p>}
                  </div>
                )
              }}
            </form.Field>

            {/* Telegram Group URL */}
            <form.Field
              name="telegramGroupUrl"
              validators={{
                onBlur: ({ value }) => {
                  if (!value.trim()) return undefined
                  const r = telegramUrlSchema.safeParse(value.trim())
                  return r.success ? undefined : r.error.issues[0]?.message
                },
              }}
            >
              {(field) => {
                const err = field.state.meta.isTouched ? (field.state.meta.errors[0] as string | undefined) : undefined
                return (
                  <div className="grid gap-1.5">
                    <Label className={cn(err && 'text-destructive')}>Telegram группа</Label>
                    <Input
                      value={field.state.value}
                      onChange={(e) => field.handleChange(e.target.value)}
                      onBlur={field.handleBlur}
                      placeholder="https://t.me/mygroup"
                      className={cn(err && 'border-destructive focus-visible:ring-destructive/30')}
                    />
                    {err && <p className="text-xs text-destructive">{err}</p>}
                  </div>
                )
              }}
            </form.Field>
          </div>
        </CrmDialogBody>
        <CrmDialogFooter>
          <Button variant="outline" onClick={() => { form.reset(); onClose() }}>Отмена</Button>
          <Button onClick={() => void form.handleSubmit()} disabled={updateMutation.isPending}>
            {updateMutation.isPending ? 'Сохранение...' : 'Сохранить'}
          </Button>
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @crm/web typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/routes/crm/team/components/EditTeamDialog.tsx
git commit -m "feat(web/team): EditTeamDialog with name + telegramGroupUrl"
```

---

### Task 7: AddMemberDialog

**Files:**
- Create: `apps/web/app/routes/crm/team/components/AddMemberDialog.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { TeamDto } from '@crm/shared'
import { api } from '@/lib/axios'
import { cn } from '@/lib/utils'
import { ROLE_LABELS, ROLE_VARIANT, getInitials } from '@/lib/team-constants'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  CrmDialogContent,
  CrmDialogHeader,
  CrmDialogBody,
  CrmDialogFooter,
  DialogTitle,
} from '@/components/ui/crm-dialog'
import { Label } from '@/components/ui/label'

type UserOption = { id: string; displayName: string; email: string; role: string; avatar: string | null }

async function fetchAllUsers(): Promise<UserOption[]> {
  const res = await api.get<UserOption[]>('/users')
  return res.data
}

export function AddMemberDialog({
  team,
  onClose,
}: {
  team: TeamDto | null
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [selectedUserId, setSelectedUserId] = useState('')

  const { data: allUsers } = useQuery({
    queryKey: ['users'],
    queryFn: fetchAllUsers,
    enabled: !!team,
  })

  const availableUsers = useMemo(
    () => (allUsers ?? []).filter((u) => !team?.members.some((m) => m.userId === u.id)),
    [allUsers, team],
  )

  const addMutation = useMutation({
    mutationFn: ({ teamId, userId }: { teamId: string; userId: string }) =>
      api.post(`/teams/${teamId}/members`, { userId }),
    onSuccess: (_, vars) => {
      void queryClient.invalidateQueries({ queryKey: ['teams'] })
      void queryClient.invalidateQueries({ queryKey: ['team', vars.teamId] })
      setSelectedUserId('')
      onClose()
    },
  })

  const handleClose = () => {
    setSelectedUserId('')
    onClose()
  }

  return (
    <Dialog open={!!team} onOpenChange={(open) => !open && handleClose()}>
      <CrmDialogContent maxWidth="sm:max-w-sm">
        <CrmDialogHeader>
          <DialogTitle>Добавить участника — {team?.name}</DialogTitle>
        </CrmDialogHeader>
        <CrmDialogBody className="pb-2">
          <div className="space-y-3">
            <Label>Выберите сотрудника</Label>
            <div className="space-y-1">
              {availableUsers.length === 0 && (
                <p className="text-sm text-muted-foreground">Все сотрудники уже в команде</p>
              )}
              {availableUsers.map((u) => (
                <button
                  key={u.id}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left transition-colors hover:bg-accent',
                    selectedUserId === u.id && 'bg-accent',
                  )}
                  onClick={() => setSelectedUserId(u.id)}
                >
                  <Avatar className="h-7 w-7 shrink-0">
                    {u.avatar && <AvatarImage src={u.avatar} />}
                    <AvatarFallback className="text-[10px]">{getInitials(u.displayName)}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{u.displayName}</p>
                    <p className="truncate text-xs text-muted-foreground">{u.email}</p>
                  </div>
                  <Badge variant={ROLE_VARIANT[u.role] ?? 'junior'} className="shrink-0 text-[10px]">
                    {ROLE_LABELS[u.role] ?? u.role}
                  </Badge>
                </button>
              ))}
            </div>
          </div>
        </CrmDialogBody>
        <CrmDialogFooter>
          <Button variant="outline" onClick={handleClose}>Отмена</Button>
          <Button
            onClick={() => {
              if (team && selectedUserId) {
                addMutation.mutate({ teamId: team.id, userId: selectedUserId })
              }
            }}
            disabled={!selectedUserId || addMutation.isPending}
          >
            Добавить
          </Button>
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @crm/web typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/routes/crm/team/components/AddMemberDialog.tsx
git commit -m "feat(web/team): AddMemberDialog with wired mutation"
```

---

### Task 8: CreateSeniorDialog

**Files:**
- Create: `apps/web/app/routes/crm/team/components/CreateSeniorDialog.tsx`

- [ ] **Step 1: Create the component**

Cut the `HrCreateSeniorDialog` function (lines 203–503) from `apps/web/app/routes/crm/team/index.tsx` and save as a new file, changing the function name and export:

```tsx
import { useEffect, useMemo, useState } from 'react'
import { useForm } from '@tanstack/react-form'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { isValidPhoneNumber } from 'react-phone-number-input'
import type { Value as PhoneValue } from 'react-phone-number-input'
import { z } from 'zod'
import type { AxiosError } from 'axios'
import type { CreateUserDto, UserProfileDto } from '@crm/shared'
import { createUserSchema, updateProfileSchema } from '@crm/shared'
import { api } from '@/lib/axios'
import { cn } from '@/lib/utils'
import { TECH_STACK_OPTIONS } from '@/lib/team-constants'
import { Button } from '@/components/ui/button'
import { Check, UserPlus } from 'lucide-react'
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
import { PhoneInput } from '@/components/ui/phone-input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { toast } from 'sonner'
import { getInitials } from '@/lib/team-constants'

type UserOption = { id: string; displayName: string; email: string; role: string; avatar: string | null }

async function fetchAllUsers(): Promise<UserOption[]> {
  const res = await api.get<UserOption[]>('/users')
  return res.data
}

const telegramFieldSchema = updateProfileSchema.shape.telegram.unwrap().unwrap()
const phoneFieldSchema = z.string().max(30)

function normalizeTelegram(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  return trimmed.startsWith('@') ? trimmed : `@${trimmed}`
}

function ShareSlider({
  value,
  onChange,
  onBlur,
  seniorPct,
  error,
}: {
  value: number
  onChange: (v: number) => void
  onBlur?: () => void
  seniorPct: number
  error?: boolean
}) {
  return (
    <div className="space-y-3">
      <div className="relative h-7 rounded-md overflow-hidden flex text-[11px] font-medium select-none">
        <div
          className="flex items-center justify-center bg-primary/20 text-primary transition-all duration-150"
          style={{ width: `${value}%` }}
        >
          {value >= 12 ? `${value}% компания` : ''}
        </div>
        <div
          className="flex items-center justify-center bg-emerald-500/20 text-emerald-400 transition-all duration-150"
          style={{ width: `${seniorPct}%` }}
        >
          {seniorPct >= 12 ? `${seniorPct}% синьор` : ''}
        </div>
      </div>
      <div className="flex items-center gap-3">
        <input
          type="range" min={1} max={100} step={1} value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          onBlur={onBlur}
          className="flex-1 h-2 accent-primary cursor-pointer"
        />
        <input
          type="number" min={1} max={100} value={value}
          onChange={(e) => { const n = Math.min(100, Math.max(1, Number(e.target.value))); onChange(n) }}
          onBlur={onBlur}
          className={cn(
            'w-16 rounded-md border border-input bg-background px-2 py-1 text-sm text-center [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none',
            error && 'border-destructive',
          )}
        />
      </div>
    </div>
  )
}

function Field({ label, error, required, children }: {
  label: string; error?: string; required?: boolean; children: React.ReactNode
}) {
  return (
    <div className="grid gap-1.5">
      <Label className={cn(error && 'text-destructive')}>
        {label}{required && <span className="ml-0.5 text-destructive">*</span>}
      </Label>
      {children}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

export function CreateSeniorDialog({
  open,
  hrUserId,
  onClose,
}: {
  open: boolean
  hrUserId: string
  onClose: () => void
}) {
  const queryClient = useQueryClient()

  const { data: allUsers } = useQuery({
    queryKey: ['users'],
    queryFn: fetchAllUsers,
    enabled: open,
  })

  const accountantUsers = useMemo(
    () => (allUsers ?? []).filter((u) => u.role === 'ACCOUNTANT'),
    [allUsers],
  )

  const [selectedAccountantId, setSelectedAccountantId] = useState('')

  useEffect(() => {
    if (!open) return
    setSelectedAccountantId(
      accountantUsers.length === 1 && accountantUsers[0] ? accountantUsers[0].id : '',
    )
  }, [open, accountantUsers])

  const mutation = useMutation({
    mutationFn: (data: CreateUserDto) => api.post<UserProfileDto>('/users', data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['teams'] })
      void queryClient.invalidateQueries({ queryKey: ['users'] })
      toast.success('Синьор создан, команда сформирована')
      onClose()
      form.reset()
    },
    onError: (err: AxiosError<{ message: string }>) => {
      toast.error(err?.response?.data?.message ?? 'Ошибка при создании')
    },
  })

  const form = useForm({
    defaultValues: {
      email: '',
      displayName: '',
      telegram: '',
      phone: '' as PhoneValue | '',
      techStack: '',
      seniorSharePercent: 26 as number,
    },
    onSubmit: async ({ value }) => {
      const payload: CreateUserDto = {
        email: value.email.trim(),
        displayName: value.displayName.trim(),
        role: 'SENIOR',
        telegram: value.telegram.trim() ? normalizeTelegram(value.telegram) : undefined,
        phone: (value.phone as string) || undefined,
        techStack: value.techStack.trim() || undefined,
        seniorSharePercent: value.seniorSharePercent,
        hrIds: [hrUserId],
        accountantId: selectedAccountantId || null,
      }
      const result = createUserSchema.safeParse(payload)
      if (!result.success) { toast.error('Ошибка валидации данных'); return }
      mutation.mutate(result.data)
    },
  })

  const handleClose = () => { form.reset(); setSelectedAccountantId(''); onClose() }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <CrmDialogContent maxWidth="sm:max-w-md">
        <CrmDialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-4 w-4" />
            Создать синьора
          </DialogTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Будет создан аккаунт синьора и сформирована команда с вами в роли HR.
          </p>
        </CrmDialogHeader>
        <CrmDialogBody>
          <div className="grid gap-4 py-2">
            <form.Field name="email" validators={{ onBlur: ({ value }) => { const r = createUserSchema.shape.email.safeParse(value.trim()); return r.success ? undefined : r.error.issues[0]?.message } }}>
              {(field) => { const err = field.state.meta.isTouched ? (field.state.meta.errors[0] as string | undefined) : undefined; return (<Field label="Email" error={err} required><Input placeholder="senior@cheekycheese.dev" value={field.state.value} onChange={(e) => field.handleChange(e.target.value)} onBlur={field.handleBlur} className={cn(err && 'border-destructive focus-visible:ring-destructive/30')} autoComplete="off" /></Field>) }}
            </form.Field>
            <form.Field name="displayName" validators={{ onBlur: ({ value }) => { const r = createUserSchema.shape.displayName.safeParse(value.trim()); return r.success ? undefined : r.error.issues[0]?.message } }}>
              {(field) => { const err = field.state.meta.isTouched ? (field.state.meta.errors[0] as string | undefined) : undefined; return (<Field label="Имя и фамилия" error={err} required><Input placeholder="Иван Иванов" value={field.state.value} onChange={(e) => field.handleChange(e.target.value)} onBlur={field.handleBlur} className={cn(err && 'border-destructive focus-visible:ring-destructive/30')} /></Field>) }}
            </form.Field>
            <form.Field name="techStack">
              {(field) => (<Field label="Технологии"><Input placeholder="JavaScript FE, Java..." value={field.state.value} onChange={(e) => field.handleChange(e.target.value)} onBlur={field.handleBlur} list="create-senior-tech-suggestions" /><datalist id="create-senior-tech-suggestions">{TECH_STACK_OPTIONS.map((opt) => (<option key={opt} value={opt} />))}</datalist></Field>)}
            </form.Field>
            <form.Field name="telegram" validators={{ onBlur: ({ value }) => { if (!value.trim()) return undefined; const r = telegramFieldSchema.safeParse(value.trim()); return r.success ? undefined : r.error.issues[0]?.message } }}>
              {(field) => { const err = field.state.meta.isTouched ? (field.state.meta.errors[0] as string | undefined) : undefined; return (<Field label="Telegram" error={err}><Input placeholder="@username" value={field.state.value} onChange={(e) => field.handleChange(e.target.value)} onBlur={field.handleBlur} className={cn(err && 'border-destructive focus-visible:ring-destructive/30')} /></Field>) }}
            </form.Field>
            <form.Field name="phone" validators={{ onBlur: ({ value }) => { const v = value as string; if (!v) return undefined; const r = phoneFieldSchema.safeParse(v); if (!r.success) return r.error.issues[0]?.message; if (!isValidPhoneNumber(v)) return 'Некорректный номер'; return undefined } }}>
              {(field) => { const err = field.state.meta.isTouched ? (field.state.meta.errors[0] as string | undefined) : undefined; return (<Field label="Телефон" error={err}><PhoneInput value={field.state.value as PhoneValue | undefined} onChange={(v) => field.handleChange((v ?? '') as PhoneValue | '')} onBlur={field.handleBlur} className={cn(err && '[&_input]:border-destructive')} /></Field>) }}
            </form.Field>
            <div className="rounded-md border border-border/60 bg-muted/20 p-3 space-y-3">
              <p className="text-xs font-medium text-muted-foreground">Финансы и команда</p>
              <form.Field name="seniorSharePercent" validators={{ onBlur: ({ value }) => { if (value < 1 || value > 100) return 'Введите от 1 до 100'; return undefined } }}>
                {(field) => { const val = field.state.value ?? 26; const seniorPct = 100 - val; const err = field.state.meta.isTouched ? (field.state.meta.errors[0] as string | undefined) : undefined; return (<Field label="Доля компании (%)" error={err} required><ShareSlider value={val} onChange={(v) => field.handleChange(v)} onBlur={field.handleBlur} seniorPct={seniorPct} error={!!err} /></Field>) }}
              </form.Field>
              <Field label="HR">
                <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
                  <Check className="h-3.5 w-3.5 text-green-500 shrink-0" /><span>Вы</span><span className="text-xs text-muted-foreground ml-auto">авто</span>
                </div>
              </Field>
              <Field label="Бухгалтер">
                {accountantUsers.length === 0 ? (<p className="text-xs text-muted-foreground italic">Нет доступных бухгалтеров</p>)
                  : accountantUsers.length === 1 ? (<div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm"><Check className="h-3.5 w-3.5 text-green-500 shrink-0" /><span>{accountantUsers[0]!.displayName}</span><span className="text-xs text-muted-foreground ml-auto">авто</span></div>)
                  : (<Select value={selectedAccountantId} onValueChange={setSelectedAccountantId}><SelectTrigger><SelectValue placeholder="— выберите бухгалтера —" /></SelectTrigger><SelectContent>{accountantUsers.map((u) => (<SelectItem key={u.id} value={u.id}>{u.displayName}</SelectItem>))}</SelectContent></Select>)
                }
              </Field>
            </div>
          </div>
        </CrmDialogBody>
        <CrmDialogFooter>
          <Button variant="ghost" onClick={handleClose}>Отмена</Button>
          <Button onClick={() => void form.handleSubmit()} disabled={mutation.isPending}>
            {mutation.isPending ? 'Создание...' : 'Создать'}
          </Button>
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @crm/web typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/routes/crm/team/components/CreateSeniorDialog.tsx
git commit -m "feat(web/team): extract CreateSeniorDialog component"
```

---

### Task 9: MemberRow

**Files:**
- Create: `apps/web/app/routes/crm/team/components/MemberRow.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { Link } from '@tanstack/react-router'
import { UserMinus } from 'lucide-react'
import { motion } from 'framer-motion'
import type { TeamMemberDto } from '@crm/shared'
import { ROLE_LABELS, ROLE_VARIANT, getInitials } from '@/lib/team-constants'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

export function MemberRow({
  member,
  canRemove,
  onRemove,
}: {
  member: TeamMemberDto
  canRemove: boolean
  onRemove: (userId: string) => void
}) {
  return (
    <motion.div
      className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-card/50 p-3"
      whileHover={{ scale: 1.005 }}
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
            <div className="mt-1">
              <Badge variant="outline" className="text-[9px] px-1.5 py-0 font-mono">
                {member.techStack}
              </Badge>
            </div>
          )}
        </div>
        <Badge variant={ROLE_VARIANT[member.role] ?? 'junior'} className="shrink-0 text-[10px]">
          {ROLE_LABELS[member.role] ?? member.role}
        </Badge>
      </Link>
      {canRemove && (
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
          title="Исключить из команды"
          onClick={() => onRemove(member.userId)}
        >
          <UserMinus className="h-3.5 w-3.5" />
        </Button>
      )}
    </motion.div>
  )
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @crm/web typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/routes/crm/team/components/MemberRow.tsx
git commit -m "feat(web/team): MemberRow component"
```

---

### Task 10: TeamCard

**Files:**
- Create: `apps/web/app/routes/crm/team/components/TeamCard.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { Link } from '@tanstack/react-router'
import { Trash2, Users } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import type { ProjectDto, TeamDto } from '@crm/shared'
import { api } from '@/lib/axios'
import { getInitials } from '@/lib/team-constants'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

async function fetchProjects(): Promise<ProjectDto[]> {
  const res = await api.get<ProjectDto[]>('/projects')
  return res.data
}

export function TeamCard({
  team,
  canDelete,
  onDelete,
}: {
  team: TeamDto
  canDelete: boolean
  onDelete: (team: TeamDto) => void
}) {
  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: fetchProjects,
  })

  const hrNames = team.members
    .filter((m) => m.role === 'HR')
    .map((m) => m.displayName)
    .join(', ') || 'Нет HR'

  const activeProjectCount = projects
    ? projects.filter(
        (p) =>
          p.status === 'ACTIVE' &&
          team.members.some((m) => m.role === 'SENIOR' && m.userId === p.seniorId),
      ).length
    : null

  return (
    <Card className="group relative flex flex-col overflow-hidden transition-all duration-200 hover:shadow-lg hover:shadow-primary/5 cursor-pointer">
      {/* Clickable overlay */}
      <Link
        to="/crm/team/$teamId"
        params={{ teamId: team.id }}
        className="absolute inset-0 z-10"
        title={`Перейти к команде ${team.name}`}
      />

      <CardHeader className="relative z-20 flex flex-row items-start justify-between gap-2 pb-3">
        <div className="min-w-0 flex-1">
          <CardTitle className="truncate text-base group-hover:text-primary transition-colors">
            {team.name}
          </CardTitle>
          <p className="mt-0.5 text-xs text-muted-foreground truncate">{hrNames}</p>
        </div>
        {canDelete && (
          <Button
            variant="ghost"
            size="icon"
            className="relative z-30 h-7 w-7 text-muted-foreground hover:text-destructive shrink-0"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onDelete(team) }}
            title="Удалить команду"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </CardHeader>

      <CardContent className="relative z-20 flex-1">
        {team.members.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <Users className="h-8 w-8 text-muted-foreground/30" />
            <p className="mt-2 text-xs text-muted-foreground">Нет участников</p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex -space-x-2">
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
              <Badge variant="outline" className="text-xs">
                {team.members.length} участник{team.members.length === 1 ? '' : team.members.length < 5 ? 'а' : 'ов'}
              </Badge>
            </div>

            <div className="pt-2 border-t border-border/50">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Активные проекты</span>
                <span className="font-medium text-foreground">
                  {activeProjectCount ?? '—'}
                </span>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @crm/web typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/routes/crm/team/components/TeamCard.tsx
git commit -m "feat(web/team): simplified TeamCard component"
```

---

### Task 11: index.tsx — Thin Page Refactor

**Files:**
- Modify: `apps/web/app/routes/crm/team/index.tsx`

- [ ] **Step 1: Replace `index.tsx` with thin version**

```tsx
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { Plus, Users } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { TeamDto } from '@crm/shared'
import { useAuth } from '@/context/auth'
import { useRoleGuard } from '@/hooks/use-role-guard'
import { api } from '@/lib/axios'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { TeamCard } from './components/TeamCard'
import { CreateSeniorDialog } from './components/CreateSeniorDialog'
import { DeleteTeamDialog } from './components/DeleteTeamDialog'

export const Route = createFileRoute('/crm/team/')({
  component: TeamPage,
})

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.07 } },
}
const item = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.35, ease: [0.25, 0.1, 0.25, 1] as const } },
}

async function fetchTeams(): Promise<TeamDto[]> {
  const res = await api.get<TeamDto[]>('/teams')
  return res.data
}

function TeamPage() {
  const { denied } = useRoleGuard(['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT'])
  const { user } = useAuth()
  const navigate = useNavigate()
  if (denied) return null

  const isAdmin = user?.role === 'ADMIN'
  const isHr = user?.role === 'HR'

  const { data: teams, isLoading } = useQuery({
    queryKey: ['teams'],
    queryFn: fetchTeams,
    enabled: !!user,
  })

  useEffect(() => {
    if (!teams || isLoading || !user) return
    if (user.role === 'SENIOR' || user.role === 'JUNIOR') {
      if (teams.length === 1 && teams[0]) {
        void navigate({ to: '/crm/team/$teamId', params: { teamId: teams[0].id } })
      }
    }
  }, [teams, isLoading, user, navigate])

  const [showCreateSenior, setShowCreateSenior] = useState(false)
  const [deleteTeam, setDeleteTeam] = useState<TeamDto | null>(null)

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="space-y-1.5">
            <Skeleton className="h-7 w-32" />
            <Skeleton className="h-4 w-52" />
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-52 rounded-xl" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Команда</h1>
          <p className="text-sm text-muted-foreground">Состав и роли сотрудников</p>
        </div>
        {isHr && (
          <Button onClick={() => setShowCreateSenior(true)} size="sm" className="gap-1.5">
            <Plus className="h-4 w-4" />
            Создать синьора
          </Button>
        )}
      </div>

      {teams && teams.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-24 text-center">
          <Users className="h-10 w-10 text-muted-foreground/30" />
          <p className="mt-4 text-sm font-medium">Команд пока нет</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {isHr
              ? 'Нажмите «Создать синьора» чтобы сформировать первую команду'
              : 'Команды создаются автоматически при добавлении синьора в систему'}
          </p>
        </div>
      )}

      <motion.div
        className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
        variants={container}
        initial="hidden"
        animate="show"
      >
        {teams?.map((team) => (
          <motion.div key={team.id} variants={item}>
            <TeamCard
              team={team}
              canDelete={isAdmin}
              onDelete={(t) => setDeleteTeam(t)}
            />
          </motion.div>
        ))}
      </motion.div>

      {isHr && user && (
        <CreateSeniorDialog
          open={showCreateSenior}
          hrUserId={user.id}
          onClose={() => setShowCreateSenior(false)}
        />
      )}

      <DeleteTeamDialog team={deleteTeam} onClose={() => setDeleteTeam(null)} />
    </div>
  )
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @crm/web typecheck
```

Expected: no errors.

- [ ] **Step 3: Lint**

```bash
pnpm --filter @crm/web lint
```

Expected: no new errors (only pre-existing warnings allowed).

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/routes/crm/team/index.tsx
git commit -m "refactor(web/team): thin index.tsx using extracted components"
```

---

### Task 12: $teamId.tsx — Full Detail Page

**Files:**
- Modify: `apps/web/app/routes/crm/team/$teamId.tsx`

- [ ] **Step 1: Replace `$teamId.tsx` with full implementation**

```tsx
import { createFileRoute, Link } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { ArrowLeft, Calendar, ExternalLink, Pencil, Plus, Trash2, Users } from 'lucide-react'
import { useState } from 'react'
import type { ProjectDto, TeamDto } from '@crm/shared'
import { useAuth } from '@/context/auth'
import { useRoleGuard } from '@/hooks/use-role-guard'
import { api } from '@/lib/axios'
import { ROLE_ORDER } from '@/lib/team-constants'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { MemberRow } from './components/MemberRow'
import { EditTeamDialog } from './components/EditTeamDialog'
import { DeleteTeamDialog } from './components/DeleteTeamDialog'
import { AddMemberDialog } from './components/AddMemberDialog'

export const Route = createFileRoute('/crm/team/$teamId')({
  component: TeamDetailPage,
})

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.08 } },
}
const item = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.35, ease: [0.25, 0.1, 0.25, 1] as const } },
}

async function fetchTeam(id: string): Promise<TeamDto> {
  const res = await api.get<TeamDto>(`/teams/${id}`)
  return res.data
}

async function fetchProjects(): Promise<ProjectDto[]> {
  const res = await api.get<ProjectDto[]>('/projects')
  return res.data
}

function TeamDetailPage() {
  const { denied } = useRoleGuard(['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT'])
  const { user } = useAuth()
  const { teamId } = Route.useParams()
  const queryClient = useQueryClient()
  if (denied) return null

  const { data: team, isLoading, error } = useQuery({
    queryKey: ['team', teamId],
    queryFn: () => fetchTeam(teamId),
    enabled: !!user && !!teamId,
  })

  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: fetchProjects,
    enabled: !!user,
  })

  const isJunior = user?.role === 'JUNIOR'
  const canManage = user?.role === 'ADMIN' ||
    (user?.role === 'HR' && !!team?.members.some((m) => m.userId === user?.id))
  const isAdmin = user?.role === 'ADMIN'

  const removeMemberMutation = useMutation({
    mutationFn: ({ tid, uid }: { tid: string; uid: string }) =>
      api.delete(`/teams/${tid}/members/${uid}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['team', teamId] })
      void queryClient.invalidateQueries({ queryKey: ['teams'] })
    },
  })

  const [editOpen, setEditOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <Skeleton className="h-9 w-9 rounded-md" />
          <div className="space-y-1.5">
            <Skeleton className="h-7 w-48" />
            <Skeleton className="h-4 w-32" />
          </div>
        </div>
        <Skeleton className="h-64 rounded-xl" />
      </div>
    )
  }

  if (error || !team) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <Users className="h-10 w-10 text-muted-foreground/30" />
        <p className="mt-4 text-sm font-medium">Команда не найдена</p>
        <p className="mt-1 text-xs text-muted-foreground">Возможно, у вас нет доступа к этой команде</p>
        <Button asChild variant="outline" size="sm" className="mt-4">
          <Link to="/crm/team">
            <ArrowLeft className="h-4 w-4 mr-1.5" />
            Вернуться к списку
          </Link>
        </Button>
      </div>
    )
  }

  const activeProjectCount = projects
    ? projects.filter(
        (p) =>
          p.status === 'ACTIVE' &&
          team.members.some((m) => m.role === 'SENIOR' && m.userId === p.seniorId),
      ).length
    : null

  const sortedMembers = [...team.members].sort(
    (a, b) => ROLE_ORDER.indexOf(a.role as typeof ROLE_ORDER[number]) - ROLE_ORDER.indexOf(b.role as typeof ROLE_ORDER[number]),
  )

  const membersByRole = team.members.reduce((acc, m) => {
    acc[m.role] = (acc[m.role] ?? 0) + 1
    return acc
  }, {} as Record<string, number>)

  const canRemoveMember = (member: typeof team.members[0]) => {
    if (!canManage) return false
    if (member.role === 'SENIOR') return false
    if (member.role === 'JUNIOR') return false
    if (member.role === 'HR' && (membersByRole['HR'] ?? 0) <= 1) return false
    if (member.role === 'ACCOUNTANT' && (membersByRole['ACCOUNTANT'] ?? 0) <= 1) return false
    return true
  }

  return (
    <motion.div className="space-y-6" variants={container} initial="hidden" animate="show">
      {/* Header */}
      <motion.div variants={item} className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <Button asChild variant="outline" size="icon" className="shrink-0 mt-0.5">
            <Link to="/crm/team">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{team.name}</h1>
            <div className="flex flex-wrap items-center gap-3 mt-1">
              {!isJunior && (
                <p className="text-sm text-muted-foreground flex items-center gap-1.5">
                  <Calendar className="h-3.5 w-3.5" />
                  Создана{' '}
                  {new Date(team.createdAt).toLocaleDateString('ru-RU', {
                    day: 'numeric',
                    month: 'long',
                    year: 'numeric',
                  })}
                </p>
              )}
              {!isJunior && team.telegramGroupUrl && (
                <a
                  href={team.telegramGroupUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-sm text-primary hover:underline"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Telegram группа
                </a>
              )}
            </div>
          </div>
        </div>

        {canManage && (
          <div className="flex shrink-0 gap-2">
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setEditOpen(true)}>
              <Pencil className="h-3.5 w-3.5" />
              Редактировать
            </Button>
            {isAdmin && (
              <Button variant="ghost" size="icon" className="text-destructive hover:text-destructive" onClick={() => setDeleteOpen(true)}>
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>
        )}
      </motion.div>

      {/* Members card */}
      <motion.div variants={item}>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="h-5 w-5" />
              Участники
              <span className="ml-1 text-sm font-normal text-muted-foreground">
                ({team.members.length})
              </span>
              {activeProjectCount !== null && (
                <span className="ml-auto text-sm font-normal text-muted-foreground">
                  Активных проектов: {activeProjectCount}
                </span>
              )}
              {canManage && (
                <Button
                  variant="outline"
                  size="sm"
                  className="ml-2 gap-1.5"
                  onClick={() => setAddOpen(true)}
                >
                  <Plus className="h-3.5 w-3.5" />
                  Добавить
                </Button>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {team.members.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Users className="h-8 w-8 text-muted-foreground/30" />
                <p className="mt-3 text-sm font-medium">Нет участников</p>
                {canManage && (
                  <p className="mt-1 text-xs text-muted-foreground">Нажмите «Добавить» чтобы добавить первого участника</p>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                {sortedMembers.map((member) => (
                  <MemberRow
                    key={member.id}
                    member={member}
                    canRemove={canRemoveMember(member)}
                    onRemove={(uid) => removeMemberMutation.mutate({ tid: teamId, uid })}
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>

      {/* Dialogs */}
      <EditTeamDialog team={editOpen ? team : null} onClose={() => setEditOpen(false)} />
      <DeleteTeamDialog team={deleteOpen ? team : null} onClose={() => setDeleteOpen(false)} />
      <AddMemberDialog team={addOpen ? team : null} onClose={() => setAddOpen(false)} />
    </motion.div>
  )
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm typecheck
```

Expected: all 4 packages pass with no errors.

- [ ] **Step 3: Lint**

```bash
pnpm lint
```

Expected: no new errors.

- [ ] **Step 4: Run all tests**

```bash
pnpm test
```

Expected: `Test Files 10 passed`, all tests green.

- [ ] **Step 5: Start dev server and verify in browser**

```bash
pnpm --filter @crm/web dev
```

Open http://localhost:3000, log in, navigate to `/crm/team`.

Verify:
- ADMIN/HR: see team cards, each clickable, delete button on cards
- Click card → navigate to `/crm/team/:id`
- Detail page: members listed (no role headers), badges per member
- "Редактировать" opens dialog with name + telegram fields
- PATCH saves telegramGroupUrl, it appears as link on page
- "Добавить" opens dialog with user list, adds member
- [✕] button removes member (not shown on SENIOR/JUNIOR/last HR/last ACCOUNTANT)
- JUNIOR: no date, no telegram link
- Delete team from detail page (ADMIN)

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/routes/crm/team/$teamId.tsx
git commit -m "feat(web/team): full $teamId.tsx refactor — wired buttons, RBAC, telegram link"
```

---

## Final Verification

- [ ] `pnpm typecheck` — 4/4 packages pass
- [ ] `pnpm lint` — 0 errors
- [ ] `pnpm test` — all tests green
- [ ] All acceptance criteria from spec checked manually in browser
