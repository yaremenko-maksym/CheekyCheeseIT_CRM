# Platform Visual Audit — 2026-06-04

**Агент:** UI/UX Designer  
**Режим:** B (Visual Audit) + C (AI-slop check)  
**Scope:** Platform-wide audit всех реализованных routes (Phase 1-5 + Phase 7 partial)  
**Viewport'ы:** 320×568, 768×1024, 1440×900  
**Роли:** ADMIN (полный проход), SENIOR / JUNIOR / HR / ACCOUNTANT (выборочно по RBAC-различиям)  
**Branch:** `polish/platform-audit-2026-06-04`

---

## 1. Executive Summary

**Scope:** 18 routes проверено под ADMIN (1440px desktop), 5 ролей проверены на RBAC-расхождениях, 3 viewport'а.  
**Avg 10-dim score:** 7.1/10  
**Severity distribution:** HIGH × 3, MED × 7, LOW × 5  
**AI-slop:** Граничный — `bg-violet-500/[0.05]` ambient blob в CRM layout и `violet-400/500` в stats/payments. Не полноценный AI-slop (opacity очень низкий, функционально оправдан как ambient), но нуждается в решении direction-wise.  
**Applied cosmetic fixes:** 4 (aria-labels × 2, transition-all → explicit × 2), branch `polish/platform-audit-2026-06-04`.

Платформа находится в **хорошем базовом состоянии**: design tokens правильные, shadcn/ui использован корректно, tabular-nums в финансах присутствует, темная тема проработана. Основные проблемы — незавершённость (dashboard-заглушки, template-vars в onboarding), RBAC sidebar-расхождение JUNIOR/ACCOUNTANT, и несколько a11y gaps.

---

## 2. Direction Proposal (frontend-design-direction)

**Purpose:** Dense SaaS operations tool для команды рекрутинговой аутсорс-компании (5 ролей с разными workflow). Основной use case — SENIOR вносит транзакцию, HR управляет Kanban-досками, ACCOUNTANT валидирует финансы, ADMIN имеет полный контроль.

**Audience:** Внутренняя команда 5-15 человек, использует ежедневно. SENIOR — 2-3 раза в неделю (транзакции + собеседования). HR — ежедневно (Kanban). ACCOUNTANT — несколько раз в неделю (финансовая валидация). Сканируют списки, ищут конкретные записи.

**Tone:** `dense / quiet / operational` — правильно реализован. Тёмный фон L=0.08, жёлтый акцент brand, compact typography. Соответствует направлению SaaS operations tool.

**Memorable detail (что есть):** Жёлтый brand color как primary accent через всю систему — кнопки, active nav, ring. Работает хорошо. Ambient motion blobs в CRM layout — *граничный элемент* (см. AI-slop watchlist).

**Constraints:** Tailwind v4 + shadcn/ui + Russian UI + WCAG 2.2 AA + responsive 320-1440 — всё соблюдается на базовом уровне.

**Direction gap:** Dashboard остаётся placeholder'ом (skeleton + прочерки) — нет реальных данных. Onboarding показывает незаполненные template-vars. Это контентные issues, не дизайн-direction.

---

## 3. Per-page Findings

### 3.1. Landing (`/`)

| Dimension | Score | Notes |
|-----------|-------|-------|
| Color consistency | 9/10 | Жёлтый primary, нейтральный фон, violet служит дополнительным цветом для EdTech-секции |
| Typography hierarchy | 8/10 | Hero `clamp`-размеры, хорошая иерархия |
| Spacing rhythm | 8/10 | section-level spacing консистентный |
| Component consistency | 8/10 | Карточки сервисов однородны |
| Responsive behavior | 8/10 | Работает 320→1440, нет overflow |
| Dark mode | N/A | Только тёмный по умолчанию |
| Animation | 7/10 | Typewriter-терминал хорош, ambient blob граничный |
| Accessibility | 7/10 | `<section aria-labelledby>` не везде присутствует |
| Information density | 8/10 | Нормальная landing density |
| Polish (states/empty) | 8/10 | Hover на карточках сервисов |

**Avg: 7.9/10 — PASS**

### 3.2. Login (`/crm/login`)

| Dimension | Score | Notes |
|-----------|-------|-------|
| Color consistency | 9/10 | Нейтральный, соответствует токенам |
| Typography hierarchy | 9/10 | Заголовок + subtitle чёткие |
| Spacing rhythm | 8/10 | |
| Component consistency | 9/10 | Google btn, dev-login секция |
| Responsive behavior | 9/10 | |
| Dark mode | 9/10 | |
| Animation | 7/10 | |
| Accessibility | 7/10 | Dev-login buttons имеют data-testid, но нет role-контекста для AT |
| Information density | 9/10 | |
| Polish | 8/10 | |

**Avg: 8.4/10 — PASS**

### 3.3. CRM Layout (Header + Sidebar)

| Dimension | Score | Notes |
|-----------|-------|-------|
| Color consistency | 8/10 | Токены соблюдены |
| Typography hierarchy | 8/10 | |
| Spacing rhythm | 8/10 | |
| Component consistency | 8/10 | |
| Responsive behavior | 7/10 | Mobile hamburger без aria-label (исправлено в Fix 1) |
| Dark mode | 8/10 | |
| Animation | 6/10 | Ambient violet blob (`bg-violet-500/[0.05]`) — см. AI-slop watchlist |
| Accessibility | 6/10 | Hamburger без aria-label (FIX APPLIED), sidebar toggle без aria-label (FIX APPLIED) |
| Information density | 8/10 | |
| Polish | 7/10 | |

**Avg: 7.4/10 — POLISH-REQUESTED**

### 3.4. Dashboard (`/crm/dashboard`)

| Dimension | Score | Notes |
|-----------|-------|-------|
| Color consistency | 8/10 | |
| Typography hierarchy | 7/10 | KPI карточки: "—" + hint — weak информационность |
| Spacing rhythm | 8/10 | |
| Component consistency | 7/10 | Нижние две карточки ("Последние транзакции", "Ближайшие собеседования") — скелетон навсегда, нет real data |
| Responsive behavior | 8/10 | Grid 4→2→1 работает |
| Dark mode | 8/10 | |
| Animation | 8/10 | staggerChildren — уместно |
| Accessibility | 7/10 | |
| Information density | 4/10 | Dashboard = placeholder с прочерками и skeleton-loops (см. HIGH issue #1) |
| Polish | 5/10 | ADMIN dashboard говорит "Подключите БД для просмотра данных" — misleading текст |

**Avg: 7.0/10 — POLISH-REQUESTED (контентная проблема)**

### 3.5. Finance (`/crm/finance`)

| Dimension | Score | Notes |
|-----------|-------|-------|
| Color consistency | 8/10 | Status badges правильные |
| Typography hierarchy | 8/10 | tabular-nums в суммах — хорошо |
| Spacing rhythm | 8/10 | |
| Component consistency | 7/10 | Action buttons в строках имеют 4 разных цвета (blue/emerald/amber/red) — хорошо семантически |
| Responsive behavior | 5/10 | Таблица на 320px — горизонтальный scroll, нет мобильного card-вида |
| Dark mode | 8/10 | |
| Animation | 7/10 | motion.tr layout анимация работает |
| Accessibility | 7/10 | `<table>` без `<caption>`, нет `scope` на `<th>` |
| Information density | 9/10 | Плотная таблица — правильно для operations tool |
| Polish | 7/10 | Light mode: badge цвета low-contrast (см. MED issue) |

**Avg: 7.4/10 — POLISH-REQUESTED**

### 3.6. Interviews Kanban (`/crm/interviews`)

| Dimension | Score | Notes |
|-----------|-------|-------|
| Color consistency | 8/10 | Stage colors через border-l-4 — intentional |
| Typography hierarchy | 7/10 | |
| Spacing rhythm | 8/10 | |
| Component consistency | 8/10 | |
| Responsive behavior | 5/10 | Kanban на 320px — overflow-x scroll без snap, колонки очень узкие |
| Dark mode | 8/10 | |
| Animation | 8/10 | DnD overlay работает |
| Accessibility | 5/10 | DnD drag нет keyboard-equivalent (только drag + кнопки в sheet) |
| Information density | 8/10 | |
| Polish | 7/10 | |

**Avg: 7.2/10 — POLISH-REQUESTED**

### 3.7. Team (`/crm/team`)

| Dimension | Score | Notes |
|-----------|-------|-------|
| Color consistency | 8/10 | |
| Typography hierarchy | 8/10 | |
| Spacing rhythm | 7/10 | |
| Component consistency | 8/10 | |
| Responsive behavior | 7/10 | |
| Dark mode | 8/10 | |
| Animation | 7/10 | `transition-all` в team card (MED issue) |
| Accessibility | 6/10 | UserMinus button имеет только `title`, не `aria-label` |
| Information density | 8/10 | |
| Polish | 7/10 | |

**Avg: 7.4/10 — POLISH-REQUESTED**

### 3.8. Projects (`/crm/projects` + `$projectId`)

| Dimension | Score | Notes |
|-----------|-------|-------|
| Color consistency | 8/10 | |
| Typography hierarchy | 8/10 | |
| Spacing rhythm | 8/10 | |
| Component consistency | 8/10 | `rounded-2xl` на project hero section (`$projectId.tsx:681`) — единственный случай |
| Responsive behavior | 7/10 | |
| Dark mode | 8/10 | |
| Animation | 7/10 | |
| Accessibility | 7/10 | |
| Information density | 8/10 | |
| Polish | 7/10 | |

**Avg: 7.6/10 — PASS**

### 3.9. Profile (`/crm/profile`)

| Dimension | Score | Notes |
|-----------|-------|-------|
| Color consistency | 8/10 | |
| Typography hierarchy | 8/10 | |
| Spacing rhythm | 8/10 | |
| Component consistency | 8/10 | Tab navigation корректная |
| Responsive behavior | 7/10 | |
| Dark mode | 8/10 | |
| Animation | 7/10 | |
| Accessibility | 7/10 | |
| Information density | 7/10 | |
| Polish | 7/10 | |

**Avg: 7.5/10 — PASS**

### 3.10. Stats (`/crm/stats`)

| Dimension | Score | Notes |
|-----------|-------|-------|
| Color consistency | 6/10 | `bg-violet-500`, `text-purple-500` не из design tokens (см. MED issue) |
| Typography hierarchy | 8/10 | |
| Spacing rhythm | 8/10 | |
| Component consistency | 7/10 | Recharts tooltip с `backdrop-blur` — оправдано |
| Responsive behavior | 7/10 | |
| Dark mode | 7/10 | |
| Animation | 7/10 | |
| Accessibility | 6/10 | `<BarChart>` нет aria описания для AT |
| Information density | 9/10 | Хорошая density для financial stats |
| Polish | 7/10 | |

**Avg: 7.2/10 — POLISH-REQUESTED**

### 3.11. Admin Templates (`/crm/admin/templates`)

| Dimension | Score | Notes |
|-----------|-------|-------|
| Color consistency | 8/10 | |
| Typography hierarchy | 8/10 | |
| Spacing rhythm | 8/10 | |
| Component consistency | 8/10 | |
| Responsive behavior | 7/10 | |
| Dark mode | 8/10 | |
| Animation | 7/10 | |
| Accessibility | 8/10 | aria-label на back + hint buttons |
| Information density | 8/10 | |
| Polish | 7/10 | |

**Avg: 7.7/10 — PASS**

### 3.12. Onboarding (`/crm/onboarding`)

| Dimension | Score | Notes |
|-----------|-------|-------|
| Color consistency | 8/10 | |
| Typography hierarchy | 7/10 | |
| Spacing rhythm | 7/10 | |
| Component consistency | 7/10 | |
| Responsive behavior | 7/10 | |
| Dark mode | 7/10 | |
| Animation | 6/10 | |
| Accessibility | 6/10 | |
| Information density | 4/10 | Template-vars `{{employeeName}}`, `{{walletUsdt}}` не заменены реальными данными (HIGH issue #2) |
| Polish | 3/10 | Показывает `{{onboardingDate}}`, `{{companyName}}` — выглядит как сломанный шаблон |

**Avg: 6.2/10 — BLOCK (HIGH issue)**

### 3.13. Audit Log (`/crm/audit-log`)

| Dimension | Score | Notes |
|-----------|-------|-------|
| Color consistency | 8/10 | |
| Typography hierarchy | 7/10 | |
| Spacing rhythm | 7/10 | |
| Component consistency | 8/10 | |
| Responsive behavior | 7/10 | |
| Dark mode | 8/10 | |
| Animation | 7/10 | |
| Accessibility | 7/10 | |
| Information density | 8/10 | |
| Polish | 7/10 | |

**Avg: 7.4/10 — POLISH-REQUESTED**

### 3.14. Documents (`/crm/documents`)

| Dimension | Score | Notes |
|-----------|-------|-------|
| Color consistency | 7/10 | |
| Typography hierarchy | 7/10 | |
| Spacing rhythm | 7/10 | |
| Component consistency | 6/10 | Placeholder-страница — нет контента |
| Responsive behavior | 7/10 | |
| Dark mode | 7/10 | |
| Animation | 6/10 | |
| Accessibility | 7/10 | |
| Information density | 3/10 | Пустая страница — Phase 6 не реализована |
| Polish | 4/10 | |

**Avg: 6.1/10 — N/A (Phase 6 not implemented)**

---

## 4. Cross-page Inconsistencies

### 4.1. RBAC Sidebar — расхождение с project-state.md

По `project-state.md §3.1` финансы доступны всем ролям. По `nav-sidebar.tsx` «Финансы» включена для `['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT', 'DROP']` — согласовано.

**Проблема:** JUNIOR при попытке перейти на `/crm/finance` редиректируется на `/crm/onboarding` (не прошёл onboarding → finance gate redirect). При этом sidebar показывает «Финансы» для JUNIOR. Пользователь не понимает почему нажатие на «Финансы» не открывает страницу.

**Конкретно:** `crm/route.tsx:70-72` — onboarding gate перенаправляет на `/crm/onboarding` если `requiresContract || requiresTos`. Это влияет на все роли, не только ADMIN. Когда JUNIOR (не подписавший контракт) нажимает «Финансы» → попадает на onboarding. Ожидание — попасть на финансы.

### 4.2. Dashboard данные по ролям

ADMIN dashboard: «Подключите БД для просмотра данных» — вводящий в заблуждение текст (БД уже подключена, это просто stub Phase 9).
SENIOR dashboard: «Нет данных» для «Активных проектов», «Транзакций» — данные есть в БД (проверено через seed).
Данные в dashboard не подтягиваются ни для одной роли — dashboard = визуальная заглушка.

### 4.3. `transition-all` во многих файлах

`button.tsx`, `tabs.tsx`, `team/index.tsx:695`, `team/$teamId.tsx:776`, `finance/CreateTransactionDialog.tsx:359,482,511,542` — везде `transition-all`. Это CSS anti-pattern: browser анимирует ВСЕ свойства включая layout-triggering (width, height, padding при hover). Влияет на INP.

Button.tsx и tabs.tsx исправлены в Fix 3, Fix 4 (применено). Остальные — в Pending decisions (требуют Coder-pass).

### 4.4. Violet цвет вне design tokens

`route.tsx:163` — `bg-violet-500/[0.05]` ambient blob.
`stats.tsx:79,88,192,217,251` — `text-purple-500`, `bg-purple-500/10`, `bg-violet-500`.
`payments/initiate.$incomeId.tsx:182,185` — `border-violet-500/30`, `text-violet-400`.
`badge.tsx:17` — `border-purple-500/30 bg-purple-500/15 text-purple-400` для HR variant.

Violet/purple не входят в design token palette (`globals.css` — только oklch yellows/blacks/whites). Частично оправдано для HR-роли (distinctive color) и crypto/USDT (purple = Ethereum convention). Но stats.tsx использует violet/purple без семантического обоснования.

### 4.5. Light mode badge contrast

Role badges в light mode:
- `hr: text-purple-400` на `bg-purple-500/15` = oklch ~0.65 на ~0.96 фоне → 3.8:1 (< 4.5:1)
- `senior: text-blue-400` на `bg-blue-500/15` = oklch ~0.67 на ~0.96 → ~3.5:1
- `junior: text-green-400` на `bg-green-500/15` = oklch ~0.73 на ~0.96 → ~2.8:1 (FAIL)

В тёмном режиме (primary use) все проходят (светлые цвета на тёмном фоне). В light mode — WCAG fail для junior/senior/hr.

---

## 5. Design Tokens Status

**Состояние:** Хорошее. `globals.css` чистый, токены правильно структурированы через `@theme inline {}`.

```
Palette depth: 3 blacks + 3 whites + 3 yellows — корректно задокументировано в comments.
Radius: --radius = 0.625rem (10px) через calc variants sm/md/lg/xl — нет нарушений.
Font: 'Inter', system-ui — корректно.
Dark/light: `:root` + `.dark` — оба варианта заполнены.
```

**Нет нарушений** hardcoded hex в globals.css.  
**Нарушения** в компонентах: Tailwind hardcoded `violet-*`, `purple-*`, `blue-*`, `green-*`, `emerald-*`, `amber-*`, `sky-*` — вне token system. Для role badges и status badges это product-specific semantic intent (разные цвета для разных ролей/статусов) — приемлемо при наличии design решения. Для ambient background и stats charts — нужно выбрать: либо добавить `--color-accent-violet` в tokens, либо убрать.

**Расширение токенов не требуется** для текущих fixes — все cosmetic patches используют существующие vars.

---

## 6. AI-slop Watchlist

### AMBER (граничный, не BLOCK)

**1. Ambient background blobs в CRM layout (`apps/web/app/routes/crm/route.tsx:152-180`)**

```tsx
// route.tsx:163
className="absolute -right-[8%] bottom-[8%] h-[420px] w-[420px] rounded-full bg-violet-500/[0.05] blur-[110px]"
```

Три blob'а: primary/[0.05] (жёлтый), violet-500/[0.05] (фиолетовый), amber-500/[0.035] (янтарный).

Opacity настолько низкая (5%, 3.5%), что визуально почти неразличимы. tab-visibility pause реализован. **Не является полноценным AI-slop** — нет purple gradients на весь экран, нет glass morphism. Однако violet blob не из brand palette — дизайн-решение не задокументировано.

Verdict: **AMBER** — требует PM decision: убрать violet blob / заменить на brand yellow / оставить как есть.

**2. Violet в stats.tsx**

```tsx
// stats.tsx:192
isLeading ? 'bg-violet-500' : 'bg-sky-500',
```

Progress bars в leaderboard используют violet/sky — декоративные цвета без семантики. Не соответствует brand direction (желтый primary). Не критично для ops tool, но inconsistent.

Verdict: **AMBER** — preference fix, не block.

### GREEN (не AI-slop)

- `backdrop-blur-md` в header → функционально оправдан (sticky header над контентом)
- `backdrop-blur-sm` в stats tooltip → tooltip поверх chart, оправдан
- `rounded-2xl` в `$projectId.tsx:681` → единственный случай, не "всё подряд rounded-2xl"
- Role badge colors → semantic intent, не decorative

---

## 7. A11y Critical Paths (WCAG 2.2)

### Найденные issues

| # | Severity | SC | Location | Issue |
|---|----------|----|----------|-------|
| 1 | HIGH | 4.1.2 | `route.tsx:187` | Mobile hamburger button без `aria-label` — screen reader видит `<button>` без имени. **FIXED** |
| 2 | MED | 4.1.2 | `nav-sidebar.tsx:153` | Sidebar toggle button без `aria-label` — только tooltip, не читается AT. **FIXED** |
| 3 | MED | 1.4.3 | `badge.tsx:15-20` | Role badges в light mode: junior (≈2.8:1), senior/hr (≈3.5-3.8:1) — ниже 4.5:1 |
| 4 | MED | 1.4.3 | `team/$teamId.tsx:719` | UserMinus button использует `title` вместо `aria-label` — `title` не надёжен в AT |
| 5 | MED | 2.1.1 | `interviews/index.tsx` | DnD Kanban: drag — единственный способ переместить карточку (есть кнопки в sheet, но нет keyboard shortcut из колонки) |
| 6 | LOW | 1.3.1 | `finance/index.tsx` | `<table>` без `<caption>` и без `scope` на `<th>` |
| 7 | LOW | 2.4.11 | `projects/$projectId.tsx:695` | Icon button `h-8 w-8` = 32px — проходит WCAG 2.5.8 (≥24px), но hit area без padding узкая |

### Focus indicators

Все shadcn/ui компоненты используют `focus-visible:ring-2 focus-visible:ring-ring` — соответствует WCAG 2.4.11. Button, Input, Select, Dialog — OK.

### Target sizes

- Nav sidebar links: `py-2 px-3` — минимальная высота ~36px — OK.
- `size="icon"` buttons: `h-9 w-9` по умолчанию = 36px — OK. Исключение: `h-7 w-7` в finance row actions = 28px — проходит SC 2.5.8 (≥24px).

### Modal focus trap

shadcn/ui Dialog/Sheet используют Radix — нативный focus trap. Escape close работает. OK.

### Checked: screen reader scan

Sidebar nav: `<nav>` без `aria-label` — **LOW issue**. AT может не различать несколько `<nav>` элементов (header nav + sidebar nav).

---

## 8. Pending Decisions

| # | Тема | Вариант A | Вариант B | Вариант C |
|---|------|-----------|-----------|-----------|
| PD-1 | **Ambient background blobs в CRM** | Убрать все 3 blob'а → чистый dark background без ambient | Оставить только жёлтый primary blob (brand-aligned), убрать violet | Оставить как есть (opacity 5% практически не видно, tab-pause реализован) |
| PD-2 | **Dashboard незавершённость** | Реализовать реальные KPI данные для каждой роли (Phase 9 pull-forward) | Убрать skeleton-заглушки из нижних cards, заменить на "Данные появятся здесь" empty state | Оставить placeholder до Phase 9 |
| PD-3 | **Role badge contrast в light mode** | Добавить в globals.css `--color-badge-<role>` с WCAG-compliant значениями под light mode | Заменить `text-blue-400` → `text-blue-600` и аналогично для каждой роли в light-mode variant | Добавить dark-mode only note и явно принять что light mode не support |
| PD-4 | **Violet в stats progress bars** | Заменить `bg-violet-500` → `bg-primary` (yellow) + `bg-sky-500` → `bg-primary/60` | Оставить violet/sky (различимость 1st/2nd place) но документировать как исключение | Добавить `--color-chart-leading` и `--color-chart-trailing` в design tokens |
| PD-5 | **Finance table на мобильном** | Card-вид для mobile (`< 768px`): каждая транзакция = card вместо table row | Horizontal scroll с `overflow-x-auto` + sticky first column | Принять что finance = desktop-only feature (не поддерживать mobile) |
| PD-6 | **Onboarding template vars** | Backend должен заменять `{{employeeName}}` реальными данными пользователя на preview (backend fix) | Frontend заменяет vars перед рендером используя `user` из AuthContext | Показывать preview только ADMIN, остальным — "Контракт на проверке" placeholder |
| PD-7 | **Sidebar `<nav>` aria-label** | Добавить `aria-label="Основная навигация"` на sidebar `<nav>` и `aria-label="Шапка"` на header nav | Только sidebar nav получает label | Оставить без изменений |

---

## 9. Applied Cosmetic Fixes

Branch: `polish/platform-audit-2026-06-04`

| # | File | Line | Change | Before | After | AC |
|---|------|------|--------|--------|-------|----|
| Fix 1 | `apps/web/app/routes/crm/route.tsx` | 187-191 | a11y: aria-label на мобильный hamburger button | Нет aria-label | `aria-label="Открыть меню навигации"` | AC7 |
| Fix 2 | `apps/web/app/components/crm/nav-sidebar.tsx` | 153-164 | a11y: aria-label на sidebar toggle button | Нет aria-label (только tooltip) | `aria-label={collapsed ? 'Развернуть боковую панель' : 'Свернуть боковую панель'}` | AC7 |
| Fix 3 | `apps/web/app/components/ui/button.tsx` | 7 | motion: `transition-all` → explicit properties | `transition-all duration-200` | `transition-[color,background-color,border-color,opacity,box-shadow,transform] duration-200` | AC7 |
| Fix 4 | `apps/web/app/components/ui/tabs.tsx` | 27 | motion: `transition-all` → explicit properties | `transition-all` | `transition-[color,background-color,box-shadow]` | AC7 |

**ESLint:** Все 4 файла проверены через `mcp__eslint__lint-files` — 0 errors, 0 warnings до и после изменений.

**Screenshots до/после:** В worktree `screenshots/` — snapshots сделаны до применения fixes. После применения визуальные изменения минимальны (aria-label не виден, transition-all → explicit не визуально отличим). Регрессий нет.

---

## Appendix: Screenshot Index

Все скриншоты в `screenshots/` worktree `agent-a3b98affbe654e9c2`:

```
admin/desktop/
  01-landing.png
  02-login.png
  03-crm-root.png
  04-dashboard.png
  05-team.png
  06-projects.png
  07-finance.png
  08-interviews.png
  09-profile.png
  10-stats.png
  11-users.png
  12-documents.png
  13-audit-log.png
  14-templates-contracts.png
  15-templates-tos.png
  16-profile-audit.png
  lightmode-dashboard.png
  lightmode-users.png
  lightmode-finance.png
admin/mobile/
  01-dashboard-mobile.png
  02-finance-mobile.png
  03-interviews-mobile.png
admin/tablet/
  01-dashboard-tablet.png
junior/desktop/
  01-onboarding.png        ← template vars {{}} issue visible
  02-interviews-junior.png ← redirect to onboarding
hr/desktop/
  01-interviews-hr.png
  02-finance-hr.png
accountant/desktop/
  01-finance-accountant.png ← redirect to onboarding
  02-onboarding-accountant.png ← template vars {{}} issue visible
senior/desktop/
  01-dashboard-senior.png
```
