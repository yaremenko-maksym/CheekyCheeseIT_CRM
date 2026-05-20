# task-fix-profile-scroll

## Агент: coder
## Приоритет: high
## Ветка: claude/youthful-hermann-8df1d5 (PR #28)

## КРИТИЧЕСКИ ВАЖНО

- **Fix-задача в существующую ветку:**
  ```bash
  git fetch origin
  git checkout claude/youthful-hermann-8df1d5
  git pull origin claude/youthful-hermann-8df1d5
  ```
- Push в эту же ветку.

## Проблема (user feedback)

> "Не могу скролить табу на странице профиля. Добавь скрол"

Юзер открывает `/crm/profile` или `/crm/profile/:userId`, выбирает таб с длинным контентом (например Audit с 20 entries) и не может проскроллить — контент обрезан, скролл недоступен.

## Корень проблемы

В commit `43513eb` PM добавил `overflow-hidden` на `UserProfileShell` чтобы pill-анимация табов не вылазила за рамки. Файл: `apps/web/app/components/user-profile/UserProfileShell.tsx`

```tsx
// Линия ~73
<div className="space-y-6 overflow-hidden">  // ← root
  ...
  {permissions.tabs.length > 0 && (
    <div className="flex flex-col gap-4 overflow-hidden">  // ← tabs+content wrapper
      <div className="overflow-x-auto">
        <AnimatedTabs ... />
      </div>

      <div className="min-w-0 flex-1 overflow-hidden">  // ← content area
        {/* TabContent here — длинный, теперь не скроллится */}
        ...
      </div>
    </div>
  )}
</div>
```

`overflow-hidden` на content area блокирует скролл — длинный контент таба обрезается невидимо.

## Что нужно

Контент таба должен скроллиться (либо внутри своего контейнера, либо естественно через body scroll), но при этом pill-анимация AnimatedTabs **не должна вылазить за свои границы** (это original intent).

## Решение

**Подход (рекомендуется):**

1. **Root layer** — убрать `overflow-hidden`, чтобы body scroll работал естественно:
   ```tsx
   <div className="space-y-6">
   ```

2. **Tab bar wrapper** — оставить `overflow-x-auto` для горизонтального scroll если табов много, БЕЗ `overflow-hidden`:
   ```tsx
   <div className="overflow-x-auto pb-1">  // pb-1 чтобы pill-shadow не клипалась
     <AnimatedTabs ... />
   </div>
   ```

3. **Content area** — убрать `overflow-hidden`, оставить только `min-w-0 flex-1`:
   ```tsx
   <div className="min-w-0 flex-1">
     {/* TabContent */}
   </div>
   ```

4. **Tabs+content wrapper** — `flex flex-col gap-4` без overflow:
   ```tsx
   <div className="flex flex-col gap-4">
   ```

Должно работать естественным body scroll'ом. Поднимайся вверх по DOM до layout `/crm` (`apps/web/app/routes/crm/route.tsx`) — там основной scroll container с `overflow-y-auto` или подобным.

**Если естественный body scroll не работает (например crm layout фиксированный высотой):**
- Добавь `overflow-y-auto` на content area:
  ```tsx
  <div className="min-w-0 flex-1 overflow-y-auto">
  ```

**Pill-anim leak guard:** Если убрать `overflow-hidden` приведёт к pill-анимации вылазящей за рамки (визуально некрасиво) — добавь `relative` + `overflow-x-hidden` ТОЛЬКО на сам tab-bar div, не на родителя. И/или `mask-image` если нужен fade на краях.

## Тестирование

1. Залогинься admin (`yaremenkomaksym99@gmail.com`), открой `/crm/profile`.
2. Перейди на таб "История" — должен быть длинный список (20 audit entries). Должен скроллиться.
3. Перейди обратно на "Обзор" — pill-анимация плавная, не вылазит за рамки.
4. То же самое для `/crm/profile/sofia.bondarenko-id` (просмотр чужого профиля).
5. Resize окно — на узких экранах (mobile) горизонтальный scroll табов работает, контент тоже скроллится.

## Acceptance

- Контент любого таба скроллится при overflow
- Pill-анимация AnimatedTabs остаётся внутри tab-bar при переключении
- `pnpm exec turbo typecheck lint --force` — clean
- Push в `claude/youthful-hermann-8df1d5`

## Commit

`fix(profile): restore tab content scroll without breaking pill animation`

## После

Короткий summary: SHA коммита, конечная стратегия overflow (естественный body scroll или container-scroll), local verification.
