# task-fix-pr22-ui-round2

## Агент: coder
## Приоритет: high
## Ветка: fix/teams-ui-polish

## Контекст
Предыдущий Coder сделал минимальное изменение (переименовал "TG" → "Telegram-канал"), не выполнив задачу.
Нужны конкретные UI-правки в двух файлах. Ниже — точные изменения с кодом.

---

## ФАЙЛ 1: `apps/web/app/routes/crm/team/index.tsx`

### Правка 1.1 — AvatarFallback без фона (аватарки "сломаны")

Найди все `<AvatarFallback className="text-[10px]">` (их 2 штуки: в карточке команды и в диалоге добавления участника) и добавь фоновый цвет:

```tsx
// БЫЛО:
<AvatarFallback className="text-[10px]">{getInitials(member.displayName)}</AvatarFallback>
// СТАЛО:
<AvatarFallback className="bg-muted text-[10px]">{getInitials(member.displayName)}</AvatarFallback>
```

Также найди `<AvatarFallback className="text-[10px]">{getInitials(u.displayName)}</AvatarFallback>` и аналогично добавь `bg-muted`.

### Правка 1.2 — Telegram-кнопка вправо

Текущий layout карточки команды: `[Аватары] [Name+HR+TG] [Badges]`
Telegram-ссылка сейчас внутри среднего блока (`{/* Name + HRs */}`), после строки HR.

Нужно:
1. Убрать telegram-ссылку из среднего блока
2. Добавить иконку-кнопку Telegram в `{/* Pills */}` блок (div с `relative z-20 flex shrink-0 items-center gap-2`), ПЕРЕД badge-ами

Замена в среднем блоке — убери Telegram полностью:
```tsx
// УБРАТЬ целиком (найди по контенту и удали):
{team.telegram && (
  <a
    href={team.telegram}
    target="_blank"
    rel="noopener noreferrer"
    onClick={e => e.stopPropagation()}
    className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-500 hover:text-blue-400 transition-colors"
    title="Telegram-канал команды"
  >
    <Send className="h-3 w-3" />
    TG
  </a>
)}
```

В Pills блоке добавь Telegram-кнопку ПЕРВОЙ:
```tsx
{/* Pills */}
<div className="relative z-20 flex shrink-0 items-center gap-2">
  {team.telegram && (
    <a
      href={team.telegram}
      target="_blank"
      rel="noopener noreferrer"
      onClick={e => e.stopPropagation()}
      title="Открыть Telegram-канал"
      className="flex h-7 w-7 items-center justify-center rounded-full bg-blue-500/10 text-blue-500 ring-1 ring-blue-500/30 hover:bg-blue-500/20 hover:ring-blue-400/50 transition-all duration-150 shrink-0"
    >
      <Send className="h-3.5 w-3.5" />
    </a>
  )}
  <Badge variant="outline" className="text-[11px] tabular-nums">
    {team.members.length} уч.
  </Badge>
  {/* ... остальные Badge-ы без изменений */}
```

---

## ФАЙЛ 2: `apps/web/app/routes/crm/team/$teamId.tsx`

### Правка 2.1 — Вынести контакты из `<Link>` (stopPropagation + красивый layout)

**Проблема:** контактные ссылки (email, telegram, phone) находятся ВНУТРИ `<Link to="/crm/users/$userId">` — это nested `<a>` в `<a>`, невалидный HTML, клик по контакту открывает профиль пользователя.

**Нужно** реструктурировать карточку участника. Найди блок:

```tsx
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
      <div className="flex items-center gap-2">
        <p className="truncate text-sm font-medium leading-tight">{member.displayName}</p>
        <Badge variant={ROLE_VARIANT[member.role] ?? 'junior'} className="text-[9px] shrink-0">
          {ROLE_LABELS[member.role] ?? member.role}
        </Badge>
      </div>
      {member.techStack && (
        <Badge variant="outline" className="mt-1 text-[9px] px-1.5 py-0 font-mono">
          {member.techStack}
        </Badge>
      )}
      <div className="mt-1 space-y-0.5">
        <a href={`mailto:${member.email}`}
           className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors truncate">
          <Mail className="h-3 w-3 shrink-0" />
          {member.email}
        </a>
        {member.telegram && (
          <a href={member.telegram} target="_blank" rel="noopener noreferrer"
             className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors">
            <Send className="h-3 w-3 shrink-0" />
            {member.telegram.replace('https://t.me/', '@')}
          </a>
        )}
        {member.phone && (
          <a href={`tel:${member.phone}`}
             className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors">
            <Phone className="h-3 w-3 shrink-0" />
            {member.phone}
          </a>
        )}
      </div>
    </div>
  </Link>
```

**Замени** на структуру где контакты вынесены ЗА пределы `<Link>`:

```tsx
<motion.div
  key={member.id}
  className="rounded-lg border border-border/60 bg-card/50 p-3 transition-all hover:border-primary/20 hover:bg-card"
  whileHover={{ scale: 1.005 }}
  transition={{ duration: 0.15 }}
>
  {/* Верхняя строка: аватар + имя (кликабельно — ведёт в профиль) + кнопка удалить */}
  <div className="flex items-center justify-between gap-3">
    <Link
      to="/crm/users/$userId"
      params={{ userId: member.userId }}
      className="flex min-w-0 flex-1 items-center gap-3 hover:opacity-80 transition-opacity"
    >
      <Avatar className="h-9 w-9 shrink-0">
        {member.avatar && <AvatarImage src={member.avatar} alt={member.displayName} />}
        <AvatarFallback className="bg-muted text-xs">{getInitials(member.displayName)}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium leading-tight">{member.displayName}</p>
          <Badge variant={ROLE_VARIANT[member.role] ?? 'junior'} className="text-[9px] shrink-0">
            {ROLE_LABELS[member.role] ?? member.role}
          </Badge>
        </div>
        {member.techStack && (
          <Badge variant="outline" className="mt-0.5 text-[9px] px-1.5 py-0 font-mono">
            {member.techStack}
          </Badge>
        )}
      </div>
    </Link>
    {/* Кнопка удалить — остаётся без изменений, только перенеси её сюда */}
    {canManage && (() => {
      /* ... весь существующий код кнопки удаления без изменений ... */
    })()}
  </div>
  {/* Контакты — ОТДЕЛЬНО от Link, кликабельны сами по себе */}
  {(member.email || member.telegram || member.phone) && (
    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 pl-12">
      <a
        href={`mailto:${member.email}`}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        onClick={e => e.stopPropagation()}
      >
        <Mail className="h-3 w-3 shrink-0" />
        {member.email}
      </a>
      {member.phone && (
        <a
          href={`tel:${member.phone}`}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          onClick={e => e.stopPropagation()}
        >
          <Phone className="h-3 w-3 shrink-0" />
          {member.phone}
        </a>
      )}
      {member.telegram && (
        <a
          href={member.telegram.startsWith('https://') ? member.telegram : `https://t.me/${member.telegram.replace('@', '')}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-blue-500 hover:text-blue-400 transition-colors"
          onClick={e => e.stopPropagation()}
        >
          <Send className="h-3 w-3 shrink-0" />
          {member.telegram.startsWith('https://t.me/') ? `@${member.telegram.replace('https://t.me/', '')}` : member.telegram}
        </a>
      )}
    </div>
  )}
</motion.div>
```

**Важно:** кнопку удаления (`canManage && (() => {...})()`) перенести внутрь верхнего `<div className="flex items-center justify-between ...">` — она должна быть рядом с именем, справа.

### Правка 2.2 — Активные проекты: информация о джуне

В секции активных проектов, в блоке `{visibleProjects.map((project) => (`, внутри каждой карточки проекта найди:

```tsx
<div className="min-w-0 flex-1">
  <p className="truncate text-sm font-medium">{project.name}</p>
  <p className="truncate text-xs text-muted-foreground">{project.companyName}</p>
</div>
```

Замени на:

```tsx
<div className="min-w-0 flex-1">
  <p className="truncate text-sm font-medium">{project.name}</p>
  <p className="truncate text-xs text-muted-foreground">{project.companyName}</p>
  {(() => {
    const activeJunior = project.members?.find(
      (m: { role: string; leftAt: string | null; displayName?: string }) =>
        m.role === 'JUNIOR' && m.leftAt === null
    )
    if (activeJunior) {
      return (
        <p className="truncate text-xs text-muted-foreground mt-0.5">
          Джун: <span className="font-medium text-foreground">{activeJunior.displayName ?? '—'}</span>
        </p>
      )
    }
    return (
      <p className="text-xs text-destructive mt-0.5 font-medium">Джун не прикреплён</p>
    )
  })()}
</div>
```

Примечание: `project.members` содержит массив участников проекта. Тип ProjectDto уже импортирован. Если тип поля не совпадает — используй `as any` или приведи к нужному типу.

### Правка 2.3 — Telegram-кнопка команды: большая и красивая

В шапке страницы найди текущую telegram-ссылку команды:

```tsx
{team.telegram && (
  <a
    href={team.telegram}
    target="_blank"
    rel="noopener noreferrer"
    className="inline-flex items-center gap-1.5 rounded-full bg-blue-500/10 px-3 py-1 text-xs font-medium text-blue-500 hover:bg-blue-500/20 transition-colors border border-blue-500/20"
  >
    <Send className="h-3 w-3" />
    Telegram-канал
  </a>
)}
```

Замени на более заметную кнопку — вынести её из строки с датой создания, разместить как отдельную кнопку рядом с кнопками "Добавить" и "Редактировать":

1. Убери telegram-ссылку из `<div className="flex items-center gap-4 text-sm text-muted-foreground">` (где стоит дата создания)

2. Добавь в блок кнопок `{canManage && (<div className="flex shrink-0 gap-2">...` перед кнопкой "Добавить":

```tsx
{team.telegram && (
  <Button
    asChild
    variant="outline"
    size="sm"
    className="gap-1.5 border-blue-500/40 text-blue-400 hover:bg-blue-500/10 hover:border-blue-400/60 hover:text-blue-300"
  >
    <a href={team.telegram} target="_blank" rel="noopener noreferrer">
      <Send className="h-4 w-4" />
      Telegram
    </a>
  </Button>
)}
```

**Но:** эта кнопка должна быть видна ВСЕМ (не только canManage). Сейчас блок кнопок обёрнут в `{canManage && (...)}`. Telegram-кнопку нужно вынести НАРУЖУ этого условия.

Итоговая структура шапки:
```tsx
<motion.div variants={item} className="flex items-start justify-between gap-4">
  <div className="flex items-center gap-3">
    {/* Кнопка назад */}
    <Button asChild variant="outline" size="icon" className="shrink-0">
      <Link to="/crm/team"><ArrowLeft className="h-4 w-4" /></Link>
    </Button>
    <div>
      <h1 className="text-2xl font-bold tracking-tight">{team.name}</h1>
      {/* Только дата создания, без telegram */}
      <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Calendar className="h-3.5 w-3.5" />
        Создана {new Date(team.createdAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })}
      </div>
    </div>
  </div>
  {/* Кнопки — всегда видны (Telegram для всех, Edit/Add только canManage) */}
  <div className="flex shrink-0 gap-2">
    {team.telegram && (
      <Button asChild variant="outline" size="sm" className="gap-1.5 border-blue-500/40 text-blue-400 hover:bg-blue-500/10 hover:border-blue-400/60 hover:text-blue-300">
        <a href={team.telegram} target="_blank" rel="noopener noreferrer">
          <Send className="h-4 w-4" />
          Telegram
        </a>
      </Button>
    )}
    {canManage && (
      <>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setShowAddMember(true)}>
          <UserPlus className="h-4 w-4" />
          Добавить
        </Button>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => { editForm.setFieldValue('name', team.name); editForm.setFieldValue('telegram', team.telegram ?? ''); editForm.setFieldValue('notes', team.notes ?? ''); setShowEdit(true) }}>
          <Pencil className="h-4 w-4" />
          Редактировать
        </Button>
      </>
    )}
  </div>
</motion.div>
```

---

## Acceptance criteria
- [ ] Аватарки в списке команд показывают инициалы на цветном фоне (bg-muted)
- [ ] На /team: Telegram-кнопка — круглая иконка справа в карточке, рядом с badge-ами
- [ ] На /team/:id: клик по email/phone/telegram НЕ открывает профиль участника
- [ ] Telegram ссылка участника корректно ведёт на https://t.me/...
- [ ] В активных проектах под компанией: имя джуна или красный текст "Джун не прикреплён"
- [ ] Telegram-кнопка команды — видна всем, в блоке кнопок справа, styled outline с синим акцентом
- [ ] typecheck + lint проходят

## Запрещено трогать
- Всё кроме `apps/web/app/routes/crm/team/index.tsx` и `apps/web/app/routes/crm/team/$teamId.tsx`
- Бизнес-логику, API-вызовы, мутации, диалоги (кроме реструктуризации карточки)
