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

- `Section`, `Field` (`apps/web/app/components/users/section.tsx`)
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

A senior has 1–3 roles in practice. So the closed form (chips only) is what people see most of the
time, and the full list costs nothing until it is opened.

### 5.2 Structure

```
Професія                                         <- existing Section (dialogs only)
┌──────────────────────────────────────────────┐
│ Ролі (обрано: 2) *                            │ <- Field label, required mark
│ ┌───────────────────────┐ ┌────────────────┐ │
│ │ Бекенд-розробник    ✕ │ │ DevOps / Plat- │ │ <- chips, canonical order, wrap
│ └───────────────────────┘ │ form-інженер ✕ │ │    (a long label wraps INSIDE the chip)
│                           └────────────────┘ │
│ [+ Додати роль]                               │ <- ghost Button, opens the popover
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

Empty selection: the chip row shows `Ролі не обрано` (`text-xs italic text-muted-foreground`), as
`HrChipsField` shows "Нікого не обрано".

### 5.3 What `RolesSection` owns, and what the caller owns

- `RolesSection` renders the `Field`: the label, the chips, the trigger, the popover and the error.
  It does **not** render a `Section`.
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
  - `aria-label={t`Прибрати роль ${label}`}`.
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
  - `value` = the translated label. `keywords={[translatedGroupLabel]}`, so typing a group name
    ("Мобільна", "Безпека") lists that group.
  - Item text wraps: add `whitespace-normal leading-snug` to the item.
  - Selected roles are not listed. This avoids a "checked" state: `cmdk` puts `aria-selected` and
    `data-selected` on the **highlighted** row, so a check icon there would not be an announced
    state.
- `CommandEmpty`: reuse the existing `Нічого не знайдено` message.
- **Selecting an item:** it calls `onChange(sortRoles([...value, role]))` and the popover **stays
  open**, unlike `HrChipsField`, because a senior often has 2–3 roles. The search text stays, and the
  highlight moves to the next item (`cmdk` default).
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

| Key / action                     | Result                                                          |
| -------------------------------- | --------------------------------------------------------------- |
| Tab                              | each chip's remove button, in canonical order, then the trigger |
| Enter / Space on the trigger     | opens the popover, focus goes to `CommandInput`                 |
| Type                             | filters by label and group name                                 |
| ArrowDown / ArrowUp, Home / End  | move the highlight (`cmdk`)                                     |
| Enter on a highlighted item      | adds the role, the popover stays open                           |
| Escape                           | closes the popover, focus back on the trigger                   |
| Enter / Space on a remove button | removes that role                                               |

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

| Surface       | Where                                               | `limit` | For a SENIOR with no roles               |
| ------------- | --------------------------------------------------- | ------- | ---------------------------------------- |
| `UserRow`     | the slot of the stack row (`mt-1.5`)                | 3       | nothing (the row stays one line shorter) |
| `MembersCard` | the slot of the stack row (`mt-1`)                  | 3       | nothing                                  |
| `OverviewTab` | the stack card, retitled `Ролі`; same `CardContent` | none    | the card stays, with `не вказано` (Q3)   |

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

"Збіг за:" renders **only** when `skillOverlap === null` and `matchedKeywords.length > 0`. That keeps
today's behaviour for any card the new field does not cover. When `skillOverlap` is present, the
"Збіг за:" row is never rendered.

### 7.4 Styling

- Row: `flex min-w-0 flex-wrap items-center gap-1 text-xs`, the same classes as the "Збіг за:" row.
- Count label: `font-medium text-foreground tabular-nums`. One Lingui message with an ICU plural on
  `total` (section 11). Do not split the message to style the numbers apart.
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

## 8. Accessibility (WCAG 2.2 AA)

_pending_

## 9. Responsive (320 / 768 / 1024 / 1440)

_pending_

## 10. Edge cases

_pending_

## 11. Copy table (for copy-reviewer)

_pending_

## 12. `data-testid` map (for Task 5.5)

_pending_

## 13. Open questions

_pending_
