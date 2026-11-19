# Senior technical roles UI — design spec (roles PR 5)

**Tier:** 2 (edits to existing screens). **Mode:** E-shaped conformance spec, no Claude Design round
(Master A1). **Plan:** `docs/superpowers/plans/2026-11-16-senior-roles.md`, PR 5, Tasks 5.1, 5.2, 5.4.
**Theme:** dark only. **Review:** findings only, no UI scoring before the redesign (owner, 2026-11-14).

## 1. Brief

- **Purpose.** An ADMIN, an HR (on create) or the senior (self-edit) records which technical roles a
  senior can fill. Seniors then show their roles instead of the tech stack. The queue card tells
  how many of a vacancy's technologies a senior's resume covers.
- **Audience.**
  - ADMIN and HR: a few times a month, while creating or fixing a user, mostly on a laptop.
  - A senior: once, on their own profile, sometimes on a phone.
  - HR on the queue: many times a day, scanning cards.
- **Tone.** Dense, quiet, scannable. This is an edit to existing forms, not a new surface. Nothing in
  it may look newer than the dialog it sits in.
- **Memorable detail.** One chip grammar for "what this senior is". It is the same chip in the form,
  in the users list, on the profile and in the team card. Picking a role is the same gesture as
  picking an HR today.
- **Constraints.** Tailwind v4 + shadcn/ui, our tokens only, Lingui (`uk` source, `en` catalog),
  WCAG 2.2 AA, responsive 320–1440, dark theme only.

**The model the UI must respect** (`packages/shared/src/schemas/technical-roles.ts`):

- 34 roles in 11 groups (`TECHNICAL_ROLE_GROUPS`). `GAME` and `BLOCKCHAIN` hold one role each.
- A senior picks from the 33 in `SENIOR_SELECTABLE_ROLES`. `TECHNICAL_ROLE_GROUPS` still contains
  `SOFTWARE_ENGINEER`, so filter every group's `roles` through `SENIOR_SELECTABLE_ROLES` before
  rendering. Never show `SOFTWARE_ENGINEER` in the picker.
- `uk` labels are long: up to about 40 characters (`Аналітик з кібербезпеки (SOC / IR / GRC)`).
  The `en` labels may be shorter or longer. Design for 40+ characters and never truncate a label
  inside the form.
- Display order is always the canonical order (`sortRoles`), never the order of clicking.

## 2. References (no screenshots for Tier 2)

- **There is no Claude Design project, no `design.html` and no `design.png` for this spec.** It is
  Tier 2, with Master's A1 decision not to run a Claude Design round. The structure mockups below are
  the reference.
- The Mode B fidelity audit therefore checks conformance to this text and to the existing patterns,
  not a pixel reference.
- Existing patterns this spec copies, read them before coding:
  - `apps/web/app/components/users/HrChipsField.tsx`: chips + a searchable "add" popover.
  - `apps/web/app/components/ui/tech-autocomplete-input.tsx`: the chip markup and the remove-button
    hit area (the `after:` pseudo-element, "R65").
  - `apps/web/app/components/users/user-dialog/TechStackSection.tsx`: the section, the
    submit-then-follow error, the `errorId` wiring.
  - `apps/web/app/components/job-queue/MatchedSeniors.tsx`: `HIT_CHIP`, `MatchEvidence` (the
    disclosure button pattern).
- **Coder:** build with our components per this spec. Do not paste markup from anywhere else.

## 3. Token map

Only tokens from `apps/web/app/styles/globals.css` (`@theme inline`) and the existing component
variants. No raw hex, no new token, no arbitrary colour.

| Use                               | Token / class                                                              | Source                        |
| --------------------------------- | -------------------------------------------------------------------------- | ----------------------------- |
| Role chip, form and display       | `Badge variant="outline"` = `border-border text-foreground`                | `ui/badge.tsx`                |
| Role chip text                    | `text-xs font-normal` (not `font-mono`: roles are words)                   | —                             |
| Chip remove icon, rest / hover    | `text-muted-foreground` → `hover:text-destructive hover:bg-destructive/20` | `tech-autocomplete-input.tsx` |
| Focus ring                        | `focus-visible:ring-2 focus-visible:ring-ring`                             | `--color-ring`                |
| Section frame                     | the existing `Section` (`border-border/60 bg-muted/20`)                    | `users/section.tsx`           |
| Error text and label              | `text-destructive` (via `Field`)                                           | `--color-destructive`         |
| Empty / hint text                 | `text-xs text-muted-foreground`                                            | `--color-muted-foreground`    |
| Popover surface                   | `PopoverContent` (`bg-popover text-popover-foreground`)                    | `ui/popover.tsx`              |
| Highlighted option                | `CommandItem` (`data-[selected=true]:bg-accent`)                           | `ui/command.tsx`              |
| Group heading in the list         | `CommandGroup heading` (`text-xs font-medium text-muted-foreground`)       | `ui/command.tsx`              |
| Overlap: matched skill chips      | `HIT_CHIP` (`border-yellow-muted/40 bg-yellow-subtle text-primary`)        | `MatchedSeniors.tsx`          |
| Overlap: count                    | `tabular-nums font-medium text-foreground`                                 | —                             |
| Overlap: label words, "no resume" | `text-xs text-muted-foreground`                                            | —                             |
| Radius                            | the component defaults (`rounded-md` on chips that can wrap)               | `--radius`                    |

`rounded-full` is not used on role chips: a 40-character label wraps to two lines at 320 px, and a
pill with two lines reads as a blob. `rounded-md` matches `HIT_CHIP`.

## 4. Component list

**Existing, reused as they are:**

- `Section` (`apps/web/app/components/users/section.tsx`), dialogs only. `Field` is **not** used by `RolesSection` (5.3)
- `Badge` (`ui/badge.tsx`)
- `Button` (`ui/button.tsx`)
- `Popover`, `PopoverTrigger`, `PopoverContent` (`ui/popover.tsx`)
- `Command`, `CommandInput`, `CommandList`, `CommandEmpty`, `CommandGroup`, `CommandItem`
  (`ui/command.tsx`)
- `Label` (`ui/label.tsx`), self-edit only, as today
- Icons from `lucide-react`: `Plus`, `X`, `ChevronDown`

**New (both are named in the plan):**

| Component      | File                                                         | Why no existing one fits                                                                                                              |
| -------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `RolesSection` | `apps/web/app/components/users/user-dialog/RolesSection.tsx` | `HrChipsField` is bound to users (avatar, email search); `TechAutocompleteInput` accepts free text. Roles are a closed, grouped list. |
| `RoleChips`    | `apps/web/app/components/users/RoleChips.tsx`                | The 3 display surfaces render the stack inline, each with its own markup. One component keeps one chip grammar.                       |

**Not new:** the overlap indicator is a small block inside `SeniorBlock` in `MatchedSeniors.tsx`.
It may be a local function in that file (like `MatchEvidence`); it needs no new export.

**No new primitive.** There is no checkbox primitive in `ui/`, and none is added: the popover +
`Command` pattern already runs inside `UserDialog`.

## 5. `RolesSection` (Task 5.1)

### 5.1 Decision: chips + a grouped, searchable "add" popover

The selected roles are removable chips. Below them, a "Додати роль" button opens a popover with a
search input and the unselected roles in their groups. This is `HrChipsField` with groups.

Rejected alternatives:

| Option                            | Why not                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 33 inline checkboxes in 11 groups | About 1,100 px tall at 320 px. It pushes the dialog's other sections and its submit far below the fold. |
| Collapsible groups (accordion)    | 11 headers to open one by one, no search, and a second disclosure state to manage and announce.         |
| Free-text autocomplete (stack UX) | Roles are a closed list. Free text invites values the API refuses.                                      |

Assumption (not measured): a senior has 1–3 roles. If so, the closed form (chips only) is what
people see most of the time, and the full list costs nothing until it is opened.

### 5.2 Structure

```
Професія                                         <- existing Section (dialogs only)
┌──────────────────────────────────────────────┐
│ Технічні ролі (обрано: 2) *                   │ <- Label (own id), required mark. The counter form
│                                               │    only while something is selected; on an empty
│                                               │    selection the label is the bare `Технічні ролі`
│ [+ Додати роль]                               │ <- ghost Button ABOVE the chips: the popover
│                                               │    anchor does not move while chips are added
│ ┌───────────────────────┐ ┌────────────────┐ │
│ │ Бекенд-розробник    ✕ │ │ DevOps / Plat- │ │ <- chips, canonical order, wrap
│ └───────────────────────┘ │ form-інженер ✕ │ │    (a long label wraps INSIDE the chip)
│                           └────────────────┘ │
│ Сеньйору потрібна щонайменше одна технічна... │ <- error (only when invalid)
└──────────────────────────────────────────────┘

Popover (opened):
┌──────────────────────────────┐
│ 🔍 Пошук ролі…               │ <- CommandInput
├──────────────────────────────┤
│ Розробка ПЗ                  │ <- CommandGroup heading
│   Фронтенд-розробник         │ <- CommandItem (selected roles are NOT listed)
│   Фулстек-розробник          │
│   …                          │
│ Мобільна розробка            │
│   iOS-розробник              │
│   …                          │ <- CommandList scrolls
└──────────────────────────────┘
```

Empty selection: the chip row shows `Нічого не обрано` (`text-xs italic text-muted-foreground`), the
same construction as `HrChipsField`'s "Нікого не обрано" — the label above it already names the
field, so the chip row only says that nothing is in it (CP-L-2, copy review round 1). The label
drops its counter in that state and reads the bare `Технічні ролі`.

### 5.3 What `RolesSection` owns, and what the caller owns

- `RolesSection` renders the label, the trigger, the chips, the popover and the error itself. It
  does **not** use `Field`, and it does not render a `Section`.
  - Why not `Field`: `Field` gives its `Label` no `id` (the `role="group"` needs an
    `aria-labelledby` target), its error is `role="alert"` or nothing (self-edit needs
    `role="status"`), and it takes no testid. Self-edit does not use `Field` today either.
  - Compose the same pieces with the same classes: a `div.grid.gap-1.5`, `Label` with
    `id={labelId}` and `cn(error && 'text-destructive')`, the required `*` in `text-destructive`,
    and the error `<p className="text-xs text-destructive">`. It then looks identical to its `Field`
    neighbours.
- **Order inside:** label, trigger, chips, error. The trigger sits **above** the chips, unlike
  `HrChipsField`: the popover stays open while the user adds roles (5.5), and at 320 px nearly every
  added chip is a new row. A trigger below the chips would move down, and the open list with it,
  after each pick (a layout shift under the pointer).
- **Dialogs** (`UserDialog`, `HrCreateSeniorDialog`) wrap it in the existing `Section title="Професія"`,
  in the place `TechStackSection` / the stack field holds today. The dialog's form subscription on
  `role` decides which of the two renders. The swap is instant, with no animation.
- **Self-edit** (`ProfileEditFields`) renders it where the "Технології" block is today, with no
  `Section` frame, matching its neighbours.
- Props stay as the plan states, plus one optional prop (open question Q1):
  `announce?: 'alert' | 'status'`, default `'alert'`. The dialogs use the default. Self-edit passes
  `'status'` (see 5.6).

### 5.4 The chip (form)

- `Badge variant="outline"` with `h-auto min-h-7 max-w-full items-center gap-1 rounded-md py-0.5
pl-2 pr-0.5 text-xs font-normal`.
- Label: a `span` with `min-w-0 leading-snug text-pretty [overflow-wrap:anywhere]`. It wraps; it is
  never truncated in the form.
- Remove: a native `<button type="button">`, `size-6 shrink-0` (24×24, SC 2.5.8 without a
  pseudo-element), `rounded-sm`, `X` icon `size-3.5` `aria-hidden`.
  - Classes: `text-muted-foreground transition-colors hover:bg-destructive/20 hover:text-destructive
focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`.
  - ``aria-label={t`Прибрати роль ${label}`}``.
- Do **not** copy `HrChipsField`'s remove button: it is `p-0.5` around a 14 px icon (about 18×18,
  under 24×24), and its ring is `ring-1 ring-primary/50`.
- Gap between chips: `gap-1.5`, as both existing chip fields.

### 5.5 The trigger and the popover

- Trigger: `Button variant="ghost" size="sm"` with `h-8 gap-1 text-xs`, a `Plus` icon (`aria-hidden`)
  and the text `Додати роль`. Height is 32 px, not `HrChipsField`'s 28 px: the trigger is the
  field's only control when the selection is empty.
  - `aria-invalid` and `aria-describedby={errorId}` while there is an error, because the trigger is
    the control a keyboard user lands on.
  - It is hidden when all 33 roles are selected, as `HrChipsField` hides its trigger.
- `PopoverContent`: `align="start"`, `p-0`, width `w-[min(20rem,calc(100vw-2rem))]`.
  `HrChipsField`'s fixed `w-72` (288 px) touches the edges of a 320 px viewport.
- `CommandInput` placeholder: `Пошук ролі…`.
- `CommandList`: `max-h-[min(20rem,50dvh)]`, so the list fits above the on-screen keyboard on a phone.
- One `CommandGroup` per group in `TECHNICAL_ROLE_GROUPS` order, with `heading` = the translated
  `TECHNICAL_ROLE_GROUP_LABELS` value. A group whose roles are all selected (or filtered out) is not
  rendered. `cmdk` already hides empty groups while filtering.
- One `CommandItem` per **unselected** senior-selectable role:
  - `value` = the translated label. `keywords={[translatedGroupLabel]}` (supported by the installed
    `cmdk@1.1.1`), so typing a group name ("Мобільна", "Безпека") lists that group.
  - Item text wraps: add `whitespace-normal leading-snug` to the item.
  - Selected roles are not listed. This avoids a "checked" state: `cmdk` puts `aria-selected` and
    `data-selected` on the **highlighted** row, so a check icon there would not be an announced
    state.
- `CommandEmpty`: reuse the existing `Нічого не знайдено` message.
- **Selecting an item:** it calls `onChange(sortRoles([...value, role]))` and the popover **stays
  open**, unlike `HrChipsField`, because a senior may have 2–3 roles. The search text stays.
  - **Requirement, not a library default:** the picked row unmounts, so `cmdk` may reset the
    highlight and the scroll to the top. After a pick, the list keeps its scroll position, the
    highlight lands on the row that took the picked row's place (else the previous row), and focus
    stays in `CommandInput`. Use `Command`'s controlled `value` / `onValueChange` to set the
    highlight. A unit test covers it.
- The popover closes on `Escape`, on an outside click and on Tab out. Focus returns to the trigger
  (Radix default). `Escape` closes only the popover, not the dialog: Radix layers it.

### 5.6 Error

- **Copy.** In the dialogs, the error is the `SENIOR_MIN_ROLES` message
  (`Сеньйору потрібна щонайменше одна технічна роль` / `A senior needs at least one technical role`),
  through the existing validation path (Task 5.3). In self-edit it is
  `Не збережено: сеньйору потрібна щонайменше одна технічна роль`, the same "Не збережено:" form as
  the stack error today.
- **Timing in the dialogs.** As in `TechStackSection`: it appears after the first submit attempt,
  then it follows every change until it is fixed.
- **Timing in self-edit.** It appears when the last chip is removed. That change is not autosaved. It
  disappears when a role is added; that change autosaves.
- **Render.** The label turns `text-destructive` (`Field` does this). The message sits under the
  trigger with an `id` (`useId`).
  - `announce="alert"`: the message has `role="alert"`, as `Field` does today with `errorId`. The
    user has just pressed submit.
  - `announce="status"`: `role="status"` (polite). The user is still editing, as in today's self-edit
    stack error.
- The error is text, never colour alone: the label colour is extra, the sentence carries it.

### 5.7 Keyboard and focus

| Key / action                     | Result                                                         |
| -------------------------------- | -------------------------------------------------------------- |
| Tab                              | the trigger, then each chip's remove button in canonical order |
| Enter / Space on the trigger     | opens the popover, focus goes to `CommandInput`                |
| Type                             | filters by label and group name                                |
| ArrowDown / ArrowUp, Home / End  | move the highlight (`cmdk`)                                    |
| Enter on a highlighted item      | adds the role, the popover stays open                          |
| Escape                           | closes the popover, focus back on the trigger                  |
| Enter / Space on a remove button | removes that role                                              |

**Focus after a remove** (the button the user pressed no longer exists). Move focus to:

1. the next chip's remove button, else
2. the previous chip's remove button, else
3. the trigger.

Without this, focus falls to `<body>` and the dialog's focus trap sends it to the top.

**Announcing add and remove.** The new chip appears outside the popover, where a screen-reader user
does not hear it. One visually hidden `role="status"` region inside `RolesSection` says
`Додано: {label}` after an add and `Прибрано: {label}` after a remove.

### 5.8 Disabled

`disabled` (for example while the dialog submits):

- The trigger is `disabled`.
- The remove buttons are `disabled`, with `disabled:pointer-events-none disabled:opacity-50`. They
  stay in place, so the layout does not jump.
- The chips keep full contrast: they are data the user is still reading.
- An open popover closes.

### 5.9 Self-edit specifics

- Shown only on a `SENIOR`'s own profile (plan). Other roles keep the stack field.
- Autosave goes through the same `scheduleSave` path as the stack, with `{ technicalRoles: next }`.
  Removing the last role cancels a pending roles save, the same drop pattern as
  `cancelPendingTechStackSave`.
- No extra "saved" indicator: the page's existing autosave feedback covers it.

## 6. `RoleChips` (Task 5.2)

### 6.1 Props

`RoleChips(props: { roles: readonly TechnicalRole[]; limit?: number })`. The plan states `{ roles }`
only. `limit` is added for the dense rows (open question Q2). Without `limit`, every role renders.

### 6.2 The chip (display)

- `Badge variant="outline"`, `max-w-full rounded-md px-1.5 py-0 text-xs font-normal leading-snug`,
  label with `[overflow-wrap:anywhere]`.
- **Not** `font-mono`: the stack chips are monospace because they are tokens (`Node.js`); roles are
  words.
- **Not** `text-[9px]` / `text-[10px]` as the stack chips on `UserRow` / `MembersCard` are. A
  40-character Ukrainian label at 9 px is unreadable. `text-xs` (12 px) is the floor for words.
- Labels wrap, never truncate. A truncated role is a different role ("Аналітик з кібербезпеки
  (SOC…" hides the part that matters).
- Order: canonical (`sortRoles`), as stored.
- Markup: `<ul className="flex flex-wrap gap-1">` with one `<li>` per chip, so a screen reader
  announces "list, 3 items".

### 6.3 Overflow ("+N")

When `roles.length > limit`, the first `limit` chips render, then a `+N` marker:

- Visible: `<span aria-hidden="true" className="self-center text-xs text-muted-foreground tabular-nums">+{N}</span>`.
- For screen readers: a `sr-only` span with the hidden labels joined by `, `. It needs no new
  string, and nothing is lost to a screen reader.
- The full list is on the profile Overview tab. `UserRow` and the member name in `MembersCard`
  already lead there. No hover, tooltip or popover is added to the marker: it is not interactive.

### 6.4 Per surface

| Surface       | Where                                                        | `limit` | For a SENIOR with no roles               |
| ------------- | ------------------------------------------------------------ | ------- | ---------------------------------------- |
| `UserRow`     | the slot of the stack row (`mt-1.5`)                         | 3       | nothing (the row stays one line shorter) |
| `MembersCard` | the slot of the stack row (`mt-1`)                           | 3       | nothing                                  |
| `OverviewTab` | the stack card, retitled `Технічні ролі`; same `CardContent` | none    | the card stays, with `не вказано` (Q3)   |

- `UserRow` today caps the stack at 5. Roles are about 4× longer, so 3 is the cap that keeps a row to
  at most two lines of chips at 1024+.
- `MembersCard` today shows the whole stack. The card is narrow, so the cap is 3.
- `OverviewTab` keeps its existing `permissions.fields.techStack` gate for the roles card: RBAC does
  not change in this plan, and the same viewers who see the stack see the roles.
- Never fall back to the stack for a `SENIOR`. For every other role, the surfaces stay exactly as
  today.

## 7. Skills-overlap indicator (Task 5.4)

### 7.1 Decision: the matched skills are visible, not in a tooltip

The plan asks for a tooltip that lists the matched skills, and requires that the tooltip is "not the
only carrier". This spec drops the tooltip and shows the matched skills inline, after the count
(open question Q4):

- A Radix `Tooltip` opens on hover and on keyboard focus, **not on tap**. At 320 px on a phone, the
  list would be unreachable.
- The card shows these skills visibly today ("Збіг за:"), and HR scans them. Moving them behind a
  hover is a loss of information.
- Visible text is the one carrier that works for pointer, touch, keyboard and screen reader at once,
  with no extra control and no extra string.

If the tooltip must stay, the fallback is a disclosure exactly like `MatchEvidence`: a `Button
variant="ghost"` with `aria-expanded`, `min-h-11`, that reveals the list below. Not a tooltip.

### 7.2 Structure (inside `SeniorBlock`)

The indicator takes the slot of the "Збіг за:" row: after the availability label and the
`matchApproximate` note, before `MatchEvidence`.

```
(ІП)  Name Surname
      Available from …
      5 з 7 навичок  [React] [Node.js] [PostgreSQL] [Docker] [AWS]   <- OVERLAP
      [Чому збіг ⌄]
```

```
      немає резюме                                                   <- NO_RESUME
```

### 7.3 Rendering by `senior.skillOverlap`

| Value                                                       | Renders                                                                                    |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `{ kind: 'OVERLAP', matched, total }`, `matched.length > 0` | the count label, then one `HIT_CHIP` per matched skill                                     |
| `{ kind: 'OVERLAP' }`, `matched.length === 0`               | the count label only (`0 з 7 навичок`). This is legal: a resume exists and covers nothing. |
| `{ kind: 'NO_RESUME' }`                                     | `немає резюме`. Never "0 з N".                                                             |
| `null`                                                      | nothing from the indicator                                                                 |

"Збіг за:" is never rendered when `skillOverlap` is present (plan, A1). Its existing condition
(`matchedKeywords.length > 0`) gains `skillOverlap === null`. After Task 4.5, `matchedKeywords` is
`[]` whenever `skillOverlap` is `null`, so the row is effectively gone. The coder may delete the
branch instead; either is fine.

### 7.4 Styling

- Row: `flex min-w-0 flex-wrap items-center gap-1 text-xs`, the same classes as the "Збіг за:" row.
- Count label: `font-medium text-foreground tabular-nums`. One Lingui message with an ICU plural on
  `total` (section 12). Do not split the message to style the numbers apart.
- Chips: `HIT_CHIP` with `max-w-full [overflow-wrap:anywhere]`, as today. Drop the `title`
  attribute: the text is fully visible.
- `NO_RESUME`: `text-xs text-muted-foreground`, no icon.
- **No colour scale.** The label is never green, red or amber by ratio. The indicator is display-only,
  and a colour scale would read as a ranking (plan anti-goal). The amber is on the chips only, where
  it already means "matched".
- The `matchApproximate` note stays wired and unchanged.

### 7.5 Many skills, many seniors

- No cap on the matched chips: they wrap. A vacancy rarely lists more than about 15 technologies,
  and a cap would need a disclosure to stay honest.
- Each `SeniorBlock` renders its own `skillOverlap`. Nothing is shared between seniors on one card.

## 8. Motion

No new motion. Every surface here is an edit to a dense form or list, and movement would only slow
the scan.

- **Section swap** (JUNIOR ↔ SENIOR in `UserDialog`): instant, no transition.
- **Popover:** the existing `PopoverContent` open/close animation, unchanged. `ui/popover.tsx` has
  no `motion-reduce:` handling today; that is a pre-existing gap of the shared primitive, out of
  scope for this PR (it is a short fade/zoom, not a large movement).
- **Chips appear and disappear instantly.** No enter/exit animation, no layout animation.
- **Remove buttons and the trigger:** `transition-colors` only, never `transition-all`.
- **Overlap indicator:** static.

## 9. Accessibility (WCAG 2.2 AA)

| SC                           | Where                   | Requirement                                                                                                                                                                                                              |
| ---------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1.3.1 Info and relationships | `RolesSection`          | The trigger and the chips sit in a `role="group"` with `aria-labelledby` = the label's `id`. Display chips are a `<ul>`.                                                                                                 |
| 1.4.1 Use of colour          | error, overlap          | The error is a sentence. The overlap has no colour scale.                                                                                                                                                                |
| 1.4.3 / 1.4.11 Contrast      | all                     | Only existing token pairs are used (`text-foreground` on `border-border`, `text-primary` on `bg-yellow-subtle`, `text-muted-foreground`). Mode B measures them on the live dark theme; this spec does not claim a ratio. |
| 1.4.10 Reflow                | all                     | No horizontal scroll at 320 px. Labels wrap (`[overflow-wrap:anywhere]`).                                                                                                                                                |
| 1.4.13 Content on hover      | overlap                 | No tooltip carries content (7.1).                                                                                                                                                                                        |
| 2.1.1 Keyboard               | `RolesSection`          | The full table in 5.7. Nothing needs a pointer.                                                                                                                                                                          |
| 2.4.3 Focus order            | `RolesSection`          | The trigger, then the chips' remove buttons. Focus after a remove follows 5.7.                                                                                                                                           |
| 2.4.11 Focus not obscured    | popover in a dialog     | The popover opens in a portal above the dialog. `CommandList` max height keeps the highlighted row on screen with the phone keyboard open.                                                                               |
| 2.4.7 Focus visible          | remove buttons, trigger | `focus-visible:ring-2 focus-visible:ring-ring`. Not `ring-1 ring-primary/50`.                                                                                                                                            |
| 2.5.8 Target size            | remove, trigger, items  | Remove 24×24 (`size-6`). Trigger 32 px tall. `CommandItem` at least 32 px tall. The "+N" marker is not a target.                                                                                                         |
| 3.3.1 Error identification   | `RolesSection`          | The trigger gets `aria-invalid` + `aria-describedby` → the error `id`. The error is `role="alert"` (dialogs) or `role="status"` (self-edit).                                                                             |
| 4.1.2 Name, role, value      | remove buttons          | `aria-label` = "Прибрати роль {label}". The icon is `aria-hidden`.                                                                                                                                                       |
| 4.1.3 Status messages        | add / remove            | One `sr-only` `role="status"` region announces "Додано: …" / "Прибрано: …".                                                                                                                                              |

## 10. Responsive (320 / 768 / 1024 / 1440)

| Width      | `RolesSection` (in a dialog / on the profile)                                                                                                                | `RoleChips`                                                              | Overlap indicator                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | --------------------------------------------------------- |
| 320        | Chips take the full field width and wrap; a 40-character label wraps inside its chip. The popover is `calc(100vw - 2rem)` wide; the list is at most `50dvh`. | Chips wrap; at most 3 + "+N" on rows. Long labels wrap to a second line. | The count, then the chips wrapping below it. No overflow. |
| 768        | As 320, the popover reaches its 20rem width.                                                                                                                 | Usually one line of chips.                                               | One or two lines.                                         |
| 1024, 1440 | No change: the dialog has a fixed max width, so nothing grows.                                                                                               | One line in most rows.                                                   | One line in most cards.                                   |

Manual QA checks all four widths for the 3 forms and the card (plan "PR 5 done when").

## 11. Edge cases

| Case                                        | Behaviour                                                                                                 |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| No roles selected (form)                    | `Нічого не обрано`, the label without its counter, the trigger, and the error once it applies (5.6).      |
| All 33 selected                             | The trigger is hidden. Each chip stays removable.                                                         |
| Search finds nothing                        | `Нічого не знайдено` (`CommandEmpty`).                                                                    |
| Long label (40+ characters)                 | It wraps inside the chip and inside the popover item. It is never truncated.                              |
| Role switch JUNIOR ↔ SENIOR in `UserDialog` | The sections swap instantly. A role picked and then switched away from is not sent (plan, `payloads.ts`). |
| Legacy SENIOR with no roles, display        | `UserRow`, `MembersCard`: nothing. `OverviewTab`: the card with `не вказано` (Q3). Never the old stack.   |
| Many roles on a row                         | 3 chips + "+N", with the rest in a `sr-only` span.                                                        |
| Loading                                     | No new loading state. The role list is static data. The display surfaces keep their current loading.      |
| Save error (self-edit)                      | The existing autosave error path. Nothing new.                                                            |
| Server refuses (dialogs)                    | `SENIOR_MIN_ROLES` from the API maps to the same message through the existing api-error path.             |
| `OVERLAP` with 0 matched                    | `0 з N навичок`, no chips.                                                                                |
| `OVERLAP` with many matched                 | All the chips, wrapping.                                                                                  |
| `NO_RESUME`                                 | `немає резюме`. Never "0 з N".                                                                            |
| Vacancy with no technologies (`null`)       | Nothing.                                                                                                  |

## 12. Copy table (for copy-reviewer)

`uk` is the source (Lingui macros); `en` goes into the catalog. copy-reviewer gives the `uk` and `en`
verdicts separately. The uk plural forms are copy-reviewer's to settle.

**New strings:**

| Where                       | `uk` (source)                                                               | `en`                                                           |
| --------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Field label, Overview title | `Технічні ролі`                                                             | `Technical roles`                                              |
| Field label with count      | `Технічні ролі (обрано: {count})`, only when `{count}` > 0                  | `Technical roles ({count} selected)`                           |
| Trigger                     | `Додати роль`                                                               | `Add role`                                                     |
| Search placeholder          | `Пошук ролі…`                                                               | `Search roles…`                                                |
| Empty selection             | `Нічого не обрано`                                                          | `None selected`                                                |
| Remove button `aria-label`  | `Прибрати роль {label}`                                                     | `Remove role {label}`                                          |
| Live region, add            | `Додано: {label}`                                                           | `Added: {label}`                                               |
| Live region, remove         | `Прибрано: {label}`                                                         | `Removed: {label}`                                             |
| Self-edit error             | `Не збережено: сеньйору потрібна щонайменше одна технічна роль`             | `Not saved: a senior needs at least one technical role`        |
| Overlap count               | `{matched} з {total} навичок`, ICU plural on `total` (forms: copy-reviewer) | `{matched} of {total, plural, one {# skill} other {# skills}}` |
| No resume                   | `немає резюме`                                                              | `no resume`                                                    |

**Reused, unchanged:** `Професія`, `Нічого не знайдено`, `не вказано`, the `SENIOR_MIN_ROLES`
api-error and zod-error messages, the role labels and group labels in `technical-roles.ts`.

**Why "Технічні ролі" and not "Ролі":** `UserDialog` already has the access role select ("Роль":
ADMIN, SENIOR, …). "Ролі" next to it reads as the same thing.

## 13. `data-testid` map (for Task 5.5)

| Element                   | `data-testid`                            |
| ------------------------- | ---------------------------------------- |
| `RolesSection` root group | `roles-section`                          |
| Form chip                 | `roles-section-chip-${role}`             |
| Chip remove button        | `roles-section-remove-${role}`           |
| Add trigger               | `roles-section-add-trigger`              |
| Popover option            | `roles-section-option-${role}`           |
| Error message             | `roles-section-error`                    |
| `RoleChips` root `ul`     | `role-chips`                             |
| Display chip              | `role-chip-${role}`                      |
| "+N" marker               | `role-chips-more`                        |
| Overlap row (`OVERLAP`)   | `job-queue-senior-overlap-${seniorId}`   |
| No-resume label           | `job-queue-senior-no-resume-${seniorId}` |

`${role}` is the stable role id (`BACKEND_ENGINEER`), never the translated label.

## 14. Open questions

Each has a recommended answer. None blocks the coder: each recommendation is a reversible A1 choice
inside one PR.

- **Q1. Error politeness in one component.** The plan's props carry only `error?: string`. The
  dialogs need `role="alert"` (after submit). Self-edit needs `role="status"` (while editing).
  **Recommendation:** add `announce?: 'alert' | 'status'`, default `'alert'`.
- **Q2. A cap on display chips.** The plan's `RoleChips` props are `{ roles }` only.
  **Recommendation:** add `limit?: number`; `UserRow` and `MembersCard` pass 3, `OverviewTab` passes
  none.
- **Q3. Legacy SENIOR with no roles on `OverviewTab`.** The plan says "shows nothing". Today's stack
  card shows `не вказано` when empty. **Recommendation:** keep the card with `не вказано`. It tells an
  ADMIN that the senior's roles need filling, and it is the page's empty-state convention. "Nothing"
  then applies to the dense rows only, and the stale stack is never shown anywhere.
- **Q4. Tooltip for the matched skills.** The plan asks for a tooltip that is not the only carrier.
  **Recommendation:** no tooltip. Show the matched skills inline after the count (7.1). A tooltip does
  not open on tap at 320 px, and the skills are visible on the card today. If the tooltip must stay,
  use a `MatchEvidence`-style disclosure button, not a tooltip.
- **Q5. Field label.** **Recommendation:** `Технічні ролі` / `Technical roles`, not `Ролі`, so it is
  not read as the access role select in the same dialog. copy-reviewer has the final word on wording.
- **Q6. Trigger above the chips.** This differs from `HrChipsField`, which puts its trigger below.
  **Recommendation:** keep it above (5.3). The popover stays open while roles are added, and a
  trigger below a growing chip row moves the open list under the pointer.
