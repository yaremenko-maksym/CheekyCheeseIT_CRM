# task-fix-user-avatar-dropdown

## Агент: coder

## Приоритет: HIGH (юзер не может выйти из системы через UI)

## Ветка: fix/user-avatar-dropdown (НОВАЯ, base = main)

## Контекст

В header'е CRM (правый угол) клик на аватар пользователя НЕ открывает dropdown menu с Профиль/Выход. Юзер сам сообщил со скриншотом.

### Repro

1. Залогиниться (любой role)
2. Открыть любой /crm/\* route
3. Кликнуть на аватар справа в шапке
4. **Ожидается:** dropdown с именем, email, role badge, «Профиль», «Выйти»
5. **Фактически:** ничего не происходит

### Root cause (diagnosed PM через playwright DOM + ast-grep)

**`apps/web/app/routes/crm/route.tsx:182-233`:**

```tsx
<DropdownMenu>
  <DropdownMenuTrigger asChild>
    <UserAvatar
      avatarDocumentId={user.avatarDocumentId ?? null}
      avatarUrl={user.avatarUrl}
      displayName={user.displayName}
      className="..."
    />
  </DropdownMenuTrigger>
  <DropdownMenuContent>...</DropdownMenuContent>
</DropdownMenu>
```

**`apps/web/app/components/users/UserAvatar.tsx:35-58`:**

```tsx
function UserAvatar({
  avatarDocumentId,
  avatarUrl,
  displayName,
  className,
  imgClassName,
}: UserAvatarProps) {
  return <Avatar className={cn(className)}>...</Avatar>
}
```

**Проблема:** Radix UI `DropdownMenuTrigger asChild` инжектирует click handler + ref в child element. UserAvatar — function component **БЕЗ `React.forwardRef`** → Radix не может attach ref → click handler теряется → trigger non-functional. DOM показывает avatar как `<span>` без button role или onClick.

## AC

- [ ] **AC1: UserAvatar поддерживает forwardRef**
  - В `apps/web/app/components/users/UserAvatar.tsx` обернуть компонент в `React.forwardRef`:
    ```tsx
    const UserAvatar = React.forwardRef<HTMLSpanElement, UserAvatarProps>(
      ({ avatarDocumentId, avatarUrl, displayName, className, imgClassName }, ref) => (
        <Avatar ref={ref} className={cn(className)}>
          ...
        </Avatar>
      ),
    )
    UserAvatar.displayName = 'UserAvatar'
    ```
  - Avatar component из shadcn/ui (`components/ui/avatar.tsx`) уже поддерживает ref (Radix Avatar.Root). Просто пробросить.

- [ ] **AC2: Avatar также принимает onClick и других props от Radix**
  - Use `...props` spread на корневой `<Avatar>` чтобы Radix мог attach click handler + aria-haspopup + state attrs:
    ```tsx
    const UserAvatar = React.forwardRef<HTMLSpanElement, UserAvatarProps>(
      ({ avatarDocumentId, avatarUrl, displayName, className, imgClassName, ...props }, ref) => (
        <Avatar ref={ref} className={cn(className)} {...props}>
          ...
        </Avatar>
      ),
    )
    ```

- [ ] **AC3: Dropdown открывается на клик аватара**
  - Manual smoke (через playwright):
    1. Login as Oleksiy (SENIOR) → /crm/finance
    2. Click на avatar в правом углу шапки
    3. Verify: dropdown открыт с Oleksiy Kovalenko / email / SENIOR badge / Профиль link / Выйти button
    4. Click «Выйти» → юзер logged out, на /login

- [ ] **AC4: Не сломаны другие consumers UserAvatar**
  - В коде UserAvatar используется ещё в (проверь ast-grep):
    - `apps/web/app/routes/crm/route.tsx` (header dropdown)
    - Other places — verify import paths
  - Все consumers должны продолжать работать (UserAvatar без forwardRef прежде работал в обычных контекстах — после forwardRef всё equally functional)

## Файлы (ожидаемые изменения)

- `apps/web/app/components/users/UserAvatar.tsx` — добавить forwardRef + props spread (~5 строк изменений)

## Definition of Done

- ac_verified: 1,2,3,4
- Manual smoke playwright pass (см. AC3)
- Unit tests pass: `pnpm test`
- Typecheck pass: `pnpm typecheck`
- ESLint pass: `pnpm lint`
- E2E локально: `pnpm --filter @crm/e2e test`

## Заметки для Coder

- Branch base = main (PR #59 уже смержен, main содержит sort fix)
- `git checkout main && git pull && git checkout -b fix/user-avatar-dropdown`
- Получить task file: `git checkout claude/musing-jang-a12f39 -- docs/specs/tasks/task-fix-user-avatar-dropdown.md`
- ВКЛЮЧИТЬ task file в commit
- НЕ создавать дополнительные .md
- Push → `gh pr create` против main
- НЕ ставить labels — PM сделает

## Дополнительный контекст

PR #56 (payout simulate + auth fix) всё ещё OPEN на feature/invoice-ui — НЕ зависит от этого fix. Не нужно ждать его merge.
