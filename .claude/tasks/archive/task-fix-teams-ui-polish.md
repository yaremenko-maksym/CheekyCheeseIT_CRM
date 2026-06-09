# task-fix-teams-ui-polish

## Агент: coder

## Приоритет: medium

## Ветка: fix/teams-ui-polish

## Зависит от: task-fix-e2e-team-selectors (E2E должны быть зелёными на main перед мерджем)

## Контекст

PR #18 реализовал основные улучшения Teams UI, но после User Testing выявлены 3 правки:

1. Telegram-ссылка команды на странице списка (`index.tsx`) — плохое позиционирование
2. Контакты участников (email, phone, telegram) в детальной странице — не кликабельные
3. Telegram-канал команды должен быть более заметным

## Конкретные изменения

### 1. Telegram-ссылка в списке команд — позиционирование (`apps/web/app/routes/crm/team/index.tsx`)

**Проблема:** ссылка на Telegram-канал команды выглядит невзрачно, теряется рядом с "HR:".

**Решение:** вынести Telegram-ссылку в отдельную строку под именем команды, сделать её визуально заметнее.

Пример улучшенного позиционирования (адаптируй по вкусу к существующему дизайну):

```tsx
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

Расположить отдельной строкой под именем команды, НЕ рядом с "HR: Имя".
Иконка `Send` (из lucide-react) лучше передаёт Telegram-бренд чем `MessageCircle`.

---

### 2. Контакты участников — кликабельные ссылки (`apps/web/app/routes/crm/team/$teamId.tsx`)

**Проблема:** email, phone, telegram в карточках участников отображаются как plain text.

**Решение:** обернуть каждый контакт в `<a>`:

```tsx
{
  /* email */
}
;<a
  href={`mailto:${member.email}`}
  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors truncate"
>
  <Mail className="h-3 w-3 shrink-0" />
  {member.email}
</a>

{
  /* telegram */
}
{
  member.telegram && (
    <a
      href={member.telegram}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors"
    >
      <Send className="h-3 w-3 shrink-0" />
      {member.telegram.replace('https://t.me/', '@')}
    </a>
  )
}

{
  /* phone */
}
{
  member.phone && (
    <a
      href={`tel:${member.phone}`}
      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors"
    >
      <Phone className="h-3 w-3 shrink-0" />
      {member.phone}
    </a>
  )
}
```

Telegram отображать красиво: `https://t.me/username` → `@username`.

---

### 3. Telegram-канал команды — более заметная ссылка в шапке (`$teamId.tsx`)

**Проблема:** ссылка на Telegram-канал команды в шапке детальной страницы слабо заметна.

**Решение:** оформить как badge/кнопку вместо текстовой ссылки:

```tsx
{
  team.telegram && (
    <a
      href={team.telegram}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 rounded-full bg-blue-500/10 px-3 py-1 text-xs font-medium text-blue-500 hover:bg-blue-500/20 transition-colors border border-blue-500/20"
    >
      <Send className="h-3 w-3" />
      Telegram-канал
    </a>
  )
}
```

---

## Acceptance criteria

- [ ] Telegram-ссылка в списке команд — отдельная строка, иконка `Send`, синий цвет
- [ ] Контакты участников (email, phone, telegram) — кликабельные ссылки (`mailto:`, `tel:`, target="\_blank")
- [ ] Telegram в карточке участника отображается как `@username` (без полного URL)
- [ ] Telegram-канал в шапке детальной страницы — styled badge (синий, скруглённый)
- [ ] `pnpm typecheck` проходит
- [ ] `pnpm lint` проходит

## Запрещено трогать

- `apps/api/**`
- `packages/shared/**`
- `apps/e2e/**`
