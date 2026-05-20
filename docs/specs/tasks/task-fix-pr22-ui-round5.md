# task-fix-pr22-ui-round5

## Агент: coder
## Приоритет: critical
## Ветка: fix/teams-ui-polish

## КРИТИЧЕСКИ ВАЖНО

Перед каждым [x] выполни `git diff HEAD -- <файл>` и убедись что изменение ЕСТЬ в diff.
Если изменения нет в diff — ты его не сделал. Вернись и сделай заново.

Предыдущий раунд (round4) сделал РЕГРЕССИЮ в index.tsx — телеграм вернули в среднюю колонку вместо Pills. Эту регрессию нужно исправить в этом раунде.

---

## ИЗМЕНЕНИЕ 1 — index.tsx: убрать TG из средней колонки, вернуть в Pills с текстом

Файл: `apps/web/app/routes/crm/team/index.tsx`

Найди этот блок (строки ~764-800):

```tsx
                {/* Name + HRs + Telegram */}
                <div className="relative z-20 min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold group-hover:text-primary transition-colors">
                    {team.name}
                  </p>
                  <p className="truncate text-xs text-muted-foreground overflow-hidden whitespace-nowrap">
                    HR: {hrMembers.map((m) => m.displayName).join(', ') || 'Без HR'}
                  </p>
                  {team.telegram && (
                    <a
                      href={team.telegram}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={e => e.stopPropagation()}
                      className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-500 hover:text-blue-400 transition-colors mt-0.5"
                    >
                      <Send className="h-3 w-3" />
                      Telegram-канал
                    </a>
                  )}
                </div>

                {/* Pills */}
                <div className="relative z-20 flex shrink-0 items-center gap-2">
                  <Badge variant="outline" className="text-[11px] tabular-nums">
```

Замени на:

```tsx
                {/* Name + HRs */}
                <div className="relative z-20 min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold group-hover:text-primary transition-colors">
                    {team.name}
                  </p>
                  <p className="truncate text-xs text-muted-foreground overflow-hidden whitespace-nowrap">
                    HR: {hrMembers.map((m) => m.displayName).join(', ') || 'Без HR'}
                  </p>
                </div>

                {/* Pills */}
                <div className="relative z-20 flex shrink-0 items-center gap-2">
                  {team.telegram && (
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
                  )}
                  <Badge variant="outline" className="text-[11px] tabular-nums">
```

---

## ИЗМЕНЕНИЕ 2 — index.tsx: добавить bg-muted к Avatar-контейнеру в стопке

Файл: `apps/web/app/routes/crm/team/index.tsx`

Найди (строки ~746-748):
```tsx
                    <Avatar
                      key={member.id}
                      className="h-7 w-7 ring-2 ring-background"
                      style={{ zIndex: 4 - index }}
                    >
```

Замени на:
```tsx
                    <Avatar
                      key={member.id}
                      className="h-7 w-7 ring-2 ring-background bg-muted"
                      style={{ zIndex: 4 - index }}
                    >
```

---

## ИЗМЕНЕНИЕ 3 — $teamId.tsx: скрыть кнопку "назад" для SENIOR и JUNIOR

Файл: `apps/web/app/routes/crm/team/$teamId.tsx`

Найди (строки ~263-267):
```tsx
          <Button asChild variant="outline" size="icon" className="shrink-0">
            <Link to="/crm/team">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
```

Замени на:
```tsx
          {user?.role !== 'SENIOR' && user?.role !== 'JUNIOR' && (
            <Button asChild variant="outline" size="icon" className="shrink-0">
              <Link to="/crm/team">
                <ArrowLeft className="h-4 w-4" />
              </Link>
            </Button>
          )}
```

---

## ИЗМЕНЕНИЕ 4 — $teamId.tsx: восстановить крупный стиль Telegram-кнопки в шапке

Файл: `apps/web/app/routes/crm/team/$teamId.tsx`

Round4 сделал регрессию — уменьшил кнопку. Верни крупный стиль.

Найди (строки ~282-286):
```tsx
                  className="inline-flex items-center gap-1.5 rounded-full bg-blue-500/10 px-3 py-1 text-xs font-medium text-blue-500 hover:bg-blue-500/20 transition-colors border border-blue-500/20"
```

Замени на:
```tsx
                  className="inline-flex items-center gap-2 rounded-lg border border-blue-500/50 px-4 py-2 text-sm font-medium text-blue-400 hover:bg-blue-500/10 hover:border-blue-400 transition-colors"
```

---

## ИЗМЕНЕНИЕ 5 — $teamId.tsx: исправить layout контактов и нормализовать TG href

Файл: `apps/web/app/routes/crm/team/$teamId.tsx`

**ШАГ А** — добавь две helper-функции ПЕРЕД строкой `return (` внутри компонента `TeamDetailPage`.
Найди строку `return (` в теле основного компонента (не внутри `.map()`) и вставь ПЕРЕД ней:

```tsx
  function tgHref(tg: string) {
    return tg.startsWith('https://') ? tg : `https://t.me/${tg.replace('@', '')}`
  }
  function tgDisplay(tg: string) {
    if (tg.startsWith('https://t.me/')) return `@${tg.slice('https://t.me/'.length)}`
    return tg.startsWith('@') ? tg : `@${tg}`
  }

```

**ШАГ Б** — замени весь контактный блок. Найди:
```tsx
                            <div className="mt-1 space-y-0.5">
                              <a href={`mailto:${member.email}`}
                                 onClick={e => e.stopPropagation()}
                                 className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors truncate">
                                <Mail className="h-3 w-3 shrink-0" />
                                {member.email}
                              </a>
                              {member.telegram && (
                                <a href={member.telegram} target="_blank" rel="noopener noreferrer"
                                   onClick={e => e.stopPropagation()}
                                   className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors">
                                  <Send className="h-3 w-3 shrink-0" />
                                  {member.telegram.replace('https://t.me/', '@')}
                                </a>
                              )}
                              {member.phone && (
                                <a href={`tel:${member.phone}`}
                                   onClick={e => e.stopPropagation()}
                                   className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors">
                                  <Phone className="h-3 w-3 shrink-0" />
                                  {member.phone}
                                </a>
                              )}
                            </div>
```

Замени на:
```tsx
                            <div className="mt-1 flex flex-col gap-0.5 min-w-0">
                              <a href={`mailto:${member.email}`}
                                 onClick={e => e.stopPropagation()}
                                 className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors min-w-0">
                                <Mail className="h-3 w-3 shrink-0" />
                                <span className="truncate">{member.email}</span>
                              </a>
                              {member.telegram && (
                                <a href={tgHref(member.telegram)} target="_blank" rel="noopener noreferrer"
                                   onClick={e => e.stopPropagation()}
                                   className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors min-w-0">
                                  <Send className="h-3 w-3 shrink-0" />
                                  <span className="truncate">{tgDisplay(member.telegram)}</span>
                                </a>
                              )}
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

## Acceptance criteria — проверка через git diff

```bash
git diff HEAD -- apps/web/app/routes/crm/team/index.tsx
git diff HEAD -- apps/web/app/routes/crm/team/'$teamId.tsx'
```

Каждый пункт ОБЯЗАН быть в diff:

**index.tsx:**
- [ ] Удалён блок `{team.telegram && (<a ... >Telegram-канал</a>)}` из средней колонки
- [ ] Комментарий изменён с `{/* Name + HRs + Telegram */}` на `{/* Name + HRs */}`
- [ ] В Pills добавлен `{team.telegram && (<a ... >Telegram</a>)}` с классом `border-blue-500/30`
- [ ] Avatar в стопке имеет `bg-muted` в className

**$teamId.tsx:**
- [ ] ArrowLeft обёрнут в `user?.role !== 'SENIOR' && user?.role !== 'JUNIOR'`
- [ ] TG кнопка в шапке имеет `border-blue-500/50 px-4 py-2 text-sm`
- [ ] Контактный блок начинается с `flex flex-col gap-0.5 min-w-0`
- [ ] TG href использует `tgHref(member.telegram)`
- [ ] Функции `tgHref` и `tgDisplay` добавлены в компонент

Если хоть один пункт не в diff — вернись и исправь. Не пушь с неполным diff.

---

## После правок

```bash
pnpm --filter @crm/web typecheck
```

Затем:
```bash
git add apps/web/app/routes/crm/team/index.tsx apps/web/app/routes/crm/team/'$teamId.tsx'
git commit -m "fix(teams): UI round5 — TG to pills with text, avatar bg, back btn RBAC, contacts layout, TG href"
git push origin fix/teams-ui-polish
```

PR #22 уже существует — просто добавь лейбл:
```bash
gh pr edit 22 --add-label "ai-review-ready" --repo yaremenko-maksym/CheekyCheeseIT_CRM
```
