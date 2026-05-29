# task-fix-round2-polish

## Агент: coder

## Приоритет: MEDIUM (раунд-2 находки из UT-сweep)

## Ветка: chore/remove-knowledge-base (СУЩЕСТВУЮЩАЯ — фикс внутрь неё)

## Repo: yaremenko-maksym/CheekyCheeseIT_CRM

## Контекст

PM прогнал UT-сweep по всем модулям (раунд 2). Раунд-1 полировка уже в ветке (forwardRef, синьор, валюта, аватары, валидация, Not-Found — НЕ трогай). Здесь 3 новые находки.

## КРИТИЧНО — ветка

target_branch `chore/remove-knowledge-base` УЖЕ checked out в основном worktree (PM держит dev-сервер). НЕ делай `git checkout chore/remove-knowledge-base` (git заблокирует). Создай рабочую ветку ОТ неё:

```
git checkout -b fix/round2-polish chore/remove-knowledge-base
git log --oneline -3   # верхний = 3d6d795 (раунд-1 полировка)
```

PM смержит `fix/round2-polish` обратно в `chore/remove-knowledge-base`.

## AC

- [ ] **AC1 (P2): Убрать вложенный `<a>` в `<a>` на детали команды**
  - Файл: `apps/web/app/routes/crm/team/$teamId.tsx` (≈line 100, компонент `TeamDetailPage`).
  - Симптом (консоль, повторяется ×N участников): `Warning: validateDOMNesting(...): <a> cannot appear as a descendant of <a>`. Карточка участника обёрнута в TanStack `<Link>` (→ профиль), а ВНУТРИ ещё один якорь (вероятно `<Link>` на имени, либо `<a href="mailto:">` / `<a href="tg://">` для email/telegram).
  - Fix: устранить вложенность якорей. Варианты (выбери чистый): сделать внешнюю обёртку НЕ-якорем (div + onClick `navigate` / `router.navigate`), ИЛИ оставить кликабельной только одну сущность (например имя — `<Link>`, а карточку — обычный div). email/telegram-ссылки (mailto:/tg:) должны остаться рабочими и НЕ быть внутри другого `<a>`.
  - Проверка: открыть деталь команды → консоль чистая (0 validateDOMNesting), клики по карточке/имени/email/telegram работают как ожидалось.

- [ ] **AC2 (minor): Гейтить `GET /api/users` по роли на странице собеседований**
  - Файл: `apps/web/app/routes/crm/interviews/index.tsx` (+ хук, вероятно `useUsers()` / `api.get('/users')`).
  - Симптом: как SENIOR страница дважды дёргает `/api/users` → **403 Forbidden** (бэк не даёт SENIOR список всех юзеров). Список юзеров нужен только для HR/ADMIN (селектор доски синьора).
  - Fix: гейтить запрос — `enabled: role === 'HR' || role === 'ADMIN'` (TanStack Query `enabled`), чтобы SENIOR его не делал. Убедись что HR-селектор досок продолжает работать. Дубль-запрос (×2) тоже устранить если он от двойного маунта/неустойчивого ключа.
  - Проверка: SENIOR на /crm/interviews → консоль без 403; HR — селектор синьоров работает.

- [ ] **AC3 (minor, best-effort): Google GSI/FedCM console-шум на login**
  - Файл: `apps/web/app/routes/crm_/login.tsx`.
  - Симптом: на `/crm/login` без Google-сессии GSI/FedCM сыплет `[GSI_LOGGER] FedCM get() rejects with NetworkError` + «Not signed in with the identity provider».
  - Fix: инициализировать GSI лениво (по клику «Войти с Google») вместо авто-init на маунте, либо обернуть init в try/catch / отключить FedCM auto-prompt. Если рискованно ломает OAuth-flow — оставь заметку в PR и пропусти.
  - Проверка: `/crm/login` — консоль без GSI-ошибок (или заметка почему пропущено). OAuth-redirect на Google по клику должен остаться рабочим.

## Файлы (ожидаемые)

- `apps/web/app/routes/crm/team/$teamId.tsx` — AC1
- `apps/web/app/routes/crm/interviews/index.tsx` (+ users hook) — AC2
- `apps/web/app/routes/crm_/login.tsx` — AC3

## Definition of Done

- ac_verified: 1,2 (3 — best-effort)
- `pnpm typecheck` + `pnpm lint` + `pnpm test` pass
- `pnpm --filter @crm/e2e test` локально pass перед push (если падает по ресурсам — честно отметь; не ломай существующие тесты)
- Коммить по AC. Push `fix/round2-polish`. НЕ ставь лейблы, НЕ мержи — PM смержит в `chore/remove-knowledge-base`.

## Out of scope

- Dashboard (#9) — отложено пользователем (планируем при его разработке).
- Nits (UAH ФОП lock, Статистика «Маржа 100%») — НЕ трогать в этом таске.
- Новые E2E — AutoTest сделает отдельно после твоего merge.

## Заметки для Coder

- Перед началом `git log --oneline -3` → верхний коммит 3d6d795 (раунд-1). Проверяй UI через `pnpm dev` + браузер после каждого AC (особенно консоль для AC1/AC2).
- Отчёт ≤150 слов: что сделано по AC, typecheck/lint/test/e2e результаты (честно), изменённые файлы, ветка + commit SHA.
