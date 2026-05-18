# task-fix-team-detail-hooks

## Агент: coder
## Приоритет: high
## Ветка: fix/team-detail-hooks

## Контекст

Баг у `apps/web/app/routes/crm/team/$teamId.tsx` — порушення React Rules of Hooks.
Хуки `useForm`, `useMutation` (update), `useState` (selectedUserIds), `useMutation` (addMemberMutation)
оголошені на рядках ~230–262, тобто **після** ранніх `return` на рядках 137 (isLoading) і 159 (error || !team).

Це призводить до помилки в runtime:
> Rendered more hooks than during the previous render.

Тест `SENIOR sidebar navigation → sidebar → Команда stays in CRM` падає саме через це:
сторінка показує "Something went wrong!" замість h1 з назвою команди.

## Конкретні зміни

**Файл:** `apps/web/app/routes/crm/team/$teamId.tsx`

Перемістити ці хуки **до** рядка 137 (`if (isLoading) return ...`):

```typescript
// Edit form
const editForm = useForm({
  defaultValues: { name: team?.name ?? '', telegram: team?.telegram ?? '', notes: team?.notes ?? '' },
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
```

Усі чотири хуки мають бути між рядком ~120 (після `useQuery` для allUsers) і рядком 137 (`if (isLoading)`).
`team?.name ?? ''` тощо вже підтримує `team = undefined`, тому defaultValues безпечні до завантаження.

## Acceptance criteria

- [ ] Усі хуки (useForm, усі useMutation, усі useState) оголошені ДО будь-яких ранніх `return`
- [ ] `pnpm --filter @crm/e2e test -- --grep "SENIOR sidebar navigation"` → 0 failed
- [ ] `pnpm typecheck` → 0 errors
- [ ] Функціональність редагування команди (Edit dialog) і додавання учасників (Add dialog) збережена

## Запрещено трогать

- `apps/api/` — тільки frontend
- `apps/e2e/` — тестами займається AutoTest
- `.github/workflows/`
