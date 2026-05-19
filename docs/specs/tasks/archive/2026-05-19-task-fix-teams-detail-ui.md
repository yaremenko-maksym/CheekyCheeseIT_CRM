# task-fix-teams-detail-ui

## Агент: coder
## Приоритет: high
## Ветка: feature/teams-redesign

## Контекст

Четыре UI-правки на странице команды (`/crm/team/$teamId`).
Читай текущий код файла перед изменениями.

---

## 1. Показать ссылку на Telegram команды в UI

Поле `team.telegram` сохраняется, но нигде не отображается на странице.

В заголовке страницы, под именем команды (рядом с датой создания), добавить:

```typescript
{team.telegram && (
  <a
    href={team.telegram}
    target="_blank"
    rel="noopener noreferrer"
    className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors"
  >
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.894 8.221-1.97 9.28c-.145.658-.537.818-1.084.508l-3-2.21-1.447 1.394c-.16.16-.295.295-.605.295l.213-3.053 5.56-5.023c.242-.213-.054-.333-.373-.12L7.19 13.9l-2.948-.924c-.64-.203-.658-.64.135-.954l11.57-4.461c.537-.194 1.006.131.947.66z"/>
    </svg>
    Telegram команды
  </a>
)}
```

---

## 2. Участники — плоский список без группировки по ролям

Сейчас участники сгруппированы по ролям с заголовками. Нужно убрать группировку и показать единый список.

### Порядок сортировки внутри плоского списка

Отображать в приоритете: HR → SENIOR → ACCOUNTANT → JUNIOR, внутри каждой роли — по алфавиту.

### Что изменить

Убрать весь блок `{visibleOrderedRoles.map((role) => (...))}` и заменить на:

```typescript
{(() => {
  const roleOrder = ['HR', 'SENIOR', 'ACCOUNTANT', 'JUNIOR'] as const
  const allVisible = roleOrder
    .flatMap((role) => visibleMembersByRole[role] ?? [])
  return allVisible.length === 0 ? (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <p className="mt-3 text-sm font-medium">Нет участников</p>
    </div>
  ) : (
    <div className="grid gap-2 sm:grid-cols-2">
      {allVisible.map((member) => (
        // ... карточка участника (см. ниже)
      ))}
    </div>
  )
})()}
```

### Карточка участника — добавить telegram и phone

Нужно расширить `teamMemberSchema` (shared) и `mapTeam` (service) чтобы возвращать `telegram` и `phone` из профиля пользователя.

**`packages/shared/src/schemas/teams.ts`** — в `teamMemberSchema` добавить:
```typescript
telegram: z.string().nullable().optional(),
phone: z.string().nullable().optional(),
```

**`apps/api/src/teams/teams.service.ts`** — в `mapTeam()` в обоих местах где формируется объект участника (team.members.map и juniorMembers.push) добавить:
```typescript
telegram: m.user?.telegram ?? null,  // или pm.user?.telegram ?? null для джунов
phone: m.user?.phone ?? null,
```

**UI карточки** — под именем и email участника добавить строку с иконками:

```typescript
<div className="flex items-center gap-2 mt-0.5">
  {member.telegram && (
    <a
      href={member.telegram}
      target="_blank"
      rel="noopener noreferrer"
      className="text-[10px] text-muted-foreground hover:text-primary flex items-center gap-0.5"
      title="Telegram"
    >
      <svg className="h-3 w-3" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.894 8.221-1.97 9.28c-.145.658-.537.818-1.084.508l-3-2.21-1.447 1.394c-.16.16-.295.295-.605.295l.213-3.053 5.56-5.023c.242-.213-.054-.333-.373-.12L7.19 13.9l-2.948-.924c-.64-.203-.658-.64.135-.954l11.57-4.461c.537-.194 1.006.131.947.66z"/>
      </svg>
      TG
    </a>
  )}
  {member.phone && (
    <a
      href={`tel:${member.phone}`}
      className="text-[10px] text-muted-foreground hover:text-primary flex items-center gap-0.5"
      title="Позвонить"
    >
      <Phone className="h-3 w-3" />
      {member.phone}
    </a>
  )}
</div>
```

Добавить `Phone` в импорты из `lucide-react`.

Бейдж с ролью оставить — добавить его к имени участника (`<Badge variant={ROLE_VARIANT[member.role]} className="text-[10px] ml-1">`).

---

## 3. Активные проекты — дополнительная информация

Для каждого проекта в секции "Активные проекты" добавить:
- Дата начала
- Ставка + валюта
- Джун на проекте (имя + ссылка на профиль)

**Как найти джуна проекта:**
Джуны уже есть в `team.members` (они туда попадают через `mapTeam` из project_members).
Для каждого проекта найти джуна через: `team.members.find(m => m.role === 'JUNIOR' && project.members?.some(pm => pm.userId === m.userId && pm.leftAt === null))`.

Если `team.members` не содержит нужных данных — джун есть в `project.members` но без displayName.
В таком случае использовать `allUsers` (уже запрошен для canManage), а для non-canManage ролей — показывать только userId-placeholder или не показывать джуна.

**Обновить карточку проекта:**

```typescript
<Link
  key={project.id}
  to="/crm/projects/$projectId"
  params={{ projectId: project.id }}
  className="flex items-start gap-3 rounded-lg border border-border/60 bg-card/50 p-3 transition-all hover:border-primary/30 hover:bg-card"
>
  <Avatar className="h-8 w-8 rounded-md shrink-0 mt-0.5">
    {project.logoUrl && <AvatarImage src={project.logoUrl} alt={project.name} />}
    <AvatarFallback className="rounded-md text-xs">
      {project.companyName.slice(0, 2).toUpperCase()}
    </AvatarFallback>
  </Avatar>
  <div className="min-w-0 flex-1">
    <div className="flex items-center gap-2">
      <p className="truncate text-sm font-medium">{project.name}</p>
      <Badge className="shrink-0 bg-emerald-500/15 text-emerald-400 border-emerald-500/25 text-[10px]">
        Active
      </Badge>
    </div>
    <p className="truncate text-xs text-muted-foreground">{project.companyName}</p>
    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1">
      {project.startDate && (
        <span className="text-[11px] text-muted-foreground flex items-center gap-1">
          <Calendar className="h-3 w-3" />
          {new Date(project.startDate).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' })}
        </span>
      )}
      {project.rate && (
        <span className="text-[11px] text-muted-foreground flex items-center gap-1">
          <DollarSign className="h-3 w-3" />
          {project.rate} {project.currency}
        </span>
      )}
      {(() => {
        const junior = team.members.find(
          (m) =>
            m.role === 'JUNIOR' &&
            project.members?.some(
              (pm: { userId: string; leftAt: string | null }) =>
                pm.userId === m.userId && pm.leftAt === null,
            ),
        )
        return junior ? (
          <Link
            to="/crm/users/$userId"
            params={{ userId: junior.userId }}
            onClick={(e) => e.stopPropagation()}
            className="text-[11px] text-muted-foreground hover:text-primary flex items-center gap-1"
          >
            <Users className="h-3 w-3" />
            {junior.displayName}
          </Link>
        ) : null
      })()}
    </div>
  </div>
</Link>
```

Добавить `DollarSign` и `Users` в импорты из `lucide-react` (если ещё нет).

---

## Acceptance criteria

- [ ] `team.telegram` отображается в заголовке страницы как кликабельная ссылка
- [ ] Участники команды — единый плоский список (HR → SENIOR → ACCOUNTANT → JUNIOR), без заголовков-группировщиков по ролям
- [ ] Рядом с каждым участником: TG-ссылка (если есть) + номер телефона (если есть)
- [ ] Каждый проект в "Активные проекты" показывает: дата начала, ставка+валюта, имя джуна со ссылкой
- [ ] TypeCheck `pnpm --filter @crm/shared typecheck` и `pnpm --filter @crm/web typecheck` — 0 errors
- [ ] Commit `feat(teams): team detail — flat members list, contacts, telegram link, project details`

## Запрещено трогать

- `apps/api/src/teams/teams.controller.ts`
- `apps/api/src/teams/teams.service.spec.ts` — тесты обновить только если сигнатуры изменились
- Файлы вне teams-модуля
