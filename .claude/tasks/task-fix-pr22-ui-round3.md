# task-fix-pr22-ui-round3

## Агент: coder

## Приоритет: critical

## Ветка: fix/teams-ui-polish

## КРИТИЧЕСКИ ВАЖНО: правила верификации

**ЗАПРЕЩЕНО** объявлять пункт выполненным без ВНЕСЕНИЯ изменения в файл.
Перед тем как написать [x] — запусти `git diff HEAD -- <файл>` и убедись что изменение есть.
"Уже было реализовано ранее" — это не причина пропустить пункт. Если пункта нет в diff — он не выполнен.

Предыдущие раунды (round1, round2) НЕ сделали 6 пунктов ниже. Все они должны быть в твоём diff.

---

## Файл 1: apps/web/app/routes/crm/team/index.tsx

### Правка 1 — AvatarFallback: добавить bg-muted (2 места)

**Место A** — примерно строка 752:

```tsx
// БЫЛО:
<AvatarFallback className="text-[10px]">{getInitials(member.displayName)}</AvatarFallback>

// СТАЛО:
<AvatarFallback className="bg-muted text-[10px]">{getInitials(member.displayName)}</AvatarFallback>
```

**Место B** — примерно строка 968 (в списке availableUsers для добавления участника):

```tsx
// БЫЛО:
<AvatarFallback className="text-[10px]">{getInitials(u.displayName)}</AvatarFallback>

// СТАЛО:
<AvatarFallback className="bg-muted text-[10px]">{getInitials(u.displayName)}</AvatarFallback>
```

Найди оба через ast-grep: `mcp__ast-grep__find_code` с паттерном `<AvatarFallback className="text-[10px]">`.

### Правка 2 — Telegram-кнопка: перенести в Pills-блок справа

Сейчас Telegram ссылка находится в div "Name + HRs + Telegram" (средняя колонка).
Её нужно **вырезать** оттуда и **вставить** в блок "Pills" (правая колонка).

**ШАГ А** — удалить из средней колонки (там где `{/* Name + HRs + Telegram */}`):

```tsx
// УДАЛИТЬ этот блок целиком:
{
  team.telegram && (
    <a
      href={team.telegram}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-500 hover:text-blue-400 transition-colors"
    >
      <Send className="h-3 w-3" />
      Telegram-канал
    </a>
  )
}
```

Оставить в средней колонке только name + HRs.

**ШАГ Б** — вставить в блок Pills (`{/* Pills */}`) как ПЕРВЫЙ элемент перед Badge:

```tsx
                {/* Pills */}
                <div className="relative z-20 flex shrink-0 items-center gap-2">
                  {team.telegram && (
                    <a
                      href={team.telegram}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={e => e.stopPropagation()}
                      className="flex h-7 w-7 items-center justify-center rounded-full text-blue-500 hover:bg-blue-500/10 transition-colors"
                      title="Telegram-канал команды"
                    >
                      <Send className="h-3.5 w-3.5" />
                    </a>
                  )}
                  <Badge variant="outline" className="text-[11px] tabular-nums">
                    {team.members.length} уч.
                  </Badge>
                  {/* ... остальные Badge-и без изменений ... */}
```

---

## Файл 2: apps/web/app/routes/crm/team/$teamId.tsx

### Правка 3 — AvatarFallback участника: добавить bg-muted

Строка ~352, в карточке участника:

```tsx
// БЫЛО:
<AvatarFallback className="text-xs">{getInitials(member.displayName)}</AvatarFallback>

// СТАЛО:
<AvatarFallback className="bg-muted text-xs">{getInitials(member.displayName)}</AvatarFallback>
```

### Правка 4 — stopPropagation на контактах (ОБЯЗАТЕЛЬНО)

Контакты (email, telegram, phone) находятся ВНУТРИ `<Link to="/crm/users/$userId">`.
Клик по ссылкам сейчас открывает профиль участника — это неправильно.
Добавить `onClick={e => e.stopPropagation()}` к каждому тегу `<a>`:

```tsx
// БЫЛО:
<a href={`mailto:${member.email}`}
   className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors truncate">

// СТАЛО:
<a href={`mailto:${member.email}`}
   onClick={e => e.stopPropagation()}
   className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors truncate">
```

То же самое для telegram `<a>` и phone `<a>` — добавить `onClick={e => e.stopPropagation()}`.
Итого: 3 тега `<a>` должны получить этот атрибут.

Также убедись что telegram href ведёт на правильный URL. Если `member.telegram` содержит полный URL `https://t.me/username` — использовать как есть. Если содержит `@username` — сформировать `https://t.me/${member.telegram.replace('@', '')}`.

### Правка 5 — Джун в активных проектах

В секции "Активные проекты" каждая карточка проекта (Link) должна показывать прикреплённого джуна.

Данные: `projects` уже загружен через `useQuery(['projects'])`. У каждого проекта есть `project.members` — массив участников с полями `{ userId, role, leftAt }`.

Найди джуна проекта так:

```tsx
const juniorMember = project.members?.find(
  (m: { role: string; leftAt: string | null }) => m.role === 'JUNIOR' && m.leftAt === null,
)
const junior = juniorMember ? team.members.find((m) => m.userId === juniorMember.userId) : null
```

В карточку проекта (после `<p className="truncate text-xs text-muted-foreground">{project.companyName}</p>`) добавить:

```tsx
{
  junior ? (
    <div className="flex items-center gap-1.5 mt-1">
      <Avatar className="h-4 w-4">
        {junior.avatar && <AvatarImage src={junior.avatar} alt={junior.displayName} />}
        <AvatarFallback className="bg-muted text-[8px]">
          {getInitials(junior.displayName)}
        </AvatarFallback>
      </Avatar>
      <span className="text-xs text-muted-foreground truncate">{junior.displayName}</span>
    </div>
  ) : (
    <p className="text-xs text-destructive mt-1">Джун не прикреплён</p>
  )
}
```

### Правка 6 — Telegram-кнопка команды в шапке: сделать крупнее

Кнопка находится примерно на строке 280-289. Сейчас: маленький pill `bg-blue-500/10 px-3 py-1 text-xs`.

```tsx
// БЫЛО:
className =
  'inline-flex items-center gap-1.5 rounded-full bg-blue-500/10 px-3 py-1 text-xs font-medium text-blue-500 hover:bg-blue-500/20 transition-colors border border-blue-500/20'

// СТАЛО:
className =
  'inline-flex items-center gap-2 rounded-lg border border-blue-500/50 px-4 py-2 text-sm font-medium text-blue-400 hover:bg-blue-500/10 hover:border-blue-400 transition-colors'
```

---

## Acceptance criteria — верификация через git diff

После всех правок выполни:

```bash
git diff HEAD -- apps/web/app/routes/crm/team/index.tsx
git diff HEAD -- apps/web/app/routes/crm/team/'$teamId.tsx'
```

Каждый пункт должен быть ВИДЕН в diff:

- [ ] `bg-muted` появился в AvatarFallback в index.tsx (2 раза)
- [ ] Telegram-ссылка удалена из средней колонки index.tsx
- [ ] Telegram-кнопка добавлена в Pills-блок index.tsx (круглая иконка)
- [ ] `bg-muted` появился в AvatarFallback в $teamId.tsx
- [ ] `stopPropagation` добавлен к 3 тегам `<a>` в $teamId.tsx
- [ ] Джун/`text-destructive` добавлен в active projects в $teamId.tsx
- [ ] Telegram-кнопка в шапке $teamId.tsx увеличена (border-blue-500/50, px-4 py-2)

Если хоть один пункт не в diff — вернись и исправь. Не создавай PR с неполным diff.

## После правок

```bash
pnpm --filter @crm/web typecheck
```

Потом:

```bash
git add apps/web/app/routes/crm/team/index.tsx apps/web/app/routes/crm/team/'$teamId.tsx'
git commit -m "fix(teams): UI polish — avatars, telegram button, contacts stopPropagation, junior in projects"
git push origin $(git branch --show-current)
```

PR #22 уже существует — не создавай новый. Просто обнови его:

```bash
gh pr edit 22 --add-label "ai-review-ready" --repo $REPO
```
