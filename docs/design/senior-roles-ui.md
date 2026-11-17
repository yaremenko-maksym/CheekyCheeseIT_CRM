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

_pending_

## 6. `RoleChips` (Task 5.2)

_pending_

## 7. Skills-overlap indicator (Task 5.4)

_pending_

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
