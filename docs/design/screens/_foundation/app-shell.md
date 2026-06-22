# App-shell — Foundation (Phase 0 north-star)

> Per-screen artifact (CRM redesign). Coder-ready spec на наших shadcn/ui + токенах. Headless-агенты
> опираются ТОЛЬКО на этот файл + `assets/` (браузер им недоступен). Шаблон: `docs/design/screens/_TEMPLATE.md`.
> Направление: `docs/design/foundation.md`. Программа: `docs/superpowers/specs/2026-06-22-crm-redesign-program.md`.

| Поле               | Значение                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------- |
| Screen             | App-shell (глобальный каркас: header + nav-sidebar + content chrome)                      |
| Route / trigger    | `apps/web/app/routes/_authenticated/route.tsx` (`CrmLayout`) — наследуется КАЖДЫМ экраном |
| Roles              | Все 6 (ADMIN/SENIOR/JUNIOR/HR/ACCOUNTANT/DROP) — sidebar role-filtered                    |
| Claude Design URL  | `https://claude.ai/design/p/cb5277cf-5b56-44ff-9a6a-4404d8c92cea`                         |
| Status             | `approved` (владелец 2026-06-23)                                                          |
| Last synced commit | `86d72c32` (база; редизайн = рестайл текущего shell)                                      |

---

## Fidelity reference

- **Claude Design проект:** `https://claude.ai/design/p/cb5277cf-5b56-44ff-9a6a-4404d8c92cea` (система `CheekyCheeseIT CRM`, Opus 4.8; проект «CRM глобальный каркас»).
- **`design.png`** — главный fidelity-референс для Mode B: кадр **Варианта А** (хедер + плоский сайдбар + плотная таблица «Пользователи»), faithful server-рендер Claude Design.
- **`design-states.png`** — все 4 состояния в одном кадре: default (Вариант А) · сайдбар свёрнут · уведомления открыты · мобайл-overlay.
- **Кодер строит НАШИМИ shadcn/ui компонентами** по spec ниже, сверяясь визуально с `design.png`. Сырые исходники Claude Design (generic CD-классы, не наши компоненты) в репо **НЕ коммитим** — во избежание копипасты + лишнего веса (3 МБ runtime-бандл); при нужде полный Project-archive экспортируется из CD-проекта по URL выше.
- _Как получен `design.png`:_ `/design` → Export → **Project archive** → распаковка (`ditto`, юникод-имена) → локальный `http.server` → Playwright рендер showcase-страницы (sibling резолвится) → кроп Варианта А. Прямая растеризация рендера CD недоступна (Chrome MCP `save_to_disk` не пишет файл; print-URL виснет в Playwright) — archive-путь надёжен и автономен, **без ручного скриншота владельца**.
- **Решение владельца 2026-06-23:** ведём **Вариант А «сдержанный»**; навигация — **ПЛОСКИЙ список** (группировка по секциям РАБОЧЕЕ ПРОСТРАНСТВО/УПРАВЛЕНИЕ/ЛИЧНОЕ отклонена). Остальное одобрено.

## Реальные блоки (1:1 — НИЧЕГО не добавлять, не удалять)

Источник истины — код `_authenticated/route.tsx` + `components/crm/nav-sidebar.tsx` +
`components/layout/notifications-bell.tsx`. Редизайн = рестайл ЭТИХ блоков, не новые.

### A. Header (верхний бар) — `sticky top-0 z-40`, glassy (`bg-background/80 backdrop-blur-md`), `border-b`, `px-6 py-3`

- **Слева (gap-3):**
  1. Кнопка-бургер (`Menu` icon, **только ≤768px** `md:hidden`) — открывает мобильный sidebar-Sheet.
  2. Бренд-линк на `/`: `BrandMark` (h-7 w-7, `text-primary`) + текст «CheekyCheeseIT» (`font-semibold tracking-tight`).
  3. `Badge variant="outline"` «CRM» (**скрыт <640px**, `sm:flex`).
- **Справа (gap-1):** 4. Кнопка-иконка «Поиск» (`Search`, ghost, `aria-label`). _Существующий блок-плейсхолдер — сохранить как есть._ 5. **NotificationsBell** — `Bell` ghost-кнопка + unread-бейдж (круглый `bg-primary text-primary-foreground`, «99+» cap); dropdown w-80: header «Уведомления» + «Прочитать всё» (CheckCheck), список строк (TypeIcon + title + body line-clamp-2 + relative-время ru + unread-точка + Trash на hover), empty-state (Inbox + «Уведомлений нет»), loading-skeleton. 6. **User-menu** (DropdownMenu, trigger = `UserAvatar` h-8, fallback `bg-primary/20 text-primary`): label (displayName + email muted), role-`Badge` (variant=роль), «Профиль» (UserCircle → `/profile`), «Выйти» (LogOut).

### B. NavSidebar — `components/crm/nav-sidebar.tsx`

- **Desktop:** `<aside>` `bg-background`, `border-r border-border/60`, ширина **208px** (`w-52`) / collapsed **56px** (`w-14`), `transition-[width] 200ms`. Без шапки-бренда (бренд в header). Внутри:
  - `ScrollArea` → `<nav>` (`flex-col gap-0.5 p-2 pt-3`) — плоский список role-filtered пунктов.
  - Низ: `border-t` + collapse-toggle (ghost icon, Chevron Left/Right, tooltip «Свернуть/Развернуть»).
- **Пункты (12, порядок фиксирован; видимость по роли через `navRolesFor()`):** Мой проект (Home), Легенда (BookOpen), Дашборд (LayoutDashboard, active-exact), Пользователи (Users), Админ (Settings), Команда (UsersRound), Проекты (Briefcase), Финансы (DollarSign), Статистика (BarChart3), Собеседования (KanbanSquare), Документы (FileText), Профиль (UserCircle, последний). _Teamless SENIOR прячет Проекты+Собеседования._
- **Пункт (link):** `text-muted-foreground` → hover `bg-accent text-accent-foreground` → active `bg-accent text-accent-foreground` + лево-бордер `border-l-2 border-primary` + иконка `text-primary`. Collapsed: центр-иконка + tooltip + active-ring.
- **Mobile:** `Sheet` (side left, w-60) со СВОЕЙ шапкой-брендом (BrandMark flat + «CheekyCheeseIT») + тот же список.

### C. Content chrome

- `<main>` `flex-1 min-h-0 flex flex-col overflow-hidden`, `scrollbar-gutter: stable` → `<Outlet/>` (контент экрана).
- Между header и body — **TosUpdateBanner** (conditional: `tosUpdateAvailable && !requiresTos`).

### D. Ambient-фон (декоративная глубина, существующий)

3 размытых motion-blob'а (`bg-primary/[0.05]`, `bg-violet-500/[0.05]`, `bg-amber-500/[0.035]`, blur 100–120px),
`fixed inset-0 -z-10 pointer-events-none`, медленный дрейф 24–36s, **пауза при скрытом табе**. Сохранить
атмосферу (можно гармонизировать к бренду), не превращать в AI-slop blob-градиент.

### E. Onboarding-режим

Если путь `/onboarding*` → рендерится ТОЛЬКО `<Outlet/>` (без header/sidebar). Не трогать.

---

## Состояния

| Состояние     | Эталон                                         | Заметки                                                                                 |
| ------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------- |
| default       | `assets/app-shell/design.png`                  | Вариант А: ADMIN, развёрнутый sidebar, desktop 1360px (главный референс)                |
| collapsed     | `assets/app-shell/design-states.png` (фрейм 2) | sidebar `w-14`, иконки + tooltips                                                       |
| notifications | `assets/app-shell/design-states.png` (фрейм 3) | открытый bell-dropdown (список + unread-бейдж)                                          |
| mobile        | `assets/app-shell/design-states.png` (фрейм 4) | ≤768: бургер + Sheet-overlay sidebar (плоский список)                                   |
| role-junior   | — (не сгенерён)                                | механически: nav-фильтр `navRolesFor` → 5 пунктов JUNIOR (как в текущем коде) + рестайл |
| loading       | — (не сгенерён)                                | сохранить существующий skeleton (`isLoading` ветка route.tsx), рестайл наследуется      |

> Сгенерённые состояния — в `design-states.png` (один кадр, 4 фрейма) + `design.png` (default крупно).
> `role-junior` и `loading` дизайн не генерил: выводятся из существующего кода (role-фильтр nav + skeleton) — сохранить, рестайл наследуется от каркаса.

---

## Компоненты (маппинг на наш стек)

Существующие — НЕ вводить новые (inventory `docs/design/assets/_design-system/inventory.md`):

| Визуальный блок          | Наш компонент (shadcn/ui / композит)                   | Новый? |
| ------------------------ | ------------------------------------------------------ | ------ |
| Header bar               | layout-разметка в `route.tsx` (не отдельный компонент) | нет    |
| Бренд                    | `BrandMark` + текст                                    | нет    |
| «CRM» бейдж / role-бейдж | `Badge` (outline / role-варианты)                      | нет    |
| Поиск / меню-триггеры    | `Button` (ghost, size icon)                            | нет    |
| Уведомления              | `NotificationsBell` (+ `DropdownMenu`, `Skeleton`)     | нет    |
| User-меню                | `DropdownMenu` + `UserAvatar`                          | нет    |
| Sidebar                  | `NavSidebar` (+ `ScrollArea`, `Sheet`, `Tooltip`)      | нет    |
| Content scroll           | `<main>` + `Outlet`                                    | нет    |
| ToS-баннер               | `TosUpdateBanner`                                      | нет    |
| Ambient-фон              | `motion.div` blobs (framer-motion)                     | нет    |

---

## Token-map

Только токены `globals.css` (без сырого hex). См. `foundation.md` §5.

- Канвас: `bg-background` · header: `bg-background/80` + `backdrop-blur-md` + `border-border/60`.
- Sidebar: `bg-background` + `border-r border-border/60`; active-пункт `bg-accent` + `text-accent-foreground` + `border-primary`; иконка active `text-primary`; пункт `text-muted-foreground`.
- Бренд/акценты: `text-primary`; unread-бейдж `bg-primary text-primary-foreground`.
- Avatar fallback: `bg-primary/20 text-primary`.
- Тексты: `text-foreground` / `text-muted-foreground`.

---

## A11y / responsive / motion

- **A11y (WCAG 2.2):** target-size ≥24px (icon-кнопки header); `aria-label` на Поиск/Bell/меню; focus-ring `ring-ring` (user-trigger уже имеет `focus-visible:ring-2`); focus-trap в Sheet/Dropdown (Radix); sidebar-Sheet несёт sr-only Title+Description.
- **Responsive:** ≤768 — sidebar→Sheet (бургер в header), «CRM»-бейдж скрыт <640; 1024–1440 — основной desktop; header sticky, не прыгает.
- **Motion:** sidebar width-transition 200ms ease-in-out; ambient-blobs 24–36s (пауза при hidden-табе; `transform`/`scale` — compositor-friendly); уважать `prefers-reduced-motion`. Compositor-only, без layout-анимаций.

---

## Бриф для генерации (Claude Design, system `CheekyCheeseIT CRM`)

**Задача:** профессионально перерисовать ГЛОБАЛЬНЫЙ app-shell CRM (header + left nav-sidebar + content
chrome) на едином визуальном языке `foundation.md`. Это north-star — задаёт направление всему приложению.

**Сохранить 1:1 (add nothing not listed):** все блоки A–E выше — те же пункты навигации (12, role-filtered),
те же элементы header (бренд, CRM-бейдж, Поиск, Уведомления, User-меню), collapse-sidebar, mobile-Sheet,
ToS-баннер, ambient-фон, onboarding-bare-режим. **НЕ добавлять** новых пунктов/кнопок/виджетов; НЕ
переименовывать пункты; НЕ менять навигационную структуру/роутинг/RBAC.

**Менять ТОЛЬКО:** визуал/иерархию/отступы/плотность/расположение по канонам UI/UX — чтобы было
профессионально, спокойно, сканируемо (dense operations-консоль, dark-default, бренд-жёлтый дисциплинированно).

**Tone / constraints:** `foundation.md` §1 (dense·quiet·scannable·professional) + Tailwind v4 + shadcn/ui +
Russian UI + WCAG 2.2 AA + responsive 320/768/1024/1440 + наши 218 токенов. Anti-slop: без purple-градиентов,
oversized hero, карточек-в-карточках, жёлтых заливок площадей.

**Состояния для генерации:** default (ADMIN, desktop) · collapsed-sidebar · JUNIOR-роль (5 пунктов) ·
mobile (Sheet) · notifications-dropdown открыт.
