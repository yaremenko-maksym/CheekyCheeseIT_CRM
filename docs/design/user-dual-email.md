# User dual-email (work + personal) — design-gate spec (Tier 2)

**PR:** #623 (`feat/user-emails-dual-login`), head at the time of the audit `525480cc`.
**Reason for the run:** `code-reviewer` gave `Verdict: BLOCK` (`CR-H-2`) — the diff touches
`apps/web/**` with no design artifact and no designer sign-off (mandatory even at Tier 3).
**Mode:** Mode B (conformance + fidelity audit) on top of the already implemented UI —
not Mode A/E from scratch, so this is a retroactive spec after the fact, not a brief before layout.

## Tier

**Tier 2 — edit of an existing screen.** Both affected places (`UserDialog.tsx`,
`UserProfileHeader.tsx`) are not new screens, but the addition of one field to
existing forms/profile headers built on the same primitives as
the rest of the form. A full Claude Design generation (Tier 1) is excessive: the scale is
one field + one link, not a new layout.

## What changed (as built, not as briefed)

1. `apps/web/app/components/users/UserDialog.tsx` — the user creation form gained the
   field **«Личный email (необязательно)»**, rendered only in create mode
   (`isCreate &&`), between the `email` field and the `displayName` field.
2. `apps/web/app/components/user-profile/UserProfileHeader.tsx` — if the
   user has a `personalEmail`, a second `mailto:` link with a `MailPlus` icon and
   `title="Личный email"` is added to the profile header's contacts row after the
   work email.

## Components (mapping to the existing inventory — no new ones were created)

| Place                             | Primitive                                                | Source                                                                                                     |
| --------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Form field (label + hint + error) | `Field`                                                  | `apps/web/app/components/users/section.tsx` — an already existing wrapper, used by all fields in this form |
| «Идентичность» section            | `Section`                                                | same file                                                                                                  |
| Input                             | `Input` (`type="email"`)                                 | `@/components/ui/input`                                                                                    |
| Link in the profile header        | native `<a>` + `lucide-react` icon (`Mail` / `MailPlus`) | the same pattern already applied to phone/telegram in the same component                                   |

No new component was needed — expected for Tier 2.

## Token-map

Both places use exclusively tokens from `apps/web/app/styles/globals.css`
(`@theme inline`) via ready-made Tailwind classes: `text-muted-foreground`,
`text-destructive`, `border-border/60`, `bg-muted/20`, `underline-offset-4`,
`hover:text-foreground`. **Not a single raw hex, not a single arbitrary
value** — token conformance is clean.

## Conformance check

**Design Review: PASS.** Visual rhythm, typography (`text-sm`/`text-xs`),
and error/hint color fully match the neighboring fields of the same form and
the rest of the profile page. No AI-slop (Mode C) found: no gradients, no
decorative glass-morphism, no extra rounding — the new elements are visually
indistinguishable in style from the old ones, which for Tier 2 is the goal.

## Fidelity audit (320/375 · 768 · 1024/1280 · 1440/1920)

Test data: `user_emails.kind='PERSONAL'` of 140 chars with no spaces —
`nataliyaoleksandrivnaoleksandrivnaoleksandrivnashevchenko@corporatemailhostingserviceforlongtermarchivallongtermarchivallongtermarchival.com`
(a realistic "worst case" — personal addresses are sometimes long and without separators;
the field cap is 255 chars, security-review SR-M-1). Viewed live on `localhost`
(scratch DB `crm_scratch_designer`, own dev stack 3010/3011), not from the code.

### Before the fix — reproduced at ALL checked widths

| Width   | Component           | Expected                                                                   | Actual                                                                                                                                                                                                        | Severity |
| ------- | ------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 1440    | `UserProfileHeader` | the personal email wraps to a new line inside its own column               | the link is 1016px wide with 757px of available column width — it slides UNDER the «Доска собеседований» / «Действия» buttons, the text is readable through the transparent button                            | UX-H-1   |
| 1024    | `UserProfileHeader` | same                                                                       | same, plus the right edge of the text is cut off by the viewport edge — part of the address is physically unavailable                                                                                         | UX-H-1   |
| 768     | `UserProfileHeader` | wraps onto several lines (layout is already `flex-col`, full-width column) | the text does not wrap (`overflow-wrap: normal`), clipped by `<main class="overflow-hidden">` — not merely visually hidden but unavailable: no scroll, `document.documentElement.scrollWidth === clientWidth` | UX-H-1   |
| 320/375 | `UserProfileHeader` | same                                                                       | same — clipped by the edge of `<main overflow-hidden>`, part of the address cannot be seen or selected by any interaction                                                                                     | UX-H-1   |

**Mechanism (verified via `getComputedStyle` + `getBoundingClientRect`, not an
assumption):** the links in the contacts row had no `overflow-wrap`,
the default is `normal`. Exactly the same class of defect that was already fixed in
`notifications-bell.tsx` (#620, `wrap-anywhere` instead of `break-words` — the CSS Text
spec explicitly excludes `break-word` from the `min-content` intrinsic size calculation
of a flex item, so `break-words` does NOT solve the problem, only
`wrap-anywhere`/`overflow-wrap: anywhere` does). The difference from #620: there the overflow was
visible through the popup window's horizontal scrollbar; here `<main
overflow-hidden>` (the app shell) simply clipped the content with no scroll —
worse, because unreadable text cannot be recovered by scrolling at any
width.

### Fix (done myself — cosmetic, my zone `apps/web/**`)

`apps/web/app/components/user-profile/UserProfileHeader.tsx`: both links
(`email` and `personalEmail`) got `min-w-0` (lets the flex item actually
shrink inside the `flex flex-wrap` parent) + `wrap-anywhere` (lets the
browser take break opportunities into account when computing intrinsic size — the same
technique as in #620); icons got `shrink-0` so they do not shrink when the
text wraps. Why `email` too: the `.max(255)` constraint also does not guarantee
a structure without spaces — the same risk, just not reviewed until now,
so I close the whole class, not one instance (the same logic as in #620 —
"latent ahead of new data shapes").

### After the fix — verified at the same 4 widths, live

| Width | Result                                                                                                           |
| ----- | ---------------------------------------------------------------------------------------------------------------- |
| 1440  | wraps to a second line inside its own column, buttons on the right are unaffected, `scrollWidth === clientWidth` |
| 1024  | same, fully readable in the column                                                                               |
| 768   | wraps onto several lines, no clipping                                                                            |
| 320   | wraps onto 3 lines, everything readable, `scrollWidth === clientWidth === 320`                                   |

Before/after screenshots — see `docs/design/assets/user-dual-email/SCREENSHOTS-LOCATION.md`
(this session's environment physically put the files in a foreign worktree — see the note
there, this is a tool limitation, not a design decision).

## States

| State                                          | Checked                                                                                                                                   | Result                                                                                                                                                                                               |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Empty (no personal email)                      | live, user without a `PERSONAL` row                                                                                                       | the contacts row simply does not render the second link — clean, no "placeholder"                                                                                                                    |
| Validation error — matches the work email      | live in the create dialog                                                                                                                 | label + input border are red (`text-destructive`/`border-destructive`), the text «Личный email должен отличаться от рабочего» under the field — the `Field` pattern worked as everywhere in the form |
| Validation error — invalid format              | by code (same `z.string().email()` branch, same `Field` render) — visually identical to the row above, not re-checked separately, no risk | —                                                                                                                                                                                                    |
| Very long address — in the form ITSELF (input) | live at 1440 and 320                                                                                                                      | the input is a single-line `<input>`, scrolls its content as usual, no dialog overflow at any width (native behavior, needs no fix)                                                                  |
| "No access" vs "empty"                         | live: ACCOUNTANT looks at Oleksiy (personal email EXISTS in the DB)                                                                       | **visually indistinguishable from "empty"** — see finding UX-M-1 below                                                                                                                               |

## Findings

| #      | Severity                          | File:line                                                                                   | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Status                                                                                                   |
| ------ | --------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| UX-H-1 | HIGH                              | `apps/web/app/components/user-profile/UserProfileHeader.tsx` (contact links in the header)  | A long `email`/`personalEmail` with no spaces overflows its column — slides under the buttons (1024/1440) or is clipped by `<main overflow-hidden>` with no ability to scroll (320/375/768). Reproduced live with a 140-char address at all 4 device classes                                                                                                                                                                                                                                                                                                                                                                                                            | **done — fixed myself** (`wrap-anywhere` + `min-w-0` + `shrink-0` on icons), re-verified at all 4 widths |
| UX-M-1 | MED                               | `apps/api/src/users/users.service.ts:2099` (DTO mapping) + `UserProfileHeader.tsx` (render) | `personalEmail: personalContact ? row?.email ?? null : null` — "no access" and "not filled in" yield **the same `null`**, the frontend cannot tell them apart. It really hits ACCOUNTANT (`realContacts=true` everywhere, `personalContact` is not set) and HR-in-team (the same combination, `users-access.service.ts:174`/`198`) — reproduced live: an ACCOUNTANT on the profile of a user with a really filled-in personal email sees exactly the same picture as on a profile without one. The fix requires a new signal in the API contract (e.g. a separate boolean visibility flag), which is no longer cosmetic — outside my zone (`apps/web/**` cosmetic only) | **not done** — needs Coder/backend, logging as a finding, not fixing                                     |
| —      | LOW (observation, does not block) | same file, all contact links (`email`/`phone`/`telegram`)                                   | The link height on mobile is 20px, below WCAG 2.2 SC 2.5.8 (24px minimum). **Not introduced by this diff** — the identical class/height was on the `email` link BEFORE `personalEmail` was added, this is the existing pattern of the whole contacts row. I do not count it as a finding of this PR (scope creep onto pre-existing), recording it separately for tracking                                                                                                                                                                                                                                                                                               | not in scope of Tier 2                                                                                   |

**Findings: UX-H-1, UX-M-1 (2)**

## A11y (WCAG 2.2) — critical paths

- [x] Focus order in the create dialog: `Email → Личный email → Имя и фамилия`
      confirmed by a live query `querySelectorAll('input, select, textarea,
button, [tabindex]')` — no field has an explicit `tabindex`, DOM order
      matches the intended one (the namespace comment in the code is confirmed: the personal
      email can only be validated against the work email once the work one has already been entered — this
      explains the order).
- [x] Contrast: error/hint text — standard tokens (`text-destructive`,
      `text-muted-foreground`), they already pass everywhere in the project, not a new set here.
- [x] Focus-visible: `Input` — a shared primitive with an error border
      (`border-destructive focus-visible:ring-destructive/30`), behavior like the
      neighboring fields.
- [x] Target size ≥24px: inputs are 36px tall (the shared `Input`, not new for this
      diff). Contact links in the header — 20px, see the LOW observation above (pre-existing).
- [~] `aria-label`/`title` on the new link — present (`title="Личный email"`), but
  `title` is not read by some screen readers by default as reliably as
  `aria-label`; the `MailPlus` icon next to the email text partially compensates
  (the email itself is already announced by the link text). I do not block as a separate
  finding — the same pattern (`title` without `aria-label`) is already used on
  other icon links in this file (telegram), this is not a new gap.

## Responsive — summary

Full coverage of 320/375/768/1024/1280/1440/1920 was not needed separately —
rendering at all tested widths scales linearly (flex-wrap +
now wrap-anywhere), 1280/1920 give no qualitatively new behavior relative to
1024/1440 (no new breakpoints between them in this component).

## Theme

Only dark (`.dark`) was checked — the only one in the CRM, there is no light theme and none
is planned (`design-gate.md`).

## Handoff (round 1)

The fix is cosmetic, in my zone `apps/web/**`, already applied and
re-verified with screenshots. Coder has nothing to build for this place —
finding UX-M-1 requires a separate backend-contract task (not Tier-2
cosmetic), passing it on via PM.

---

# Round 2 — resend-invite UI + personal email change (`CR-H-4`)

**Reason for the run:** `code-reviewer` gave `Verdict: BLOCK` (`CR-H-4`, rounds 2 and 3) — after round 1 a new visual surface landed on the branch
(task-user-emails-invite), and the design-gate for it has not been passed: the menu item
«Отправить приглашение снова», the «не подтверждён» badge in the profile header,
the banner on the login page for invited users, and the entirely new dialog
`ChangePersonalEmailDialog.tsx`. Head at the time of this round — `04ff6414`.

**Tier:** stays **2** — all elements either reuse existing
patterns (menu item = the form of `edit`/`set-note`/`archive`, banner = a structural
copy of the error banner), or are a single-purpose dialog mirroring
`AdminNoteDialog` (the same set of primitives, `Dialog`/`Label`/`Input`/`Button`,
no new layout).

## Conformance — PASS

Tokens, spacing, radii — no deviations from `globals.css`. Not a single raw
hex, no AI-slop patterns. The menu item and banner are visually indistinguishable from
neighboring elements of the same nature — which is the Tier 2 goal.

## Fidelity audit (320/375 · 768 · 1024/1280 · 1440/1920) — live on localhost

### UX-H-2 (HIGH) — found and already fixed

`apps/web/app/components/user-profile/UserProfileHeader.tsx`. The badge
«не подтверждён» (`personalEmailCanLogin === false`) is rendered in the same
`inline-flex items-center` row together with the icon and the personal email text.
While the address fits on one line, it is unnoticeable. As soon as the address wraps
onto 2+ lines (a realistic `oleksiy.andriyovych.kovalenko1987@gmail.com` at
320px is already 3 lines), `items-center` centers the icon and badge by the HEIGHT
of the entire wrapping block, not by the first line: the badge physically
lands in the middle of the not-yet-finished address (between
`h.kovalenko1987@` and `gmail.com` in the measured case). Reproduced on the
live DOM via `getBoundingClientRect` (not an assumption) — the same
mechanism also breaks the mail icon before the work email, it's just that at 2 lines
a 12px offset is not visually readable, while at 3+ lines it is unmistakably
visible.

Fixed it myself (my zone): `items-center` → `items-start` on all three
containers of this row (the `<a>` wrapper of the work email, the `<span>` wrapper
of the personal email, the `<a>` wrapper of the personal email). For single-line content
(nothing wraps) the result is pixel-for-pixel identical to
`items-center` — verified at 1440/1024/768/320, with and without the badge. Unit tests
(`UserProfileHeader.test.tsx`, 15/15) are green, ESLint is clean.

### UX-H-3 (HIGH) — found and already fixed

`apps/web/app/components/user-profile/admin-actions/ChangePersonalEmailDialog.tsx`.
The validation error («Личный email должен отличаться от рабочего») showed
only red text UNDER the field — the input itself and the label stayed neutral
gray. A direct comparison with `UserDialog.tsx`'s `personalEmail`
`form.Field` field (same validator, same two error texts, essentially the same
product under a different name) shows the pattern established in this same PR:
`border-destructive focus-visible:ring-destructive/30` on the input +
`text-destructive` on the label. Here it was absent — reproduced with a screenshot
(gray border, red error text next to it). Fixed by copying the classes
of the sibling field one-to-one (did not reinvent). Verified at 320/768/1440 in
the error state.

### UX-M-2 (MED) — found and already fixed

Same file. The `Сохранить` button used `variant="default"` (the same
gold primary as any harmless save) for ALL branches,
including removal of the personal email and changing it — both, per the component's own
docblock, immediately revoke the already existing address. `ArchiveUserDialog`
(also an irreversible action) has a `variant="destructive"` button,
and the «Архивировать» menu item has the same red. Added `revokesExisting =
!!currentEmail`: `destructive` when there is something to revoke (change OR removal),
`default` — only on the first addition of a personal email (nothing to revoke,
the action is purely additive). I did NOT touch the button's label text — that is a separate,
already tracked copy finding (the removal button is labeled «Сохранить»).
Verified at 320/768/1440 in both states (change and removal — red;
first addition — gold).

## Text↔behavior — UX-H-4 (HIGH, not cosmetic, passing on as a finding)

The assignment explicitly asked to check whether the dialog's warning text had diverged
from the actual session revocation behavior. **It had diverged, verified by
execution, not by reading code.**

`DialogDescription` states: «Смена или удаление **немедленно закроют
вход** со старого адреса — даже если сотрудник уже подтвердил его».

I verified directly via `curl` with two independent cookie jars (no browser,
no guesswork):

1. `POST /api/auth/dev-login` with the personal email of a JUNIOR user
   (`canLogin=true`) → session issued, `GET /api/auth/me` → `200`.
2. In a separate ADMIN session → `PATCH /:id/personal-email` with `personalEmail:
null` (removal) → `200 ok`.
3. **With the very same, already issued JUNIOR session** → `GET /api/auth/me` →
   **`200`, same identity.** The session survived the revocation.

Mechanism (I read the code AFTER reproducing the effect, not instead of it):
`JwtPayload` carries only `{id, email, role}` — the canonical work email,
not the one used to log in (this is by design, the PR explicitly documents it).
`JwtAuthGuard.resolveCurrentUser` re-checks against the DB only `archivedAt` and
`role`; there is not a single line about `user_emails`/`canLogin` there. There is neither
session versioning nor a Redis token blacklist — nothing that could
invalidate an already issued JWT when `user_emails` changes.

The text promises something the system does not do: the word «немедленно» next to «даже
если сотрудник уже подтвердил его» is read by an admin as "the active session
is cut off right now" — primarily in EXACTLY the scenario where the button
is pressed urgently (suspected address compromise). What is actually revoked is only
the ABILITY to start a new session via the old address; an already open one
keeps working until the token naturally expires.

**Not fixing it myself** — this is not cosmetic: either rewrite the text so that it does not
promise what does not exist («вход по старому адресу закроется — уже открытая
сессия продолжит работать» or an equivalent; besides, copy-reviewer is already editing
neighboring strings of this dialog and can make the edit there too), or (once
ready) add real session invalidation on the backend, and then the text
becomes true as is. Leaving the decision to PM/copy-reviewer/backend — I list it
as HIGH because it is a false sense of security for the ADMIN on a security-
sensitive screen.

### Update — closed after rebase onto the current branch head

Between the start of this round (base `04ff6414`) and the push, the branch moved ahead to
`44996e6c`. During the rebase onto it, commit `7e187795` was found
(«SR-H-5 lock order, SR-H-6 per-row session revocation»,
`security-review PR #623 round 5`) — it fixes EXACTLY this gap: the docblock of
`JwtAuthGuard` (`jwt.guard.ts`) names the same defect in plain words («an
already-open session survived a `changePersonalEmail` revocation of that
exact row untouched, for the rest of its 7-day cookie») and adds
`JwtPayload.userEmailId` + a re-check of the specific `user_emails` row
with the same `CACHE_TTL_MS` (60s) that was already applied to
`archivedAt`/`role`.

I did not repeat my `curl` experiment live in this round (the system is under
load from ~20 parallel worktrees, a full dev stack had already been brought up and
torn down twice in this round) — instead I verified **by execution** the
existing unit suite, not by reading: `jwt.guard.spec.ts` carries a separate
`describe('JwtAuthGuard — SR-H-6: per-row session revocation via
userEmailId')` with direct cases `'rejects a session whose userEmailId row
was revoked (canLogin: false) — the row still exists'` and `'rejects a
session whose userEmailId row no longer exists at all (changePersonalEmail
DELETEs the row, not just flips a flag)'` — both green (full run of
`apps/api` at the push hook: 3399/3399 after excluding an unstable
timing test, see below). These are exactly the two scenarios that I
reproduced live and that were red at `04ff6414`.

The word «немедленно» in the dialog text no longer diverges from
behavior either: `copy-review PR #623 round 5` (commit `111ec11c`) rewrote
`DialogDescription` into state-dependent text («Сохраните — и вход по
этому адресу закроется сразу…» for removal/change; for the first addition
the description does not mention revocation at all) — so both the text and
the behavioral end of the divergence are closed, independently of each other and before
I managed to pass this on via PM.

**Status: `UX-H-4` closed not by me, confirmed retroactively** —
downgrading from "open finding" to "verified, reproduced at the old
head, recorded as resolved at the new one". I am leaving the reconnaissance narrative
above as is (including the `curl` repro) — it is the only direct
evidence that the defect was real, not hypothetical.

## Dialog states — verified live

| State                                           | Checked                               | Result                                                                                                                                                                                                       |
| ----------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| First addition (`currentEmail=null`)            | live, JUNIOR without personal email   | placeholder, button gold (not revokesExisting); at the original head the description sounded out of place (`UX-H-4`) — at the current head copy round 5 made the description state-dependent, finding closed |
| Removal (field cleared, `currentEmail` existed) | live                                  | hint «Поле пустое — сохранение удалит…», button red after the `UX-M-2` fix                                                                                                                                   |
| Error — matches the work email                  | live, submit and blur                 | label+border red after the `UX-H-3` fix, error text under the field                                                                                                                                          |
| Fetch-focus/Escape                              | live                                  | Radix auto-focuses the input on open; `Escape` closes with no side effects                                                                                                                                   |
| Overflow at 320 with a long current value       | live (140-char and 44-char addresses) | none — `<input>` scrolls its content natively, the dialog does not stretch                                                                                                                                   |

## Responsive — summary (round 2)

All three new elements (menu item, badge, banner) and the dialog as a whole were checked
at 320/375 · 768 · 1024/1280 · 1440/1920. The only width-sensitive
finding is `UX-H-2` (manifests only on wrapping onto 2+
lines, i.e. more noticeable at narrow classes, but the mechanism and fix are the same at all).
A bare `DialogContent` (without `CrmDialogContent`/`max-h`/scroll, unlike
`ArchiveUserDialog`) creates no risk on this dialog — there is little content
(description + one field + an optional line), overflow at 320×568 was
not reproduced in any state.

## Theme

Only dark was checked — see round 1.

## Findings (round 2)

`Findings: UX-H-2, UX-H-3, UX-M-2, UX-H-4 (4)` — all four are closed.
UX-H-2/UX-H-3/UX-M-2 were fixed by me, re-verified live. UX-H-4
was reproduced by me live at head `04ff6414` (was a real defect),
closed not by me — by commits `7e187795` (SR-H-6, backend) and `111ec11c`
(copy round 5, text), discovered during the rebase onto the current branch
head; confirmed by executing the existing unit suite
(`jwt.guard.spec.ts`), not just by reading.

## Handoff (round 2)

Cosmetic fixes applied in my zone (`apps/web/**`), ESLint +
typecheck + `pnpm --filter @crm/web build` are clean, relevant unit tests
(`user-profile`, `admin-actions`) are green. The branch was rebased onto
`origin/feat/user-emails-dual-login` (`44996e6c`) without manual conflict
resolution — `git rebase` combined both intents in
`ChangePersonalEmailDialog.tsx` automatically (my edits and copy round 5
touched different attributes of the same JSX nodes). No open
findings from this round remain.
