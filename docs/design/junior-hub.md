# Design Spec: "Мой проект" hub + "Легенда" page + JUNIOR navigation

> Mode A — Design Direction (pre-feature)
> Spec slug: `junior-hub`
> Phase: junior UX refactor, phase 2
> Coder task: `.claude/tasks/task-junior-ux-2-hub.md`
> Author: ui-ux-designer · 2026-06-11

---

## 1. Direction (frontend-design-direction)

### 1.1 Purpose

The interface solves three tasks for the JUNIOR:

1. **"Мой проект" hub** — see at a glance the status of the active project, the "senior" persona per the legend, the status of their contract, the latest salary, the HR contact. Replaces the empty dashboard.
2. **"Легенда" page** — read and extend the living persona document (persona / cover story / event journal) before client calls.
3. **Navigation** — exactly 5 sections with no extra noise (Мой проект · Легенда · Финансы · Документы · Профиль).

### 1.2 Audience

**Who:** a JUNIOR developer, an active member of a project.
**Usage pattern:** 1–3 sessions a day, each 1–3 minutes. Scenarios:

- Morning: check the contract status, the latest salary before a call with the client.
- Before a call: open "Легенда", refresh the persona + cover story.
- After an event: add an entry to the legend journal ("the client asked about education, we said МГУ").
- Occasionally: go to Финансы / Документы via the quick links.

The junior **does not manage** — they are a consumer of information + keep the journal. The interface must minimize cognitive load: no extra actions, no ADMIN noise, no data that does not belong to them.

### 1.3 Tone

`dense / quiet / scannable`

- Dense: the maximum of needed information without scrolling on desktop (≥ 1024px).
- Quiet: no decorative elements. Cards with `border-border/40` and `bg-card`, not `bg-gradient-*`.
- Scannable: hierarchy through font size, not color. Statuses — Badge with existing variants (`role`, `outline`, `secondary`). Amounts — `tabular-nums`.

**Forbidden for this screen:** purple/gradient hero, glass morphism, oversized cards, decorative icons without semantics.

### 1.4 Memorable detail

**The "Project senior" persona card** — the only element with character: an initials avatar on `bg-yellow-subtle` with `text-primary` (brand yellow), the bold full name from the legend, `text-muted-foreground` for the role. This is the signal: "who you are to the client". No real photo, no senior contacts — only the persona.

Effect: going from the Hub to the Legend feels like "opening my dossier", not "opening settings".

### 1.5 Constraints

- Tailwind v4 CSS-first (`@theme inline` tokens from `globals.css`), no hardcoded hex
- shadcn/ui components as the base (Card, Badge, Button, Avatar, Skeleton, Separator, Tooltip, ScrollArea)
- Framer Motion for enter animations (stagger pattern, already used in `crm/index.tsx`)
- WCAG 2.2 Level AA — minimum target size 24×24px, focus ring, contrast 4.5:1 text / 3:1 UI
- Responsive: 320 / 768 / 1024 / 1440
- Russian UI: all user-facing texts in Russian
- TanStack Router file-based routes (`apps/web/app/routes/crm/`)
- TanStack Query for data fetching (reuse the hooks: `useLegend`, `useAddLegendEntry`, `useUpsertLegend`)
- Do NOT show the real senior/drop: full name + role — only from `legend.fullName` / `legend.presentedRole`
- Do NOT show `rate` / `currency` / project distributions

---

## 2. Component list

### 2.1 Existing shadcn/ui (reuse without changes)

| Component                                                        | Where used                                                          |
| ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| `Card`, `CardHeader`, `CardContent`, `CardTitle`                 | All hub blocks and the legend page                                  |
| `Avatar`, `AvatarFallback`                                       | Persona initials avatar; no `AvatarImage` — only initials           |
| `Badge`                                                          | Contract status, payout status, project status                      |
| `Button`                                                         | CTAs "Подписать", "Открыть легенду", "Добавить запись", quick links |
| `Skeleton`                                                       | Loading state of all hub blocks                                     |
| `Separator`                                                      | Divider in the HR block, between legend sections                    |
| `Tooltip`, `TooltipProvider`, `TooltipTrigger`, `TooltipContent` | Collapsed-sidebar tooltips, hint on amounts                         |
| `ScrollArea`                                                     | Legend journal when > 5 entries                                     |
| `Textarea`                                                       | Field for adding a journal entry                                    |
| `Input`, `Label`                                                 | Legend edit form (persona / cover)                                  |

### 2.2 Existing project components (reuse)

| Component                                           | Where                                          | How to use                                  |
| --------------------------------------------------- | ---------------------------------------------- | ------------------------------------------- |
| `ProjectLogo`                                       | `components/projects/ProjectLogo.tsx`          | Logo in the hub's project card              |
| `ProjectLegendSection`                              | `components/projects/ProjectLegendSection.tsx` | On the "Легенда" page — the whole edit flow |
| `useLegend`, `useUpsertLegend`, `useAddLegendEntry` | `hooks/use-legend.ts`                          | Legend data layer                           |
| `BrandMark`                                         | `components/brand-mark.tsx`                    | Already in the sidebar                      |
| `useActiveTeam`                                     | `hooks/use-active-team.ts`                     | Get the HR contact from the team            |

### 2.3 New components (Coder creates)

| Component / hook     | File (proposed)                                        | Responsibility                                            |
| -------------------- | ------------------------------------------------------ | --------------------------------------------------------- |
| `JuniorProjectHub`   | `routes/crm/project.tsx` (rewrite / replace)           | Root hub component                                        |
| `ProjectInfoCard`    | `routes/crm/project/components/ProjectInfoCard.tsx`    | Project card (logo · company · domain · start · status)   |
| `PersonaCard`        | `routes/crm/project/components/PersonaCard.tsx`        | "Senior" persona: initials · full name · role · CTA       |
| `ContractStatusCard` | `routes/crm/project/components/ContractStatusCard.tsx` | Contract status + "Подписать" CTA                         |
| `SalarySnapshotCard` | `routes/crm/project/components/SalarySnapshotCard.tsx` | Latest payout (amount · month · status) + link            |
| `HrContactCard`      | `routes/crm/project/components/HrContactCard.tsx`      | HR: name + contact                                        |
| `QuickLinksBar`      | `routes/crm/project/components/QuickLinksBar.tsx`      | Quick links: Легенда · Документы · Финансы                |
| `ProjectSwitcher`    | `routes/crm/project/components/ProjectSwitcher.tsx`    | Switcher when there is > 1 active project                 |
| `LegendPage`         | `routes/crm/legend.tsx`                                | "Легенда" page (wrapper)                                  |
| `LegendPersonaBlock` | `routes/crm/legend/components/LegendPersonaBlock.tsx`  | Persona block with avatar                                 |
| `LegendCoverBlock`   | `routes/crm/legend/components/LegendCoverBlock.tsx`    | Cover story block                                         |
| `LegendJournalBlock` | `routes/crm/legend/components/LegendJournalBlock.tsx`  | Journal (append-only)                                     |
| `useJuniorProject`   | `hooks/use-junior-project.ts`                          | Query `/api/projects/my` → the JUNIOR's active project(s) |

> **Note on the route:** `routes/crm/project.tsx` (without `$projectId`) — a new route `/crm/project` for JUNIOR only. The existing `routes/crm/projects/$projectId.tsx` is not touched.

---

## 3. Token map

All tokens come from `apps/web/app/styles/globals.css`. No new tokens needed.

| Purpose                            | Token                                     | Tailwind class                |
| ---------------------------------- | ----------------------------------------- | ----------------------------- |
| Page background                    | `--color-background`                      | `bg-background`               |
| Cards                              | `--color-card`                            | `bg-card`                     |
| Elevated surfaces (sidebar active) | `--color-surface`                         | `bg-surface`                  |
| Card border                        | `--color-border`                          | `border-border/40`            |
| Primary text                       | `--color-foreground`                      | `text-foreground`             |
| Secondary text (captions, hints)   | `--color-muted-foreground`                | `text-muted-foreground`       |
| Avatar initials: background        | `--color-yellow-subtle`                   | `bg-yellow-subtle`            |
| Avatar initials: text              | `--color-primary`                         | `text-primary`                |
| CTA buttons (primary)              | `--color-primary`                         | `bg-primary` (Button default) |
| Hover/ghost states                 | `--color-accent`                          | `hover:bg-accent`             |
| Destructive (errors, rejections)   | `--color-destructive`                     | `text-destructive`            |
| Radius (cards)                     | `--radius-lg` = `var(--radius)`           | `rounded-lg` (`0.625rem`)     |
| Radius (buttons inside a card)     | `--radius-md` = `var(--radius) - 2px`     | `rounded-md`                  |
| Amounts (tabular digits)           | CSS: `font-variant-numeric: tabular-nums` | `tabular-nums` (Tailwind v4)  |

**Concentric radius (make-interfaces-feel-better):** Card `rounded-lg` (0.625rem) → Button inside `rounded-md` (0.5rem). Card padding `p-4` (1rem) — the difference is sufficient, the optics are correct.

**Status colors for Badge** — we use the existing variants from `components/ui/badge.tsx`:

- Contract signed → `variant="outline"` + CheckCircle icon `text-green-500`
- Contract not signed → `variant="default"` (primary yellow) — CTA
- Payout PAID → `variant="outline"` green tint
- Payout PENDING → `variant="secondary"`
- Project status ACTIVE → `variant="outline"` with a green dot
- Project status CLOSED → `variant="secondary"` muted

> If `badge.tsx` does not contain status variants — add `status-active` / `status-closed` / `paid` / `pending` as CSS-var-based variants (not hardcoded hex) in `badge.tsx`. Check `badge.tsx` before implementing.

---

## 4. Layout spec

### 4.1 "Мой проект" hub (`/crm/project`)

#### Desktop ≥ 1024px (2-column CSS grid)

```
┌─────────────────────────────────────────────────────────┐
│ [ProjectSwitcher — only if >1 project]                  │
├──────────────────────┬──────────────────────────────────┤
│ ProjectInfoCard      │ PersonaCard                      │
│ (logo · company ·   │ (initials avatar · full name ·   │
│  domain · start ·   │  role · «Открыть легенду»)        │
│  status)            │                                   │
├──────────────────────┼──────────────────────────────────┤
│ ContractStatusCard   │ SalarySnapshotCard               │
│ (status · CTA)      │ (amount · month · status · link)  │
├──────────────────────┴──────────────────────────────────┤
│ HrContactCard (name · contact)                          │
├─────────────────────────────────────────────────────────┤
│ QuickLinksBar (Легенда · Документы · Финансы)           │
└─────────────────────────────────────────────────────────┘
```

CSS: `grid-cols-1 md:grid-cols-2 gap-4`. Rows 1-2 = `grid-cols-2`. Rows 3-4 = `col-span-full`.

#### Mobile < 768px (1 column)

Block order: ProjectInfoCard → PersonaCard → ContractStatusCard → SalarySnapshotCard → HrContactCard → QuickLinksBar. Stacked, full width.

#### Mobile stack < 320px

Cards `w-full`, no horizontal overflow. Avatar initials `h-10 w-10` (40×40px, min hit area = 44×44px via padding). Buttons at least `h-9` (36px) + touch padding.

### 4.2 "Легенда" page (`/crm/legend`)

#### Desktop ≥ 1024px

```
┌─────────────────────────────────────────────────────────┐
│ Heading «Легенда» + subtitle (project · senior)         │
├──────────────────────┬──────────────────────────────────┤
│ LegendPersonaBlock   │ LegendCoverBlock                 │
│ (full name · DOB ·  │ (role · stack · background)      │
│  address · hobbies  │ + edit)                          │
├──────────────────────┴──────────────────────────────────┤
│ LegendJournalBlock (journal — append-only feed)         │
└─────────────────────────────────────────────────────────┘
```

#### Mobile < 768px: 1 column, stacked.

### 4.3 JUNIOR navigation

`NAV_ITEMS` in `nav-sidebar.tsx` — for the `JUNIOR` role exactly 5 items:

| #   | Item       | Icon                | Route            |
| --- | ---------- | ------------------- | ---------------- |
| 1   | Мой проект | `Home` (lucide)     | `/crm/project`   |
| 2   | Легенда    | `BookOpen` (lucide) | `/crm/legend`    |
| 3   | Финансы    | `DollarSign`        | `/crm/finance`   |
| 4   | Документы  | `FileText`          | `/crm/documents` |
| 5   | Профиль    | `UserCircle`        | `/crm/profile`   |

Remove for JUNIOR: `Дашборд` (`/crm/dashboard`) · `Команда` · `Проекты` · `Собеседования`.
Other roles — unchanged.

Redirect: on login JUNIOR → `/crm/project` (analogous to DROP → `/crm/profile`).
Apply in `routes/crm/index.tsx` (the CrmDashboard component, next to the DROP redirect).

---

## 5. Motion spec

We use the same Framer Motion stagger pattern as in `routes/crm/index.tsx`:

```tsx
const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.06 } },
}
const card = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: [0.25, 0.1, 0.25, 1] } },
}
```

Apply to the `motion.div` wrappers of the cards on the first load of the hub.

**Motion rules (make-interfaces-feel-better):**

- Enter: opacity + `translateY(12px)`, stagger 60ms between cards.
- Exit: not needed on the hub (the page does not change its set of cards).
- Skeleton → data: no transition animation (React just swaps), to avoid jitter.
- Icon swap (Pencil → Save, CheckCircle → Spinner): cross-fade via `transition-property: opacity, transform; duration: 150ms`.
- Forbidden: `transition: all`, `will-change: all`, scroll-triggered animations.
- Project switcher (ProjectSwitcher): `transition-property: opacity; duration: 200ms` when the active project changes.

---

## 6. A11y critical paths (WCAG 2.2)

**Skill: `accessibility` applied for the following critical paths:**

### 6.1 Focus order (SC 1.3.2 / 2.4.3)

Logical focus order on the hub:

1. ProjectSwitcher (if present)
2. ProjectInfoCard (no interactive elements — tabindex not needed)
3. PersonaCard → the "Открыть легенду" button
4. ContractStatusCard → the "Подписать контракт" button (if present)
5. SalarySnapshotCard → the "Все мои выплаты" link
6. HrContactCard (no interactive elements)
7. QuickLinksBar → 3 links

The DOM order must match the visual one — do not use CSS `order` without `tabindex`.

On the "Легенда" page:

1. Heading (h1)
2. PersonaBlock "Редактировать" button → form (if editing: fields in order → Save button → Cancel button)
3. CoverBlock "Редактировать" button
4. JournalBlock → list of entries (li) → "Добавить запись" button → textarea (if open) → Save / Cancel

### 6.2 Target size (SC 2.5.8 minimum 24×24px; aim 44×44px)

| Element                              | Visual size  | Hit area                                   | Class                           |
| ------------------------------------ | ------------ | ------------------------------------------ | ------------------------------- |
| "Открыть легенду" button             | `h-8` (32px) | `h-9 px-3` ≥ 44px touch                    | `size="sm"` Button → ok         |
| "Подписать контракт" button (CTA)    | `h-8` (32px) | `h-9 px-4`                                 | `size="sm"` Button              |
| Avatar initials (link to the legend) | 40×40px      | `min-w-[44px] min-h-[44px]` anchor element |                                 |
| QuickLinksBar quick links            | `h-9` (36px) | `h-10 px-3`                                | `size="sm"` + `py-1`            |
| "Добавить запись" button (journal)   | `h-7` (28px) | `h-8 min-w-[24px]`                         | Check ≥ 24px                    |
| Project switcher                     | `h-8`        | `h-9 px-3`                                 | SegmentedToggle or Button group |

### 6.3 Contrast (SC 1.4.3: 4.5:1 normal; SC 1.4.11: 3:1 UI)

Tokens from `globals.css` checked:

| Element                          | Foreground token                                         | Background token                | Ratio (approx)                                                                                                   | Status |
| -------------------------------- | -------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------ |
| Primary text on cards            | `--foreground` L=0.97                                    | `--card` L=0.12                 | > 10:1                                                                                                           | PASS   |
| Muted text (captions)            | `--muted-foreground` L=0.58                              | `--card` L=0.12                 | ~5.5:1                                                                                                           | PASS   |
| Avatar initials text             | `--primary` L=0.84 c=0.183                               | `--yellow-subtle` L=0.22 c=0.04 | **ATTENTION** — verify in the implementation; with an L difference < 0.5 the contrast may drop below 3:1 on dark |        |
| "Подписать" badge (primary fill) | `--primary-foreground` L=0.08                            | `--primary` L=0.84              | > 7:1                                                                                                            | PASS   |
| Green status dot                 | `oklch(0.65 0.2 142)` (CSS green-600) on `--card` L=0.12 | ~4.8:1                          | PASS                                                                                                             |        |

> **Avatar initials CRITICAL CHECK:** In dark mode `--yellow-subtle` = `oklch(0.22 0.04 85.3)`, the `--primary` text = `oklch(0.84 0.183 85.3)`. Lightness delta = 0.62 — sufficient. However, the Coder MUST verify with a contrast checker tool after implementation. Alternative if it fails: use a `--surface` (L=0.16) background + `--primary` text.

### 6.4 Icon-only buttons — aria-label

| Element                                  | Requirement                                         |
| ---------------------------------------- | --------------------------------------------------- |
| "Edit" persona button (Pencil icon only) | `aria-label="Редактировать персону"`                |
| "Edit" cover button (Pencil icon only)   | `aria-label="Редактировать cover story"`            |
| "Add entry" button (Plus icon only)      | `aria-label="Добавить запись в журнал"`             |
| ProjectSwitcher collapse/expand button   | `aria-label="Переключить проект"` + `aria-expanded` |

If a button contains text (`<Pencil /> Редактировать`) — `aria-label` is not needed.

### 6.5 Focus indicators (SC 2.4.11)

We use `outline-ring` from `globals.css` (`outline-color: var(--ring)`). Check that all `Button variant="ghost"` and `Link` components have no `outline: none` without an alternative. The shadcn/ui Button has `focus-visible:ring-2 focus-visible:ring-ring` by default — do not override.

### 6.6 Semantics

- Hub page: `<main>` → `<h1>Мой проект</h1>` (or `sr-only` if the design does not show a heading explicitly).
- Legend page: `<main>` → `<h1>Легенда</h1>` + `<section aria-labelledby>` for each block (persona, cover, journal).
- Journal: `<ol>` (ordered) or `<ul>` — a chronological list of entries.
- ProjectSwitcher with 2 projects: `role="group"` + `aria-label="Выбор проекта"`, buttons with `aria-pressed`.
- Status indicators: not only color — always Badge + text or icon + text.

### 6.7 Reflow (SC 1.4.10)

Layout via CSS grid with `grid-cols-1 md:grid-cols-2` → at 400% zoom on a 1440px screen = the mobile layout. There must be no horizontal scroll. Check: cards `w-full`, ProjectLogo `max-w-[3rem] shrink-0`.

---

## 7. Data contracts (what the Coder takes from the API)

### 7.1 Hub — data

```
GET /api/projects/my
→ ProjectDto[] (active only for JUNIOR, per RBAC)
  - id, name, logoUrl, companyName, domain, startDate, status
  - NOT included: rate, currency, seniorSharePercent, dropSharePercent

From projectId → GET /api/projects/:id/legend
→ LegendDto { fullName, presentedRole, entries[] }
  Only fullName + presentedRole are needed for the hub's PersonaCard

From projectId → GET /api/contracts/my (or /api/employee-contracts?projectId=...)
→ { status: 'SIGNED' | 'PENDING_SIGNATURE' | null }

GET /api/finance/payout-requests?limit=1&sort=date_desc
→ last payout { amount, currency, month, status }
  SALARY type only, own only (JUNIOR RBAC)

From team → HR user { displayName, telegramHandle, phone }
  (via /api/projects/:id — it has seniorId, HR can be pulled out via the team)
  Or a separate endpoint /api/projects/:id/team-hr → { name, contact }
```

> **Note to the Coder:** if `/api/projects/my` does not exist — create the endpoint or reuse `/api/projects?memberId=me`. The endpoint must return ONLY projects where the current user = an active project_member. Financial masking is mandatory (no rate/currency).

### 7.2 "Легенда" page — data

```
GET /api/projects/:projectId/legend
→ Legend { fullName, dateOfBirth, address, hobbies, presentedRole, presentedStack, backstory, entries[] }

PUT /api/projects/:projectId/legend (UpsertLegendDto)
→ Legend

POST /api/projects/:projectId/legend/entries (AddLegendEntryDto)
→ Legend (with the updated entries[])
```

All hooks are already implemented: `useLegend`, `useUpsertLegend`, `useAddLegendEntry` in `hooks/use-legend.ts`.

---

## 8. Edge cases

### 8.1 Hub

| Case                              | Behavior                                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| No active projects                | Empty state: `<EmptyState>` with the text «Вас ещё не добавили в проект. Свяжитесь с вашим HR.» + a contact if available |
| One active project (99% of cases) | ProjectSwitcher is not rendered                                                                                          |
| Two active projects               | ProjectSwitcher — `SegmentedToggle` at the top (the existing `segmented-toggle.tsx`)                                     |
| More than two projects            | The spec supports up to 2; if 3+ — show the first active + a warning in console.warn (the UI does not break)             |
| Legend not filled in              | PersonaCard: avatar "?" initials, full name «—», role «—», the "Открыть легенду" button (CTA)                            |
| HR not found in the team          | HrContactCard: «HR не назначен. Обратитесь к администратору.»                                                            |
| Contract does not exist           | ContractStatusCard: «Контракт не оформлен» (Badge secondary)                                                             |
| No payouts                        | SalarySnapshotCard: «Выплат пока нет» (text-muted-foreground)                                                            |
| Loading                           | All cards → `<Skeleton>` of the corresponding height. Do not show empty card frames without data.                        |
| API error                         | Toast.error (sonner) + a retry button in the block where the error is; other cards keep working (independent queries)    |

### 8.2 "Легенда" page

| Case                                            | Behavior                                                                                                                                              |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Legend empty (first open)                       | Empty state with a "Создать легенду" button (ADMIN/HR can create; the JUNIOR sees the CTA if they are an editor too)                                  |
| Journal empty                                   | «Записей пока нет» + a "Добавить первую запись" button                                                                                                |
| User is the subject of the legend (senior/drop) | The `/crm/legend` page is unavailable to them (the backend returns 403); on the frontend: redirect to `/crm/profile` or an empty state with a message |
| ACCOUNTANT / another SENIOR                     | 403 from `/api/projects/:id/legend`; the `useLegend` hook handles 403 → null; the page shows «У вас нет доступа»                                      |
| Journal > 10 entries                            | ScrollArea with a fixed height `max-h-80` (20rem)                                                                                                     |
| Entry text > 500 characters                     | Textarea `maxLength={2000}`, counter «X / 2000» below the textarea                                                                                    |
| Legend save error                               | Toast.error + the form stays open (do not close on error)                                                                                             |
| Concurrent editing                              | `staleTime: 30_000` in useLegend; on successful upsert → invalidate query → re-fetch the latest data                                                  |

---

## 9. data-testid map (for AutoTest)

Stable selectors for E2E tests — only `data-testid`, not classes:

| data-testid               | Element                                              |
| ------------------------- | ---------------------------------------------------- |
| `junior-hub`              | Root div of the `JuniorProjectHub` hub               |
| `project-info-card`       | `ProjectInfoCard`                                    |
| `persona-card`            | `PersonaCard`                                        |
| `persona-fullname`        | The "senior" name from the legend (full name)        |
| `persona-role`            | The "senior" role (presentedRole)                    |
| `persona-open-legend-btn` | The "Открыть легенду" button                         |
| `contract-status-card`    | `ContractStatusCard`                                 |
| `contract-status-badge`   | Badge with the contract status                       |
| `contract-sign-btn`       | The "Подписать контракт" CTA (if visible)            |
| `salary-snapshot-card`    | `SalarySnapshotCard`                                 |
| `salary-last-amount`      | Amount of the latest payout (tabular-nums)           |
| `salary-all-link`         | The "Все мои выплаты" link                           |
| `hr-contact-card`         | `HrContactCard`                                      |
| `quick-links-bar`         | `QuickLinksBar`                                      |
| `quick-link-legend`       | The "Легенда" link in QuickLinksBar                  |
| `project-switcher`        | ProjectSwitcher (only with > 1 project)              |
| `legend-page`             | Root div of the "Легенда" page                       |
| `legend-persona-block`    | `LegendPersonaBlock`                                 |
| `legend-cover-block`      | `LegendCoverBlock`                                   |
| `legend-journal-block`    | `LegendJournalBlock`                                 |
| `legend-entry-add-btn`    | The "Добавить запись" button                         |
| `legend-entry-textarea`   | Textarea for a new entry                             |
| `legend-entry-submit-btn` | The "Сохранить запись" button                        |
| `legend-entry-item`       | `<li>` in the journal (each entry)                   |
| `junior-nav`              | Sidebar nav for JUNIOR (wrapper for the count check) |

---

## 10. What is NOT in the scope of this spec

- UX of the senior / drop / HR / ADMIN — we do not touch.
- The JUNIOR finance section (cleanup of filters, documents subtitle) — the next phase (junior-ux-3-cleanup).
- A real photo on PersonaCard — decided: only an initials avatar (§2.3 of the product design doc).
- Active work-hub features (tasks, chat) — YAGNI.
- Changes to the "Профиль" page — light cosmetics (remove viewing others') within the existing component.

---

## 11. Handoff checklists for the Coder

### Pre-implementation

- [ ] Read the product spec `docs/architecture/2026-06-10-junior-ux-refactor-design.md` §4
- [ ] Check the existing `badge.tsx` variants — whether new ones are needed for statuses
- [ ] Confirm the `/api/projects/my` endpoint or equivalent (task-junior-ux-1-backend)
- [ ] Check that `legend.fullName` / `legend.presentedRole` are available in LegendDto from `@crm/shared`

### Post-implementation WCAG verify

- [ ] PersonaCard avatar initials: contrast checker (foreground `--primary` on `--yellow-subtle`) in dark and light mode
- [ ] All icon buttons have `aria-label` (§6.4)
- [ ] Tabular-nums on `salary-last-amount` (CSS `font-variant-numeric: tabular-nums`)
- [ ] All `Button variant="ghost"` without `outline: none` — focus ring visible
- [ ] Responsive smoke: 320px / 768px / 1024px / 1440px — no horizontal overflow
- [ ] Playwright screenshot: hub + legend at 1440px and 375px (in the PR)

### Anti-slop check (Mode C)

- [ ] No purple/gradient backgrounds on cards
- [ ] No `rounded-2xl` everywhere in a row — only `rounded-lg` / `rounded-md` from the token system
- [ ] No `shadow-xl` on all cards without reason
- [ ] No decorative blobs / illustrations behind data
- [ ] No `transition: all`
