# Task: Redesign Phase 0 — App-shell (restyle to approved north-star)

## Design tier: 1 (north-star редизайн; артефакт-гейт пройден — `approved`)

## Модель: opus (фундаментальный north-star, задаёт визуальный язык всех фаз + high blast-radius — каждый роут наследует shell)

## Контекст

Это **рестайл существующего глобального app-shell** под утверждённый владельцем дизайн (Вариант А
«сдержанный», плоская навигация). Редизайн = **визуал + UX, функционал 1:1**. Это экран №1
пофазной redesign-программы (`docs/superpowers/specs/2026-06-22-crm-redesign-program.md`).

## Артефакт (единственный визуальный источник — читай по абсолютному пути из master-worktree)

Артефакт закоммичен на ветке `claude/thirsty-brattain-34ab4a`. Если твоего worktree-бранча нет этих
файлов — читай их по АБСОЛЮТНОМУ пути:

- **Spec (coder-ready):** `/Users/maksym/Desktop/programming/CheekyCheeseIT_CRM/.claude/worktrees/thirsty-brattain-34ab4a/docs/design/screens/_foundation/app-shell.md` — ПОЛНОЕ описание блоков 1:1, token-map, состояния, решение владельца. **Читай первым.**
- **`design.png`** (главный fidelity-референс — Вариант А): `…/docs/design/screens/_foundation/assets/app-shell/design.png`
- **`design-states.png`** (4 состояния): `…/docs/design/screens/_foundation/assets/app-shell/design-states.png`
- **Направление:** `…/docs/design/foundation.md` (визуальный язык: плотность, type-scale, семантика цвета, motion, a11y).

## Файлы (zone: apps/web/\*\* — Coder)

Источник истины текущего shell (читай через codegraph/Read перед правкой):

- `apps/web/app/routes/_authenticated/route.tsx` — `CrmLayout`: header + body + ambient-фон + loading + onboarding-bare.
- `apps/web/app/components/crm/nav-sidebar.tsx` — `NavSidebar`: desktop aside + mobile Sheet.
- `apps/web/app/components/layout/notifications-bell.tsx` — колокол + dropdown (если требует визуального рестайла под дизайн).
- При необходимости: `apps/web/app/components/crm/StickyPageHeader.tsx`. **НЕ менять** `globals.css` токены (рестайл идёт на существующих токенах; если кажется, что нужен новый токен — стоп, отметь в `.blocked.md`).

## Что делаем (рестайл по `design.png`)

Привести app-shell к виду `design.png`: glassy-хедер, плоский сайдбар с активным пунктом
(тёплый фон + лево-полоса `border-primary` + жёлтая иконка), плотная контент-область. Точная раскладка/
отступы/иерархия/типографика — по `design.png` + `app-shell.md` §«Реальные блоки» + `foundation.md`.

## Acceptance Criteria

1. **Визуал = `design.png`** (Вариант А): хедер, плоский сайдбар, контент-хром, состояния (свёрнутый/мобайл/уведомления — `design-states.png`). Mode B fidelity PASS.
2. **Функционал 1:1 (КРИТИЧНО):** сохранены ВСЕ блоки и поведение — 12 пунктов навигации в том же порядке и role-фильтре (`navRolesFor`), teamless-SENIOR-гейт, collapse + localStorage, мобильный Sheet, NotificationsBell (polling + dropdown + mark-read + delete + empty/loading), user-menu (профиль/выйти/роль-бейдж), кнопка поиска (плейсхолдер — оставить), TosUpdateBanner, ambient-фон (можно гармонизировать, не удалять), onboarding-bare режим, loading-skeleton. **Ничего не добавлять/не удалять/не переименовывать.** Роуты/RBAC/бизнес-логику НЕ трогать.
3. **Навигация ПЛОСКАЯ** — без секций-заголовков (владелец отклонил группировку).
4. **Только наши компоненты/токены:** shadcn/ui + композиты + семантические токены `globals.css`. Без сырого hex/oklch, без generic-градиентов, без новых зависимостей. **НЕ копировать** сырой экспортный HTML/JSX из CD.
5. **Responsive** 320/768/1024/1440 без overflow; **a11y** WCAG 2.2 AA (видимый focus, target-size ≥24px, контраст, aria-label на icon-only, focus-trap в Sheet/Dropdown).
6. **E2E:** `pnpm --filter @crm/e2e test` зелёный локально (навигация по всем разделам, role-фильтр, collapse, мобайл, уведомления). Zero-flaky. app-shell трогает каждый роут — гоняй полно.
7. **typecheck + lint** чисто (`mcp__eslint__lint-files` на изменённых, `pnpm typecheck`).

## Worktree-провижн (ОБЯЗАТЕЛЬНО)

Свежий worktree без node_modules → husky-хуки падают. До работы:
`pnpm install --frozen-lockfile` + `pnpm --filter @crm/web build` (генерит `routeTree.gen.ts`, gitignored).
Все Edit/Write — ВНУТРИ своего worktree; после первого edit проверь `git -C <worktree> status`; НЕ писать
по абсолютным путям master-repo (артефакт читаем по абс.пути — но НЕ писать туда). НЕ `--no-verify`.
Пуш feature-ветки: `DATABASE_URL= git push`. Коммит с `ac_verified:`.

## Прогресс / блокеры

Пиши прогресс в `.claude/tasks/task-redesign-app-shell.progress.md`; блокеры — `.claude/tasks/task-redesign-app-shell.blocked.md`.
По завершении — отчёт: ветка, commit SHA, какие файлы, результат E2E/typecheck/lint, и что именно
визуально изменено vs текущий shell (для Mode B).
