# task-fix-teams-critical

## Агент: coder
## Приоритет: CRITICAL
## Ветка: feature/teams-redesign

## ВАЖНО: работай ТОЛЬКО на ветке `feature/teams-redesign`

```bash
git fetch origin
git checkout feature/teams-redesign
git pull origin feature/teams-redesign
```

Не создавай новых веток. Все коммиты — в `feature/teams-redesign`.

---

## Проблема 1: Нарушение Rules of Hooks (страница не открывается)

**Файл:** `apps/web/app/routes/crm/team/$teamId.tsx`

В компоненте `TeamDetailPage` хуки вызываются ПОСЛЕ условных возвратов — это нарушение React Rules of Hooks:

- `if (denied) return null` — строка ~99
- `if (isLoading) return ...` — строка ~136  
- `if (error || !team) return ...` — строка ~158

А ПОСЛЕ этих ранних возвратов вызываются:
- `useForm(...)` — строка ~229
- `useMutation(updateMutation)` — строка ~236
- `useState(selectedUserIds)` — строка ~249
- `useMutation(addMemberMutation)` — строка ~251

**Исправление:** переместить ВСЕ эти хуки ПЕРЕД первым условным возвратом (перед строкой `if (denied) return null`).

Конкретно — сразу после `const queryClient = useQueryClient()` добавить:

```typescript
const [showEdit, setShowEdit] = useState(false)
const [showAddMember, setShowAddMember] = useState(false)
const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set())
```

А `useForm` и оба `useMutation` тоже поднять наверх. `useForm` использует `team?.name` — это нормально, начальные значения будут `''` пока данные загружаются:

```typescript
const editForm = useForm({
  defaultValues: { name: '', telegram: '', notes: '' },
  onSubmit: async ({ value }) => {
    await updateMutation.mutateAsync(value)
  },
})
```

При открытии диалога редактирования уже есть `editForm.setFieldValue(...)` — оно обновит значения.

Оба `useMutation` (updateMutation, addMemberMutation) тоже переместить наверх перед любыми ранними возвратами.

---

## Проблема 2: Весь текст на украинском — заменить на русский

**Файл:** `apps/web/app/routes/crm/team/$teamId.tsx`

Заменить точно следующие строки (язык интерфейса — РУССКИЙ):

| Найти | Заменить на |
|-------|-------------|
| `'uk-UA'` (в toLocaleDateString) | `'ru-RU'` |
| `Створена` | `Создана` |
| `Додати` (кнопка UserPlus) | `Добавить` |
| `Редагувати` (кнопка Pencil) | `Редактировать` |
| `Учасники команди` | `Участники команды` |
| `Виключити` | `Исключить` |
| `Немає учасників` | `Нет участников` |
| `Активні проекти` | `Активные проекты` |
| `Немає активних проектів` | `Нет активных проектов` |
| `Редагувати команду` (DialogTitle) | `Редактировать команду` |
| `Назва` (Label) | `Название` |
| `Назва команди` (placeholder) | `Название команды` |
| `Посилання на Telegram-чат команди` | `Ссылка на Telegram-чат команды` |
| `Нотатки` (Label) | `Заметки` |
| `Внутрішні нотатки…` | `Внутренние заметки…` |
| `Скасувати` (все кнопки) | `Отмена` |
| `Збереження…` | `Сохранение…` |
| `Зберегти` | `Сохранить` |
| `'Команду оновлено'` (toast) | `'Команда обновлена'` |
| `'Не вдалось оновити команду'` (toast) | `'Не удалось обновить команду'` |
| `Додати учасника` (DialogTitle) | `Добавить участника` |
| `Немає доступних користувачів` | `Нет доступных пользователей` |
| `'в команді'` (disabledReason) | `'в команде'` |
| `'вже є синьор'` (disаbledReason) | `'уже есть синьор'` |
| `'має проект'` (disabledReason) | `'есть проект'` |
| `'Помилка додавання'` (toast) | `'Ошибка добавления'` |
| `'Учасників додано'` (toast) | `'Участники добавлены'` |
| `Додати` (кнопка в диалоге добавления) | `Добавить` |

**Файл:** `apps/web/app/routes/crm/team/index.tsx`

| Найти | Заменить на |
|-------|-------------|
| `Пошук за назвою` | `Поиск по названию` |
| `Всі ролі` | `Все роли` |
| `Назва A→Z` | `Название A→Z` |
| `Учасники ↓` | `Участники ↓` |
| `Проекти ↓` | `Проекты ↓` |
| `Нічого не знайдено` | `Ничего не найдено` |
| `Перейти до команди` | `Перейти к команде` |
| `Перейменувати` | `Переименовать` |
| `проект` / `проекти` / `проектів` (в badge) | `проект` / `проекта` / `проектов` |

---

## Acceptance criteria

- [ ] Страница `/crm/team/$teamId` открывается без ошибки "Rendered more hooks than during the previous render"
- [ ] Все хуки в `TeamDetailPage` вызываются до любого условного возврата
- [ ] Весь UI в `$teamId.tsx` на русском языке
- [ ] Весь UI в `index.tsx` на русском языке
- [ ] TypeCheck `pnpm --filter @crm/web typecheck` — 0 errors
- [ ] Коммит в ветку `feature/teams-redesign`: `fix(teams): fix hooks violation and translate UI to Russian`

## Запрещено трогать

- Любые другие файлы
- НЕ создавать новые ветки
