# crm-vacancies — design artifact (Claude Design)

**Status:** Mode E reconciliation is ready (2026-07-23) — see "Coder-ready spec" below.
**Claude Design project:** https://claude.ai/design/p/cd415008-fe1b-4070-8a30-ed95a6b4a5e9
**Design system:** `CheekyCheeseIT CRM` (synced).
**Product spec:** `docs/superpowers/specs/2026-07-22-landing-refactor-design.md` §6.
**Design tier:** 1 (new CRM screens).

## Contents of `assets/crm-vacancies/`

| File                                            | What it is                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vacancies-admin.dc.html`                       | Both screens as canvases of static state panels: [1] the «Вакансії» list (default/empty/loading/delete-confirm + creation in a Right-side Sheet) and [2] the detail page with the «Відгуки» tab (candidate cards, statuses Новий→Переглянуто→Відхилено, delete-confirm with a warning about CV deletion) + a mobile frame |
| `Sidebar.dc.html` / `TopBar.dc.html`            | A representative CRM shell (Ukrainian navigation + the «Вакансії» item) — context, do NOT re-lay out the existing shell                                                                                                                                                                                                   |
| `VacancyCard.dc.html` / `CandidateCard.dc.html` | Card components                                                                                                                                                                                                                                                                                                           |
| `_ds/**`, `support.js`                          | DS bundle for standalone rendering (do NOT import into the build)                                                                                                                                                                                                                                                         |

## Key generation decisions

- The list — cards (not a table); creation/editing — a Right-side Sheet.
- The Markdown editor in the form is a PLACEHOLDER: the existing CodeMirror editor of the CRM is reused.
- Domain badges are EN (AI/EdTech/E-Commerce/Other), the rest of the copy is Ukrainian (consistent with the sidebar).
- States are static panels (for fidelity references), interactivity is not wired.

## For the coder

Do NOT copy the HTML; build with the existing `apps/web` components (Card/Badge/Sheet/Dialog/
Tabs/Skeleton) + the `globals.css` tokens. The full coder-ready spec — the sections below (ui-ux-designer Mode E,
2026-07-23).

---

# Coder-ready spec (ui-ux-designer Mode E)

## ⚠️ 0. CRITICAL — the export is in Ukrainian, the real CRM is in Russian

The export `vacancies-admin.dc.html` (and the nested `VacancyCard.dc.html`/`CandidateCard.dc.html`)
was generated **in Ukrainian** (including the fake `Sidebar.dc.html`, which claims
consistency with the "sidebar" — but that claim is false). The real `apps/web`
(`apps/web/app/components/crm/nav-sidebar.tsx`) is **entirely in Russian** («Дашборд», «Команда»,
«Проекты», «Финансы», «Собеседования», «Документы», «Профиль» — not a single Ukrainian word).
Golden rule #7 (`ui-ux-designer.md`) and `.claude/rules/common/russian-language.md` — a hard
`ALWAYS RUSSIAN UI`, no exceptions for badges/tooltips/aria-label.

**Mandatory:** ALL copy from the mockup is translated into Russian during implementation. The full
translation table — §3.5 (statuses/badges) and §4 (all on-screen strings, in place). Domain badges (`AI`/`EdTech`/
`E-Commerce`/`Other`) — the only deliberate exception (Latin script, see §3.4) — leave as is.
Seniority (`Senior`/`Lead`) — also Latin, but that is a SEPARATE decision with its own rationale
(see §3.6) — do not confuse it with the translation of CRM roles (`RoleSelect`: `SENIOR` → «Синьор»).

## 1. Direction (frontend-design-direction, brief)

- **Purpose:** ADMIN/HR create and publish vacancies, view candidate applications from the public
  careers page, change the vacancy/application status, download resumes, delete what is unneeded.
- **Audience:** HR/ADMIN — 1-5 times a week, scans the vacancy list and the queue of new applications,
  quickly makes a decision (reviewed/rejected), does not waste time on extra clicks.
- **Tone:** `dense / quiet / scannable` — the same SaaS-operations aesthetic as the rest of the CRM
  (cards, not a table; status — a colored dot + badge, not text-in-a-row).
  Domain badges and dot indicators are the only "decorative" detail, everything else is working style.
- **Memorable detail:** a candidate card with a highlight ring (`ring`) for unreviewed
  applications + an inline status switch (`SegmentedToggle`) right on the card — HR does not open
  a separate dialog to mark "reviewed"/"rejected".
- **Constraints:** Tailwind v4, shadcn/ui (`apps/web/app/components/ui/`), Russian UI, WCAG 2.2 AA,
  responsive 320/768/1024/1440 (`.claude/rules/common/responsive-design.md`), zero new npm packages
  (the whole visual is built with existing primitives and `lucide-react`, which is already in the dependencies).

## 2. Screens and routes (source of truth — product spec §3.2/§6)

| Route                   | File (proposal, follows the `team/$teamId.tsx` convention)    | Access    |
| ----------------------- | ------------------------------------------------------------- | --------- |
| `/vacancies`            | `apps/web/app/routes/_authenticated/vacancies/index.tsx`      | ADMIN, HR |
| `/vacancies/$vacancyId` | `apps/web/app/routes/_authenticated/vacancies/$vacancyId.tsx` | ADMIN, HR |

Both routes read/write `GET /api/vacancies`, `POST /api/vacancies`, `PATCH /api/vacancies/:id`,
`DELETE /api/vacancies/:id`, `GET /api/vacancies/:id/applications`,
`PATCH /api/vacancies/:id/applications/:appId`, `DELETE /api/vacancies/:id/applications/:appId`,
`GET /api/vacancies/:id/applications/:appId/resume-url` (paths and codes were checked against the real
`apps/api/src/vacancies/vacancies.controller.ts` — already merged, PR #390). The DTOs — `packages/shared/
src/schemas/vacancies.ts` (already in main, exported from the package index).

## 3. Component mapping

### 3.1. Reuse 1:1 (do not replace with your own implementations)

| On-screen element                                   | `apps/web` component                                                                                                                                                                                                                                                              |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vacancy/candidate card (container)                  | `Card` (`@/components/ui/card`) — or a plain `div` with the Card base classes, following `apps/web/app/components/documents/document-card.tsx` (it does not use `CardHeader`/`CardContent` — their `p-6` padding is excessive for a dense card)                                   |
| Buttons                                             | `Button` (`@/components/ui/button`) — variants `default`/`outline`/`ghost`/`destructive`, sizes `default`/`sm`/`icon`                                                                                                                                                             |
| Right panel for creating/editing a vacancy          | `Sheet`/`SheetContent`(`side="right"`)/`SheetHeader`/`SheetTitle`/`SheetDescription` (`@/components/ui/sheet`) — following `apps/web/app/routes/_authenticated/finance/components/dialogs/AttachReceiptSheet.tsx` (the width pattern is there too, see §5)                        |
| Confirm dialogs (deleting a vacancy/application)    | `AlertDialog`/`AlertDialogContent`/`AlertDialogHeader`/`AlertDialogTitle`/`AlertDialogDescription`/`AlertDialogFooter`/`AlertDialogAction`/`AlertDialogCancel` (`@/components/ui/alert-dialog`) — following `document-card.tsx` (2 confirm dialogs in one file, exactly our case) |
| Domain/Level/Employment type — dropdown form fields | `Select`/`SelectTrigger`/`SelectContent`/`SelectItem` (`@/components/ui/select`)                                                                                                                                                                                                  |
| Title/URL slug/Location — text fields               | `Input` + `Label` (`@/components/ui/input`, `@/components/ui/label`)                                                                                                                                                                                                              |
| Skeleton states (list/details loading)              | `Skeleton` (`@/components/ui/skeleton`)                                                                                                                                                                                                                                           |
| Empty states (0 vacancies / 0 applications)         | A custom block (dashed border + icon + title + text + CTA) — the pattern is already in the mockup, there are no analogous domain empty-state components in the codebase — just a div, do not extract into a shared component for 2 uses (YAGNI)                                   |
| Candidate initials avatar                           | `Avatar` + `AvatarFallback` (`@/components/ui/avatar`) — without `AvatarImage` (the candidate has no photo)                                                                                                                                                                       |
| Collapsible block «Сопроводительное письмо»         | native `<details>/<summary>` as in the mockup — OK, needs no Radix; or `Collapsible` if one already exists (not in the `ui/` list — do not introduce a new primitive for one letter, native `<details>` is available out of the box and fully a11y-correct)                       |
| Resume download (presigned)                         | The `useDocumentDownloadUrl` pattern (`apps/web/app/hooks/use-documents.ts:96`) — `useQuery` with `enabled:false` → `refetch()` → `window.open(url, '_blank', 'noopener,noreferrer')`. See §6.                                                                                    |
| Icons                                               | `lucide-react` (already in the `apps/web/package.json` dependencies, `^1.14.0`)                                                                                                                                                                                                   |
| Form (create/edit)                                  | `@tanstack/react-form` + Zod (`createVacancySchema`/`updateVacancySchema` from `@crm/shared`) — the convention of the whole app (see `apps/web/app/components/users/UserDialog.tsx`)                                                                                              |
| Toasts (mutation success/error)                     | `sonner` (`toast.success(...)`/`toast.error(...)`)                                                                                                                                                                                                                                |

### 3.2. Composite UI patterns — reuse existing primitives instead of custom "tabs"/"chips"

The mockup draws three different kinds of "switches" as pure `<span>`s with manual styles (not real
components). In `apps/web` there are already **two** ready-made primitives for this — we use them instead of
inventing a third:

| Where in the mockup                                                                                                                              | Real component                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| «Деталі / Відгуки» (tab switching on the vacancy page)                                                                                           | `AnimatedTabs` (`@/components/ui/animated-tabs`) — 2 tabs, `value: 'details' \| 'applications'`, `label: 'Детали'` / `` `Отклики${count ? ` · ${count}` : ''}` ``                                                                  |
| «Усі / Опубліковані / Чернетки / Закриті» (vacancy list filter) and «Усі / Нові / Переглянуті / Відхилені» (application filter inside a vacancy) | `SegmentedToggle` (`@/components/ui/segmented-toggle`) `variant="tabs"` `role="tablist"` — a page-level facet filter, 4 and 4 options respectively, `label` includes the counter as text: `` `Все ${total}` ``, `` `Новые ${n}` `` |
| «Новий / Переглянуто / Відхилено» (quick change of application status right on the candidate card)                                               | `SegmentedToggle` (`@/components/ui/segmented-toggle`) `variant="pill"` `size="sm"` — 3 options, `value` = `application.status`                                                                                                    |

**Known deviation from the mockup (see also §8):** the active segment in the mockup for «Деталі/Відгуки» and
for the filter chips is a neutral `var(--card)` (not gold). In `AnimatedTabs`/`SegmentedToggle`
the active segment is **gold** (`bg-primary` / `bg-primary/25`) — this is already an established pattern of the whole
CRM (sidebar, finance tabs, etc.). We reuse it as is — a gold active segment, we do not
introduce a third neutral variant for one screen.

**Extending `SegmentedToggle` (recommended, ~10 lines):** in the mockup the «Відхилено» segment in the
active state is red (`color-mix(destructive 22%)`), not gold (see `CandidateCard.dc.html`
`actRej` in `renderVals()`). The current `SegmentedToggle` paints the active segment with a single `activePillStyles`
for all options at once — there is no way to highlight one segment with a different color. Recommendation: add an
optional field `SegmentedToggleOption.activeVariant?: 'default' | 'destructive'` (affects only the
color of the active pill for THIS option — `bg-destructive/20 border-destructive/40` instead of
`activePillStyles`), use `activeVariant: 'destructive'` on the «Отклонено» option. If the coder
prefers not to touch the shared component — fallback: all 3 options with the same gold active
segment (a minor loss of the visual signal "rejected = alarm", does not block the AC).

### 3.3. New — extending `badge.tsx` is NOT required (we use a `className` override)

The existing pattern (`document-card.tsx:170`: `<Badge variant="secondary" className="bg-red-500/15
text-red-600">PDF</Badge>`) — overriding the color via `className` on top of the base variant,
WITHOUT adding a new `variant` to the `badgeVariants` cva. We follow the same pattern for the vacancy status
«Закрито» (the only status without a ready-made variant — see §3.5 for the full table). If 2-3 more
places reusing the same red "closed/rejected" pattern appear — then it is worth extracting into
`variant: 'status-rejected'` in `badge.tsx` (symmetrical to the already existing `status-active`/
`status-closed`), but not now (YAGNI, 1 use).

### 3.4. Domain-tag colors (the dot indicator before the domain badge)

The export paints the dot with fixed oklch hues (NOT theme tokens — 3 different hues are needed to
distinguish them). **Cross-checked against the sister spec `docs/design/landing-redesign.md` §3.3** — the same task
has already been solved for the public `/careers` page (landing): `--tag-ai` / `--tag-edtech` /
`--tag-ecommerce`. We use the **same oklch values** for the visual consistency of the brand between
the public careers page and the admin area (different apps — `apps/web` and `apps/landing` — tokens
are physically not shared between Vite bundles, but the values must match 1:1):

| Domain      | oklch                                                                                | CSS variable (add to `apps/web/app/styles/globals.css`, `:root`+`.dark`, similar to the landing spec) |
| ----------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `AI`        | `oklch(84% .12 200)` (light blue)                                                    | `--tag-ai`                                                                                            |
| `EDTECH`    | `oklch(82% .13 145)` (green)                                                         | `--tag-edtech`                                                                                        |
| `ECOMMERCE` | `oklch(80% .12 320)` (pink-purple)                                                   | `--tag-ecommerce`                                                                                     |
| `OTHER`     | no separate hue — neutral, use `var(--muted-foreground)` (no colored dot, only gray) |                                                                                                       |

If by the time of implementation `apps/landing` has already received these tokens (the `landing-redesign.md` spec is merged
independently) — just copy the values; the merge order does not matter, the values are fixed identically in both
specs. Use ONLY in the vacancy domain badge, nowhere else in the CRM (does not overlap
with the RBAC role palette — different semantics).

### 3.5. Status badges — translation table + mapping to variant

| Enum value                                                                      | Mockup text (UK) | **Russian text (mandatory)**                                   | Badge variant                                                                       |
| ------------------------------------------------------------------------------- | ---------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `Vacancy.status = DRAFT`                                                        | Чернетка         | **Черновик**                                                   | `secondary` (ready, exact match with the mockup)                                    |
| `Vacancy.status = PUBLISHED`                                                    | Опубліковано     | **Опубликовано**                                               | `status-active` (ready, green, exact match)                                         |
| `Vacancy.status = CLOSED`                                                       | Закрито          | **Закрыто**                                                    | `secondary` + `className="border-red-500/30 bg-red-500/15 text-red-400"` (see §3.3) |
| `VacancyApplication.isNew` badge (= `status === 'NEW'`, see §5)                 | NEW (Latin!)     | **Новый**                                                      | `default` (solid `bg-primary`, exact style match, only the text changes)            |
| Counter «N нових/N новых» (on the vacancy card and in the «Відгуки» tab header) | 3 нові           | **3 новых** (a fixed form, no case declension — a short badge) | `default`                                                                           |

All three `dot` indicators inside the badge (a small `<span>` 5-8px, `background:currentColor`) —
keep, a purely decorative element, works with any text.

### 3.6. Seniority (`Senior`/`Lead`) — the decision to keep Latin script (a deliberate deviation from "everything in Russian")

`vacancySenioritySchema` (`SENIOR`/`LEAD`) is the candidate's **public job title** on the careers page
(`apps/landing`, the landing page already keeps these terms in English, see `landing-redesign.md`), and
not an internal CRM role. Unlike `RoleSelect` (`SENIOR` → «Синьор» — an internal employee role
in the system), here `Senior`/`Lead` are the anglicisms generally accepted in Russian-/Ukrainian-language IT recruiting for
a position name (like «Middle QA Engineer» in the mockup itself). Recommendation: **display as is**
(`Senior`, `Lead`), do not translate to «Синьор»/«Лід». Employment type (`FULL_TIME`/`PART_TIME`/
`CONTRACT`) — ordinary Russian words, translated fully (see §4.2).

## 4. Layout per screen and breakpoint

### 4.1. Screen 1 — `/vacancies` (list)

**Header:** `h2` «Вакансии» + a counter badge «N всего» (`Badge variant="secondary"`) + a subtitle
«Создавайте и публикуйте позиции, управляйте откликами кандидатов.» + a `Button` (icon `Plus`)
«Создать вакансию» on the right (at ≤1024 — icon + the short text «Создать», see the 1024/768px mockup).

**Filter:** `SegmentedToggle variant="tabs"` — «Все N» / «Опубликованные N» / «Черновики N» /
«Закрытые N» (a client-side filter over the already loaded list — 8-50 vacancies do not need server-side
pagination/filtering, YAGNI, see §7 "50+").

**Card grid:** `grid grid-cols-1 lg:grid-cols-2 gap-[18px]` — 1440/1024 = 2 columns (the mockup
shows 2 columns at 1440 by default, 1 column in the 1024 example — the actual decision: **2 columns
from `lg:` (≥1024) leave enough room for a `~490px` card**, below — 1 column). 768/320 = `grid-cols-1`.

**Vacancy card (`VacancyCard`):** title + status badge (right edge, `flex-shrink-0`) →
a row of tags (domain dot-badge + seniority `Badge variant="secondary"` + employment
`Badge variant="secondary"`) → a line (icon `MapPin` + location · monospace `/careers/{slug}`)
→ `Separator` → the bottom row: on the left «N откликов» (icon `Users`) + an `N новых` badge (only if
`newCount > 0` and status ≠ DRAFT), on the right — action buttons by status (§4.1.1).

#### 4.1.1. Action buttons by vacancy status (source of truth — backend, NOT literally the mockup)

| Status    | Buttons (`size="sm"`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DRAFT     | «Опубликовать» (`default`, icon `ArrowUp`) · «Редактировать» (`outline`, `Pencil`) · delete (`ghost` icon-only `Trash2`, aria-label «Удалить вакансию») — **delete is ALWAYS clickable for DRAFT with `applicationsCount === 0`**; if the draft already HAS applications (published first, then rolled back to DRAFT — theoretically possible via `PATCH status`) — the button is `disabled` + a `Tooltip` «Нельзя удалить вакансию с откликами» (text 1:1 with the backend `ConflictException`, see §7) |
| PUBLISHED | «Отклики» (`default`, icon `Eye`, leads to the «Отклики» tab of the detail page) · «Редактировать» (`outline`) · «Закрыть» (`ghost`, icon `X`) — **WITHOUT a delete button** (the backend returns 409 for published in any case — we do not show an action that will always fail)                                                                                                                                                                                                                        |
| CLOSED    | «Восстановить» (`outline`, icon `RotateCcw` — `PATCH status: 'PUBLISHED'`, re-publish) · «Редактировать» (`outline`) · delete (`ghost` icon-only) — **disabled + Tooltip** «Удалить можно только вакансию в статусе DRAFT» (backend text), since CLOSED never passes the `remove()` guard                                                                                                                                                                                                                |

**This is the only substantial deviation from `VacancyCard.dc.html`**, where the delete icon
is drawn for both DRAFT and CLOSED with no disabled state at all (the mockup is a static demonstration
of one case per card, it does not encode the business rule). The source of truth — `apps/api/src/vacancies/
vacancies.service.ts:163-176` (`remove()`), not the visual mockup.

**Mobile (320, from the mockup):** the card — the same state, but the buttons: the primary one (`flex-1`, `h-11`,
44px — touch target) + an `outline` icon-only «Редактировать» (`h-11 w-11`) + an `outline` icon-only
kebab (`MoreVertical`, `h-11 w-11`) → a `DropdownMenu` with «Удалить» (if allowed, otherwise do not render the
item at all — on mobile it is more compact to hide an unavailable action than to show a disabled menu item).

**The vacancy creation Sheet** is triggered by the «Создать вакансию» button in the header — see §5.

**Empty list (0 vacancies):** a dashed-border block, icon `Briefcase` (72×72 `bg-secondary`
rounded), title «Пока нет вакансий», text «Создайте первую вакансию, чтобы начать принимать
отклики кандидатов. Она появится на странице карьеры после публикации.», button «Создать первую
вакансию».

**Loading:** `Skeleton` for the title button (`h-10 w-44`), the filter (`h-11 w-80`), 2 placeholder cards
(the structure repeats the real card — title+badge, 2 pill tags, divider, footer).

### 4.2. Vacancy create/edit Sheet

`Sheet side="right"`, `SheetContent className="w-full sm:max-w-md flex flex-col overflow-hidden"`
(≈448px — the nearest existing Tailwind breakpoint to the mockup's 452px; the convention already exists in
`AttachReceiptSheet.tsx`, do not introduce a custom width).

Fields (top to bottom, all — `createVacancySchema`/`updateVacancySchema`):

1. **«Название вакансии»** — `Input`, required.
2. **«URL-слаг»** — a composite input: an immutable prefix `/careers/` (monospace,
   `text-muted-foreground`) + an editable `Input` (monospace). Auto-generation from the title in
   `kebab-case` — transliteration is not needed, turning a Russian title into an English slug is nontrivial.
   **Recommendation:** generate the auto-slug only from Latin words of the title; if the title
   is Cyrillic — leave the slug empty for manual entry. Helper text «Генерируется
   автоматически из названия. Можно редактировать.» — if auto-generation is impossible, the text
   changes to «Придумайте короткий URL-адрес (латиница, цифры, дефис).». Validation —
   `createVacancySchema.slug` regex `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`.
3. **«Домен» / «Уровень»** (grid `grid-cols-2 gap-[14px]`) — both `Select`. Domain — 4 options (AI/EdTech/
   E-Commerce/Other, see §3.4/§3.6 on Latin script). Level — 2 options (Senior/Lead).
4. **«Тип занятости» / «Локация»** (grid `grid-cols-2`) — «Тип занятости» `Select` (3 options: «Полная
   занятость»/«Частичная занятость»/«Проектная работа» — see §3.6 why NOT «Контракт», a term conflict
   with the onboarding-contracts module), «Локация» — `Input`, free text (the example from the mockup:
   «Киев · Удалённо» — this is a data EXAMPLE, not an enum, entered manually).
5. **«Описание (Markdown)»** — **reuse `ContractEditor`**
   (`apps/web/app/components/user-profile/contract/ContractEditor.tsx`) — this is a READY lazy-loaded
   CodeMirror + markdown highlighting + dark theme component, ALREADY used in the project (onboarding
   contracts). The props `value`/`onChange`/`readOnly={false}` fit 1:1 — `frozenBanner` is not needed
   (a vacancy has no "freeze"). The height of `ContractEditor` is hardcoded to `480px` — for a Sheet form
   (narrower) that is fine, if needed pass a `className` with a smaller height via the prop
   (the component already accepts `className` on the wrapper). **DO NOT draw the `<textarea>` from the mockup** — it was
   a stub at the generation stage (the mockup itself explicitly marks it with a hint icon «CodeMirror-редактор» —
   do NOT show this hint in the real UI, it was a designer's meta-note).

Footer: «Создать вакансию» (`default`, `flex-1`) + «Отмена» (`outline`) — on the edit detail page (not in a Sheet,
inline in the «Общая информация» card) the buttons are «Отмена» + «Сохранить изменения».

### 4.3. Screen 2 — `/vacancies/$vacancyId` (details)

A breadcrumb link «← Все вакансии» → an `h2` title (the name) + status badge → a row of tags (domain +
seniority + employment + location) → buttons on the right: «На сайте» (`outline`, icon `Globe`, opens
the landing `/careers/{slug}` in a new tab, visible only for PUBLISHED/CLOSED — a DRAFT does not yet have
a public page) · «Закрыть вакансию» (`outline`, PUBLISHED only) / «Восстановить» (CLOSED only)
— the status actions duplicate §4.1.1, not independent new logic.

`AnimatedTabs`: «Детали» / `` `Отклики${count ? ` · ${count}` : ''}` `` (§3.2).

**The «Детали» tab:** a two-column layout `flex gap-[22px]` — the left column `flex-1 min-w-[420px]`
— the «Общая информация» card (the same fields as in the creation Sheet, §4.2, but an inline form without the Sheet
wrapper, footer «Отмена»/«Сохранить изменения»); the right column `w-[308px] flex-shrink-0` — 3
cards: «Статус» (the current status pill + a status change button + an explanation), «Статистика»
(«Откликов: N», «Новых: [badge N]», a divider, «Создано: {date}», «Опубликовано: {date}» —
format via `date-fns` + the `ru` locale, the `document-card.tsx:129-138` pattern
`formatDistanceToNow`/`format`), «Опасная зона» (`border-destructive/30`, title `text-destructive`,
the «Удалить вакансию» button — **disabled + Tooltip except for DRAFT + 0 applications**, see §4.1.1 — the mockup
shows this button ACTIVE on a PUBLISHED vacancy with 12 applications, which is a direct violation of the backend
rule, it must be fixed during implementation).

At ≤1024 the columns stack into one (`flex-col`), the right column of cards — under the main form.

**The «Отклики» tab:** a `SegmentedToggle` filter «Все N» / «Новые N» / «Просмотренные» / «Отклонённые»
(§3.2) → a vertical list of `CandidateCard` (`max-w-[768px]`, `gap-16px`).

## 5. `CandidateCard` — details

An initials avatar (`Avatar`+`AvatarFallback`) + name + a «Новый» badge (**only if
`status === 'NEW'`** — in the mockup it is a separate `isNew` prop, but the `vacancy_applications` schema has no
separate "reviewed" field other than `status`; `isNew`/highlight ring/badge — all three are derivatives
of ONE AND THE SAME `status === 'NEW'`, do not introduce a separate field) + the date on the right (`date-fns` `ru`) →
email (a `mailto:` link) → a row of contact chips (telegram — if specified; `github`/`linkedin` —
brand names, do NOT translate, but double-check: in the schema `githubUrl`/`linkedinUrl` are full
URLs, not just a boolean "has an account" as in the mockup — render `<a href={application.githubUrl}>`,
not a placeholder `href="#"`) → `<details>` «Сопроводительное письмо» (only if `coverLetter` is not
empty — otherwise do not render the block at all) → `Separator` → footer: «Скачать резюме» (`outline`, icon
`Download`, see §6) + delete (`ghost` icon-only `Trash2`, aria-label «Удалить отклик») on the left,
`SegmentedToggle` «Новый/Просмотрено/Отклонено» on the right.

The highlight ring for unreviewed (`box-shadow` in the mockup) — Tailwind: `ring-1 ring-primary/45` on
the card's root `div`, apply when `status === 'NEW'`.

## 6. Resume download (presigned)

Endpoint `GET /api/vacancies/:vacancyId/applications/:appId/resume-url` → `{ url, expiresAt }`,
TTL 600s (10 min, `RESUME_PRESIGN_TTL_SEC` in `applications.service.ts`). A pattern 1:1 with
`useDocumentDownloadUrl` (`apps/web/app/hooks/use-documents.ts:96-111`):

```ts
// apps/web/app/hooks/use-vacancies.ts (new file)
export function useApplicationResumeUrl(
  vacancyId: string,
  appId: string | undefined,
  options?: { enabled?: boolean },
) {
  return useQuery<VacancyApplicationResumeUrl, Error>({
    queryKey: ['vacancies', vacancyId, 'applications', appId, 'resume-url'],
    queryFn: async () =>
      (await api.get(`/vacancies/${vacancyId}/applications/${appId}/resume-url`)).data,
    enabled: Boolean(appId) && (options?.enabled ?? true),
    retry: 1,
  })
}
```

The «Скачать резюме» button → `await refetch()` → `window.open(result.data.url, '_blank',
'noopener,noreferrer')` (do NOT cache statically — the presigned URL expires in 10 min, staleTime
short or 0, unlike `useDocumentDownloadUrl`, whose `DOCUMENT_URL_STALE_MS` is tuned
for documents with a longer TTL — check against the real document TTL, do not copy staleTime
thoughtlessly).

## 7. Confirm dialogs (`AlertDialog`)

### 7.1. Deleting a vacancy

The trigger — only when the button is not `disabled` (§4.1.1). Text:
«Удалить вакансию?» / «Вакансия «{title}» будет удалена навсегда вместе с {N} откликами и
загруженными файлами резюме. Это действие необратимо.» — **in practice `N` is always `0`** (the button is
disabled when `applicationsCount > 0`), but we keep the text generic (defensive — in case of a race, if an
application arrived between opening the page and clicking "Удалить", the backend will still return 409, the dialog
must not state an exact number that is knowingly wrong; an option — simply remove the mention of the number of
applications from the text since it is always 0: «Вакансия «{title}» будет удалена навсегда. Это действие
необратимо.» — **this simplified variant is recommended**, shorter and cannot lie).

### 7.2. Deleting an application

Text: «Удалить отклик?» / «Отклик кандидата {fullName} будет удалён. Загруженный файл резюме также
будет удалён с сервера. Это действие необратимо.» — **the mockup mentions a specific file name
(`dmytro_cv.pdf`) — in the real `vacancy_applications` schema there is NO field with the original file name**
(only `resumeS3Key`/`resumeSizeBytes`, the `resume-url` endpoint generates the download name itself from
`fullName` on the fly, see `applications.service.ts:290-295` `sanitizeDownloadFilename(row.fullName)`)
— **do not show the file name in the dialog**, it simply does not exist as data on the frontend.

Both dialogs — `variant="destructive"` on `AlertDialogAction`, `AlertDialogCancel` — «Отмена».
409/mutation error → `toast.error(error.response?.data?.message ?? 'Не удалось удалить')` (the backend
already returns the ready Russian text in `ConflictException`, just pass it through).

## 8. Navigation

`apps/web/app/components/crm/nav-sidebar.tsx` — add to `NAV_ITEMS` (after «Документы», before
«Профиль» — «Профиль» must stay last for the JUNIOR convention, see the comment in the file):

```ts
{ label: 'Вакансии', icon: UserPlus, to: '/vacancies', roles: navRolesFor('/vacancies') },
```

**Icon:** the mockup uses a briefcase outline, identical to the already taken `Briefcase` icon
(used for «Проекты», line 74 of `nav-sidebar.tsx`) — **a conflict, a different icon is needed** so that
the items are visually distinguishable. Recommendation: `UserPlus` (`lucide-react`, "adding a new
person" — semantically matches the "hiring channel" exactly) — a standard `lucide-react` icon,
should be available in the installed version `^1.14.0` (not physically verified — there is no `node_modules` in
this working tree, check `import { UserPlus } from 'lucide-react'` during implementation; if for
some reason it is unavailable — the alternative is `Megaphone` or `ClipboardList`).

`apps/web/app/lib/route-access.ts` — add to `ROUTE_ACCESS`:

```ts
{ prefix: '/vacancies', roles: ['ADMIN', 'HR'] },
```

(next to the other ADMIN/HR-restricted entries — verify the exact place by the existing order of the
file). `navRolesFor('/vacancies')` will pick up the same roles automatically (a single source of truth, see the
route-access.ts file header).

## 9. A11y (WCAG 2.2 AA critical paths)

- **Target size (SC 2.5.8):** all interactive elements ≥ 24×24px; on mobile cards (320) —
  explicit `h-11 w-11` (44px) buttons, as already in the mockup (kebab/icon-only).
- **Focus order (SC 2.4.11):** the Sheet on open moves focus to the first field («Название
  вакансии»); `AlertDialog` (Radix) — an automatic focus trap + focus on `AlertDialogCancel` by
  default (a Radix convention, nothing extra needs to be done); `Escape` closes both the Sheet and the AlertDialog
  out of the box (the Radix `Dialog`/`AlertDialog` primitives).
- **Contrast (SC 1.4.3):** status badges (`secondary`/`status-active`/the red `className` override) —
  already verified theme tokens (used elsewhere in the CRM), do not invent new
  color pairs. Domain-dot colors (§3.4) — decorative-only (accompanied by a text label next to them,
  they carry no meaning by themselves — they are not required to pass 4.5:1 like body text, but
  ≥3:1 against the card background is desirable, the oklch values from the landing spec are already chosen for a dark background).
- **Icon-only buttons:** ALL (delete/edit/kebab/restore-icon) — a mandatory
  `aria-label` (see the specific texts in place in §4/§5). The kebab menu on mobile —
  `aria-label="Ещё действия"`.
- **`SegmentedToggle`/`AnimatedTabs`:** already a11y-correct out of the box (`role="radiogroup"`/`radio`
  or `role="tablist"`/`tab`, keyboard-accessible, see the component sources) — nothing extra needs to be
  done, only pass a meaningful container `ariaLabel` («Фильтр вакансий по статусу», «Статус
  отклика кандидата {fullName}», etc.).
- **`<details>`/`<summary>`** («Сопроводительное письмо») — natively accessible by keyboard and
  screen readers with no extra work.

## 10. Edge cases

| Case                                                                                       | Behavior                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0 vacancies**                                                                            | A full-size empty state, see §4.1 "Empty list"                                                                                                                                                                                                                                                                    |
| **0 applications for a vacancy**                                                           | An empty state inside the «Отклики» tab (icon `Users`, «Пока нет откликов», «Кандидаты появятся здесь, как только отправят заявку через страницу карьеры.», button «Посмотреть на сайте» — only if PUBLISHED/CLOSED)                                                                                              |
| **50+ vacancies**                                                                          | A simple grid without pagination in v1 (YAGNI, symmetrical to the `landing-redesign.md` §8 decision "10+ vacancies on /careers" — if it becomes a problem, a separate task; the `SegmentedToggle` filter already reduces visual noise)                                                                            |
| **Long vacancy title**                                                                     | `h3`/`h2` — `text-wrap: pretty` (Tailwind `text-pretty`), wraps to 2 lines, do NOT truncate with an ellipsis (unlike a document title, where truncation is appropriate — here the title is primary for scanning)                                                                                                  |
| **Long markdown description**                                                              | `ContractEditor` already has an internal scroll (`overflow-auto`) at a fixed height — it does not stretch the layout                                                                                                                                                                                              |
| **Duplicate slug on creation**                                                             | The backend will probably return 409/400 on the unique constraint (`slug UNIQUE`) — show `toast.error` with the backend text, the slug field gets `aria-invalid` + an error text under the input (clarify the exact error code with Coder/backend during implementation — not specified in the provided API spec) |
| **Candidate without telegram/github/linkedin**                                             | The corresponding chip is simply not rendered (already so in the mockup via `sc-if`)                                                                                                                                                                                                                              |
| **Candidate without a cover letter**                                                       | The «Сопроводительное письмо» block is not rendered at all (do not show an empty disclosure)                                                                                                                                                                                                                      |
| **Race: an application arrived while HR is looking at the disabled vacancy-delete button** | The UI is not required to invalidate in real time — on the next click/refetch the button will become disabled by itself (react-query invalidation by the standard list TTL)                                                                                                                                       |
| **Resume download — network error**                                                        | `toast.error('Не удалось получить ссылку на резюме')`, the button returns to the active state (does not stick in loading)                                                                                                                                                                                         |

## 11. Known deviations from the static mockup (summary)

Each is already covered in place above — a summary for a quick check during code review (Mode B):

1. **Language:** UK → RU everywhere, except domain badges and seniority (§0, §3.5, §3.6).
2. **Active segment of tabs/filters:** a neutral `var(--card)` in the mockup → gold `bg-primary`
   (reuse of existing components, §3.2).
3. **Vacancy delete button:** unconditionally active in the mockup → `disabled`+`Tooltip` except for
   DRAFT + 0 applications, INCLUDING the Danger Zone on the detail page (§4.1.1, §4.3).
4. **Delete icon on a CLOSED card:** present in the mockup → in reality `disabled` (the same as item 3).
5. **Sidebar icon:** `Briefcase` (as in the mockup) conflicts with «Проекты» → `UserPlus` (§8).
6. **Resume file name in the application-deletion dialog:** present in the mockup → removed (no data in the schema, §7.2).
7. **CodeMirror placeholder + hint icon in the description text field:** this is a designer
   meta-note, not real UI → the real field = `ContractEditor` without the hint (§4.2).

## 12. Fidelity references (for Mode B)

Rendered locally from `vacancies-admin.dc.html` (Playwright, a static HTTP server on the `_ds/`
bundle):

| File                                     | Contents                                                                                                       | Width                                       |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `assets/crm-vacancies/design.png`        | The full canvas: both screens, all state panels (default/empty/loading/delete-confirm/responsive 1024/768/320) | 2300×8442 (1440/1024/768/320 panels inside) |
| `assets/crm-vacancies/design-mobile.png` | A composite of 2 crops: the mobile list (320) + the mobile detail page (320), side by side                     | 664×589 (2× 320px frames)                   |

`assets/crm-vacancies/VacancyCard.dc.html` / `CandidateCard.dc.html` — the sources of the card components
(with the `sc-if` state logic, useful for cross-checking all branches of `status`/`isDraft`/`isNew`, etc. — see
`renderVals()` in each file). `Sidebar.dc.html`/`TopBar.dc.html` — NOT a reference for implementation (see
§0 — the language there is wrong, and it is knowingly a "representative shell", not our real `nav-sidebar.tsx`).

## 13. Fidelity acceptance checklist (Mode B, after implementation)

- [ ] All UI strings are Russian (check against §0/§3.5/§3.6 — the only exception: domain badges and
      seniority)
- [ ] Status badges (Черновик/Опубликовано/Закрыто) — colors match §3.5
- [ ] The «Удалить вакансию» button — disabled+tooltip everywhere except DRAFT + 0 applications (the list AND the detail
      Danger Zone)
- [ ] `SegmentedToggle`/`AnimatedTabs` — a gold active segment (not neutral, see §11 item 2)
- [ ] Sidebar — the «Вакансии» item with the `UserPlus` icon (not `Briefcase`), ADMIN/HR only
- [ ] Responsive — 320/768/1024/1440, cards collapse into 1 column ≤1023px, the Sheet stays
      right-side at all widths (mobile — `w-full` by default for `Sheet`)
- [ ] Buttons on mobile cards — ≥44px (touch target)
- [ ] Resume download — presigned URL, `window.open`, the 10 min TTL is respected (not cached longer)
- [ ] The application-deletion dialog — WITHOUT a file name (§11 item 6)
- [ ] `ContractEditor` reused for the vacancy description (not a new `<textarea>`)
- [ ] A11y: aria-label on all icon-only buttons, a focus trap in Sheet/AlertDialog, `Escape` closes
