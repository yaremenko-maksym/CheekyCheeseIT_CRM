# Задача: Teams UI Improvements

## Контекст

Страницы `/crm/team` (список команд) и `/crm/team/$teamId` (детальная страница команды) требуют
нескольких UI-улучшений. КРИТИЧНО: весь украиноязычный текст интерфейса переводится на русский.

---

## Изменения — точный список

### 1. Убрать ролевую группировку на детальной странице (`$teamId.tsx`)

Текущее поведение: участники сгруппированы по ролям с заголовками (Синьор, HR, Бухгалтер, Джун).

Нужно: плоский список участников в одну сетку — без заголовков по ролям.

Удалить:

- `membersByRole`, `visibleMembersByRole`, `visibleOrderedRoles` — всю логику группировки
- JSX-цикл `visibleOrderedRoles.map((role) => ...)` с заголовками `<h3>`

Заменить на единый `<div className="grid gap-2 sm:grid-cols-2">` с прямым маппингом видимых участников.

JUNIOR-фильтрацию сохранить: JUNIOR не видит других JUNIORов.
Видимые участники для JUNIOR: `team.members.filter(m => m.role !== 'JUNIOR')`.
Для остальных: `team.members` (весь список).

---

### 2. Сделать строки участников информативнее (`$teamId.tsx`)

Нужно отобразить в карточке участника: телефон, telegram, email.

**2a. Shared schema** (`packages/shared/src/schemas/teams.ts`):
Добавить в `teamMemberSchema`:

```typescript
phone: z.string().nullable().optional(),
telegram: z.string().nullable().optional(),
```

**2b. Backend** (`apps/api/src/teams/teams.service.ts` или где находится `mapTeam()`):
Включить `phone` и `telegram` из таблицы `users` при маппинге члена команды в DTO.

**2c. Frontend** (`$teamId.tsx`):
В карточке участника под `techStack` добавить контактный блок:

- email: иконка Mail + `member.email`
- telegram: иконка `MessageCircle` (или Send) + `member.telegram` (если есть)
- phone: иконка `Phone` + `member.phone` (если есть)

Стиль: `text-xs text-muted-foreground flex items-center gap-1` — как у существующих мета-строк.

---

### 3. Ссылка на Telegram-канал команды

**3a. Детальная страница** (`$teamId.tsx`) — в шапке рядом с датой создания:
Если `team.telegram` заполнен — показать кнопку-ссылку:

```tsx
{
  team.telegram && (
    <a
      href={team.telegram}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-primary transition-colors"
    >
      <MessageCircle className="h-3.5 w-3.5" />
      Telegram-канал
    </a>
  )
}
```

**3b. Список команд** (`index.tsx`) — в строке команды под именем рядом с "HR:":
Если `team.telegram` заполнен — показать иконку Telegram-ссылки:

```tsx
{
  team.telegram && (
    <a
      href={team.telegram}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary transition-colors ml-2"
      onClick={(e) => e.stopPropagation()}
      title="Telegram-канал команды"
    >
      <MessageCircle className="h-3 w-3" />
      TG
    </a>
  )
}
```

Добавить `onClick(e => e.stopPropagation())` чтобы не триггерить навигацию по карточке.

---

### 4. Убрать фильтр по роли из тулбара (`index.tsx`)

Удалить:

- Состояние `const [filterRole, setFilterRole] = useState<string>('all')`
- `<Select value={filterRole} onValueChange={setFilterRole}>` с опциями "Всі ролі/Senior/HR/Junior/Accountant"
- Логику фильтрации `if (filterRole !== 'all') { result = result.filter(...) }` из `filteredTeams` useMemo

---

### 5. Блочные секции "Участники" и "Активные проекты" (`$teamId.tsx`)

Обе секции уже рендерятся как `<Card>`. Это правильно — ничего менять не нужно.
Убедиться что после удаления ролевой группировки верстка не сломалась.

---

### 6. КРИТИЧНО: Перевод всего интерфейса с украинского на русский

#### `apps/web/app/routes/crm/team/index.tsx`

| Было (украинский)                                                               | Стало (русский)                                                                 |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `placeholder="Пошук за назвою…"`                                                | `placeholder="Поиск по названию…"`                                              |
| `"Назва A→Z"`                                                                   | `"Название A→Z"`                                                                |
| `"Учасники ↓"`                                                                  | `"Участники ↓"`                                                                 |
| `"Проекти ↓"`                                                                   | `"Проекты ↓"`                                                                   |
| `"Нічого не знайдено"`                                                          | `"Ничего не найдено"`                                                           |
| `activeProjects === 1 ? 'проект' : activeProjects < 5 ? 'проекти' : 'проектів'` | `activeProjects === 1 ? 'проект' : activeProjects < 5 ? 'проекта' : 'проектов'` |
| `title="Перейменувати"`                                                         | `title="Переименовать"`                                                         |
| Dialog: `"Редагувати команду"`                                                  | `"Редактировать команду"`                                                       |
| `label="Назва"`                                                                 | `"Название"`                                                                    |
| `placeholder="Назва команди"`                                                   | `"Название команды"`                                                            |
| `"Посилання на чат команди"` (hint)                                             | `"Ссылка на чат команды"`                                                       |
| `label="Нотатки"`                                                               | `"Заметки"`                                                                     |
| `placeholder="Внутрішні нотатки…"`                                              | `"Внутренние заметки…"`                                                         |
| `"Відміна"`                                                                     | `"Отмена"`                                                                      |
| `'Збереження...'` / `'Зберегти'`                                                | `'Сохранение...'` / `'Сохранить'`                                               |

#### `apps/web/app/routes/crm/team/$teamId.tsx`

| Было (украинский)                               | Стало (русский)                     |
| ----------------------------------------------- | ----------------------------------- |
| `"Створена"` + `'uk-UA'` locale                 | `"Создана"` + `'ru-RU'` locale      |
| `"Учасники команди"`                            | `"Участники команды"`               |
| `"Активні проекти"`                             | `"Активные проекты"`                |
| `"Немає учасників"`                             | `"Нет участников"`                  |
| `"Немає активних проектів"`                     | `"Нет активных проектов"`           |
| `"Active"` badge                                | `"Активный"`                        |
| Button `"Додати"`                               | `"Добавить"`                        |
| Button `"Редагувати"`                           | `"Редактировать"`                   |
| `title="Виключити"`                             | `title="Исключить"`                 |
| Dialog title `"Редагувати команду"`             | `"Редактировать команду"`           |
| `label="Назва"` / `placeholder="Назва команди"` | `"Название"` / `"Название команды"` |
| `"Посилання на Telegram-чат команди"` (hint)    | `"Ссылка на Telegram-чат команды"`  |
| `label="Нотатки"`                               | `"Заметки"`                         |
| `placeholder="Внутрішні нотатки…"`              | `"Внутренние заметки…"`             |
| `"Скасувати"` (edit dialog)                     | `"Отмена"`                          |
| `'Збереження…'` / `'Зберегти'`                  | `'Сохранение…'` / `'Сохранить'`     |
| toast `'Команду оновлено'`                      | `'Команда обновлена'`               |
| toast `'Не вдалось оновити команду'`            | `'Не удалось обновить команду'`     |
| Dialog title `"Додати учасника"`                | `"Добавить участника"`              |
| `"Немає доступних користувачів"`                | `"Нет доступных пользователей"`     |
| `"Скасувати"` (add member dialog)               | `"Отмена"`                          |
| Button `"Додати"` / `"Додати (N)"`              | `"Добавить"` / `"Добавить (N)"`     |
| disabledReason `'в команді'`                    | `'в команде'`                       |
| disabledReason `'вже є синьор'`                 | `'уже есть синьор'`                 |
| disabledReason `'має проект'`                   | `'есть проект'`                     |
| toast `'Учасників додано'`                      | `'Участники добавлены'`             |
| toast `'Помилка додавання'`                     | `'Ошибка добавления'`               |

---

## Примечание для AutoTest

После изменений в UI текстовые якоря в `apps/e2e/tests/team.spec.ts` перестанут работать.
AutoTest должен обновить следующие якоря (приоритетные):

- `getByTitle('Перейменувати')` → `getByTitle('Переименовать')`
- `getByText('Учасники команди')` → `getByText('Участники команды')`
- `getByRole('heading', { name: /Активні проекти/i })` → `/Активные проекты/i`
- `getByRole('button', { name: 'Додати' })` → `'Добавить'`
- `getByRole('button', { name: 'Редагувати' })` → `'Редактировать'`
- `getByTitle('Виключити')` → `getByTitle('Исключить')`
- `getByRole('button', { name: 'Скасувати' })` → `'Отмена'`
- `getByRole('button', { name: 'Зберегти' })` → `'Сохранить'`
- `getByPlaceholder('Пошук за назвою…')` → `'Поиск по названию…'`
- `getByText('Нічого не знайдено')` → `'Ничего не найдено'`
- `getByText('Створена', ...)` → `'Создана'`
- `getByText('Додати учасника')` → `'Добавить участника'`
- `getByPlaceholder('Назва команди')` → `'Название команды'`
- `getByText('Посилання на Telegram-чат команди')` → `'Ссылка на Telegram-чат команды'`
- Тест `'shows members grouped by role'` — удалить (группировка убрана). Вместо него проверить плоский список.
- `getByRole('combobox').filter({ hasText: 'Всі ролі' })` — удалить (фильтр убран)
- `getByText('Синьор').first()` / `getByText('Бухгалтер').first()` — заменить на проверку имён участников (без ролевых заголовков)
- `getByRole('button', { name: 'Відміна' })` → `'Отмена'`

---

## Критерии приёмки

- [ ] На `/crm/team`: нет ни одного украинского слова в UI
- [ ] На `/crm/team`: нет фильтра по ролям в тулбаре
- [ ] На `/crm/team`: в строке команды — ссылка на Telegram если `team.telegram` заполнен
- [ ] На `/crm/team/$teamId`: нет украинских слов в UI
- [ ] На `/crm/team/$teamId`: участники в плоском списке (нет заголовков Синьор/HR/Бухгалтер/Джун)
- [ ] На `/crm/team/$teamId`: в карточке участника видны email + telegram + phone (если есть)
- [ ] На `/crm/team/$teamId`: в шапке — ссылка на Telegram-канал если заполнен
- [ ] `teamMemberSchema` содержит `phone` и `telegram`
- [ ] Backend возвращает `phone` и `telegram` в составе `TeamMemberDto`
- [ ] TypeScript — `pnpm typecheck` проходит без ошибок
- [ ] Линтер — `pnpm lint` проходит без ошибок
