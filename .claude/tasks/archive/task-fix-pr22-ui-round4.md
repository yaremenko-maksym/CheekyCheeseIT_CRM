# task-fix-pr22-ui-round4

## Агент: coder

## Приоритет: critical

## Ветка: fix/teams-ui-polish

## КРИТИЧЕСКИ ВАЖНО: правила верификации

**ЗАПРЕЩЕНО** объявлять пункт выполненным без внесения изменения в файл.
Перед тем как написать [x] — запусти `git diff HEAD -- <файл>` и убедись что изменение есть в diff.
Если пункта нет в diff — он не выполнен, вернись и исправь.

---

## Файл 1: apps/web/app/routes/crm/team/$teamId.tsx

### Правка 1 — Telegram href участника: нормализовать URL

Строки ~373-379. Текущий `href={member.telegram}` не работает когда значение `@username` или просто `username`.
Нужно нормализовать href И display-текст:

```tsx
// БЫЛО:
{
  member.telegram && (
    <a
      href={member.telegram}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors"
    >
      <Send className="h-3 w-3 shrink-0" />
      {member.telegram.replace('https://t.me/', '@')}
    </a>
  )
}

// СТАЛО:
{
  member.telegram &&
    (() => {
      const tgRaw = member.telegram
      const tgHref = tgRaw.startsWith('https://') ? tgRaw : `https://t.me/${tgRaw.replace('@', '')}`
      const tgDisplay = tgRaw.startsWith('https://t.me/')
        ? `@${tgRaw.slice('https://t.me/'.length)}`
        : tgRaw.startsWith('@')
          ? tgRaw
          : `@${tgRaw}`
      return (
        <a
          href={tgHref}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors"
        >
          <Send className="h-3 w-3 shrink-0" />
          {tgDisplay}
        </a>
      )
    })()
}
```

### Правка 2 — Скрыть кнопку "назад" для SENIOR и JUNIOR

Строки ~263-267 — кнопка ArrowLeft в шапке страницы. Показывать только для ADMIN, HR, ACCOUNTANT.
Переменная `user` уже доступна через `useAuth()`.

```tsx
// БЫЛО:
;<Button asChild variant="outline" size="icon" className="shrink-0">
  <Link to="/crm/team">
    <ArrowLeft className="h-4 w-4" />
  </Link>
</Button>

// СТАЛО:
{
  user?.role !== 'SENIOR' && user?.role !== 'JUNIOR' && (
    <Button asChild variant="outline" size="icon" className="shrink-0">
      <Link to="/crm/team">
        <ArrowLeft className="h-4 w-4" />
      </Link>
    </Button>
  )
}
```

### Правка 3 — Контакты участника: привести layout в порядок

Строки ~366-389. Сейчас `inline-flex` + `truncate` в `space-y-0.5` выглядит хаотично.
Нужно: каждый контакт — отдельная строка, `flex` (не `inline-flex`), текст усекается нормально.

```tsx
// БЫЛО:
<div className="mt-1 space-y-0.5">
  <a href={`mailto:${member.email}`}
     onClick={e => e.stopPropagation()}
     className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors truncate">
    <Mail className="h-3 w-3 shrink-0" />
    {member.email}
  </a>
  {member.telegram && (
    <a href={...tgHref...} ...
       className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors">
      ...
    </a>
  )}
  {member.phone && (
    <a href={`tel:${member.phone}`}
       className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors">
      ...
    </a>
  )}
</div>

// СТАЛО: (применить нормализацию TG из Правки 1 + исправить layout)
<div className="mt-1 flex flex-col gap-0.5 min-w-0">
  <a href={`mailto:${member.email}`}
     onClick={e => e.stopPropagation()}
     className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors min-w-0">
    <Mail className="h-3 w-3 shrink-0" />
    <span className="truncate">{member.email}</span>
  </a>
  {member.telegram && (() => {
    const tgRaw = member.telegram
    const tgHref = tgRaw.startsWith('https://') ? tgRaw : `https://t.me/${tgRaw.replace('@', '')}`
    const tgDisplay = tgRaw.startsWith('https://t.me/')
      ? `@${tgRaw.slice('https://t.me/'.length)}`
      : tgRaw.startsWith('@') ? tgRaw : `@${tgRaw}`
    return (
      <a href={tgHref} target="_blank" rel="noopener noreferrer"
         onClick={e => e.stopPropagation()}
         className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors min-w-0">
        <Send className="h-3 w-3 shrink-0" />
        <span className="truncate">{tgDisplay}</span>
      </a>
    )
  })()}
  {member.phone && (
    <a href={`tel:${member.phone}`}
       onClick={e => e.stopPropagation()}
       className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors min-w-0">
      <Phone className="h-3 w-3 shrink-0" />
      <span className="truncate">{member.phone}</span>
    </a>
  )}
</div>
```

---

## Файл 2: apps/web/app/routes/crm/team/index.tsx

### Правка 4 — Добавить текст к Telegram-иконке в Pills

Строки ~776-786. Сейчас только иконка без текста — добавить надпись "Telegram".
Расширить стиль с круглой кнопки на pill с текстом:

```tsx
// БЫЛО:
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

// СТАЛО:
<a
  href={team.telegram}
  target="_blank"
  rel="noopener noreferrer"
  onClick={e => e.stopPropagation()}
  className="inline-flex items-center gap-1.5 rounded-full border border-blue-500/30 px-2.5 py-1 text-xs font-medium text-blue-500 hover:bg-blue-500/10 transition-colors"
>
  <Send className="h-3 w-3" />
  Telegram
</a>
```

### Правка 5 — Фон у стопки аватарок: добавить bg-muted к Avatar

Строки ~746-754. Аватарки в стопке (`-space-x-2`) не перекрывают друг друга — нет фона на самом Avatar-контейнере.
Нужно добавить `bg-muted` к className Avatar:

```tsx
// БЫЛО:
<Avatar
  key={member.id}
  className="h-7 w-7 ring-2 ring-background"
  style={{ zIndex: 4 - index }}
>

// СТАЛО:
<Avatar
  key={member.id}
  className="h-7 w-7 ring-2 ring-background bg-muted"
  style={{ zIndex: 4 - index }}
>
```

---

## Acceptance criteria — верификация через git diff

После всех правок:

```bash
git diff HEAD -- apps/web/app/routes/crm/team/'$teamId.tsx'
git diff HEAD -- apps/web/app/routes/crm/team/index.tsx
```

Каждый пункт ОБЯЗАН быть в diff:

- [ ] tgHref нормализация присутствует в $teamId.tsx (startsWith https://)
- [ ] ArrowLeft обёрнут в `user?.role !== 'SENIOR' && user?.role !== 'JUNIOR'` в $teamId.tsx
- [ ] `flex flex-col gap-0.5 min-w-0` в контактном блоке $teamId.tsx
- [ ] `<span className="truncate">` у email, tg, phone в $teamId.tsx
- [ ] Telegram pill имеет текст "Telegram" и border border-blue-500/30 в index.tsx
- [ ] `bg-muted` добавлен к Avatar className в стопке index.tsx

Если хоть один пункт не в diff — вернись и исправь. Не создавай PR с неполным diff.

## После правок

```bash
pnpm --filter @crm/web typecheck
```

Потом:

```bash
git add apps/web/app/routes/crm/team/'$teamId.tsx' apps/web/app/routes/crm/team/index.tsx
git commit -m "fix(teams): UI round4 — telegram href, back button RBAC, contacts layout, TG pill text, avatar bg"
git push origin fix/teams-ui-polish
```

PR #22 уже существует — не создавай новый. Просто добавь лейбл:

```bash
gh pr edit 22 --add-label "ai-review-ready" --repo yaremenko-maksym/CheekyCheeseIT_CRM
```
