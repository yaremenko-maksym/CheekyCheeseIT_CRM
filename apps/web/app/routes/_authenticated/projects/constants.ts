import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import type { ProjectPaymentType } from '@crm/shared'

/**
 * task-drop-share-override-and-receiver (Surface C). Single label source for
 * the "Тип оплаты" Select in both the create and edit project forms AND the
 * read-only InfoRow — keeps the enum → label mapping in exactly one place
 * so the Select options and the read-view never drift.
 *
 * task-i18n-stage3c-pr3 (Task 3, Step 2, template G). `msg` (module level,
 * `@lingui/core/macro`) fixes each entry's SOURCE (`uk`) text as a
 * `MessageDescriptor` — resolved against the ACTIVE catalog at the render
 * site via `i18n._(PAYMENT_TYPE_MESSAGES[type])`, never called at module
 * level with `t`. `satisfies` WITHOUT `as const` — an `as const` here would
 * make Stryker report 0 mutants for the whole block (urok #707).
 */
export const PAYMENT_TYPE_MESSAGES = {
  FOP: msg`ФОП`,
  GIG_CONTRACT: msg`гіг-контракт`,
  USDT: msg`USDT`,
} satisfies Record<ProjectPaymentType, MessageDescriptor>

/**
 * task-i18n-stage3c-pr3 (Task 3, «Опасность/Interfaces»). Legacy string map,
 * KEPT alive on purpose: `$projectId.tsx` (PR4, not this PR's file) still
 * imports it directly and renders `.FOP`/`.GIG_CONTRACT`/`.USDT` as plain
 * strings. Removing it here would break `$projectId.tsx`'s compile before
 * PR4 has migrated its own consumer to `PAYMENT_TYPE_MESSAGES` — the plan's
 * own dependency table ("PR4 ждёт мерж PR3... удалять/менять старый
 * PAYMENT_TYPE_LABELS можно только после того, как оба потребителя
 * переехали"). `projects/index.tsx` (this PR's own consumer) reads
 * `PAYMENT_TYPE_MESSAGES` exclusively — this export has zero consumers left
 * INSIDE this PR's periphery, only outside it. Delete this block in PR4 once
 * `$projectId.tsx` moves to `PAYMENT_TYPE_MESSAGES`.
 */

/* eslint-disable lingui/no-unlocalized-strings -- deliberate legacy bridge, see the doc comment above */
export const PAYMENT_TYPE_LABELS: Record<ProjectPaymentType, string> = {
  FOP: 'ФОП',
  GIG_CONTRACT: 'гіг-контракт',
  USDT: 'USDT',
}
/* eslint-enable lingui/no-unlocalized-strings */

/**
 * task-project-status-filter-ui. The four values of the /projects list's
 * status filter — design spec §2's `ProjectStatusFilter` type (ADMIN sees
 * all four; SENIOR sees ACTIVE/PENDING; everyone else sees none — the tab
 * bar itself is hidden for them, see index.tsx).
 *
 * `PENDING`/`REJECTED` map to `project.status` (`DRAFT`/`REJECTED`);
 * `ACTIVE` maps to `status === 'ACTIVE' && archivedAt === null`; `ARCHIVED`
 * maps to `archivedAt !== null` — see index.tsx's bucketing memo, which is
 * the one place this mapping is applied (client-side, from the SAME
 * `archived=false` / `archived=true` fetches the page already made before
 * this task — no new backend query param, design spec §2's own "техническое
 * решение Coder'а" delegation).
 */
export const PROJECT_STATUS_FILTERS = ['ACTIVE', 'PENDING', 'REJECTED', 'ARCHIVED'] as const
export type ProjectStatusFilter = (typeof PROJECT_STATUS_FILTERS)[number]

/**
 * Full-text labels — design spec §5 table. Used by both the `/projects`
 * SegmentedToggle (rendered from `lg:` (1024px) up only — see index.tsx's
 * `projects-status-tabs` instance and the dozakrytie #2 paragraph below for
 * why the cut is at 1024, not 640) and (PENDING only) the two dashboard
 * widgets that surface a project awaiting the viewer's own decision.
 *
 * COPY-M-2 (PR #646 fix-round 2): the original `PENDING: 'Ожидают
 * подтверждения'` (154px) forced the whole 4-column equal-width toggle
 * (`repeat(4, minmax(0,1fr))`) to need 701.9px — a real, measured break
 * (two-line tab strip) on 640-749px viewports, a width range this repo's
 * E2E suite does not test (only 320/375/768+), which is why the mechanical
 * gate stayed green through it. The 113.5px replacement this fix-round
 * chose drops the requirement to 538px.
 *
 * UX-M-3(r5) (PR #646 fix-round 5, MED — design review). "Fitting from
 * 640px up" (this comment's own prior claim) was never true: the desktop
 * `<aside>` sidebar (nav-sidebar.tsx, `hidden md:flex` + `w-52` = 208px)
 * does not exist below `md:` (768px) at all, so 640-767px genuinely has
 * the full viewport width to spare — but the SAME 538px toggle, sharing a
 * row with that sidebar from exactly 768px on, only has
 * `768 − 208(sidebar) − ~48(page padding) ≈ 512px` left, ~26px short —
 * confirmed (on macOS) to wrap in that band and to stop wrapping again
 * once viewport width outgrows the sidebar tax (≈795px, where the same
 * arithmetic clears 538px again). This macOS-measured "≈795px" turned out
 * to be the FIRST of three successively wider estimates that CI proved
 * wrong — see the two dozakrytie paragraphs below.
 *
 * COPY-M-13 (PR #646 fix-round 6, MED — copy review) undid fix-round 5's
 * OWN fix for that ~26px shortfall (a THIRD, 768-1023-only toggle instance
 * using `STATUS_FILTER_LABELS_MOBILE`) because it gave design spec §5's
 * single "планшет" class two different wordings on either side of 768px,
 * and handed the phone abbreviations to genuinely roomy iPad-portrait
 * widths (810/820/834) that never needed them — the shortfall only
 * actually exists in the narrow 768-799px slice, not the whole 768-1023
 * band. Its FIRST attempt at closing that slice kept the full labels
 * everywhere `sm:`+ and shrank button padding/gap instead
 * (`md:max-[799px]:px-1`/`gap-0.5`/`p-0.5`) — this passed locally (macOS
 * font metrics) but CI's Linux Chromium renders `text-xs` measurably wider,
 * and the shrunk padding was not enough headroom: the CI `E2E (projects)`
 * shard wrapped at 768px on the SAME commit that was green locally
 * (`tab 0 height at 768px … Expected <= 26, Received 40`).
 *
 * COPY-M-13 dozakrytie #1 (same PR, after that CI failure): stop trying to
 * squeeze the full labels into the tight 768-799px slice at all — show the
 * SHORT (`STATUS_FILTER_LABELS_MOBILE`) label set there instead, reusing
 * the EXISTING mobile toggle instance rather than adding a third DOM
 * instance. This full-label set rendered in two disjoint windows —
 * `sm:max-[767px]:grid` (640-767, no sidebar tax) and `min-[800px]:grid`
 * (800px+, on the ASSUMPTION that the sidebar tax was fully absorbed
 * again by 800px, ~5px past the macOS-measured ≈795px clearing point).
 *
 * COPY-M-13 dozakrytie #2 (same PR, SECOND CI failure): that assumption
 * was also wrong — CI wrapped again, this time at 810px
 * (`tab 0 height at 810px wraps to 2 lines`), meaning the REAL CI-metric
 * clearing point is somewhere above 810px, not the ≈795-800px macOS
 * arithmetic suggested. Critically, dozakrytie #1's CI run never actually
 * TESTED 810px — Playwright stops a test at its first failed assertion
 * inside a loop, and that run's 768px failure came first in width order,
 * so 810px's problem was latent and invisible the whole time. Rather than
 * guess a FOURTH narrower pixel value with no way to verify it against CI
 * font metrics locally (macOS Chromium's `text-xs` is confirmed narrower
 * than CI's, by an unknown-but-nonzero margin each time), the cut moves to
 * `lg:` (1024px) — the ONE width this exact test has used as its
 * single-line HEIGHT REFERENCE since fix-round 4, across every round
 * including both CI failures above, and never once been the width that
 * wrapped. `640-1023px` (design spec §5's whole "планшет" class) now
 * uniformly shows the short label set — which also resolves the ORIGINAL
 * COPY-M-13 complaint (two wordings inside one device class) more
 * completely than dozakrytie #1 did: there is now exactly one wording per
 * class, not one wording per sub-range within a class.
 *
 * COPY-L-11 = COPY-M-2 (backlog 168/201, task-projects-followups-web). The
 * previous PENDING label above was its own fifth name for the same fact
 * this tab filters to — the nav item ("/pending"), the row badge
 * (`ProjectRow.tsx`), and the detail page header badge
 * (`ProjectStatusBadge.tsx`) all already said "Ждёт решения" / "Ждут
 * решения" (CONTEXT.md's own canon: "Ждёт решения" per project, "Ждут
 * решения" for the section that collects them). 'Ждут решения' (12
 * characters) fits the same 4-column equal-width toggle budget the
 * COPY-M-2 comment above already measured against (154px was the one that
 * broke it) — the 113.5px figure quoted there is the OLD 16-character «На
 * подтверждении»'s own measurement, carried over here as an upper bound,
 * not a fresh measurement of this shorter 12-character label (CR-L-1,
 * fix-round 2): a strictly shorter string cannot need a wider container
 * than the one it replaces, so the bound still holds, but no independent
 * pixel measurement of THIS label was taken. AC3 is closed empirically by
 * the green E2E on a live stand, not by this comment. No new layout risk,
 * one name instead of five.
 *
 * task-i18n-stage3c-pr3 (Task 3, Step 2, template G, COPY-H-proj-5/M-8):
 * both label maps translated to `Record<…, MessageDescriptor>` per the
 * plan's canon table («Очікують рішення» / «Відхилені» / «Архів»,
 * `uk`-second-person-plural forms already match the previous RU wording's
 * own grammar 1:1). The pixel history above is preserved verbatim — it
 * explains WHY the layout is shaped the way it is — but the actual widths
 * were RE-MEASURED against the translated `uk` strings live (see the
 * "Опасность: табы фильтра статусов" section of the plan and the PR body's
 * own remeasurement note): `uk` renders 1-4 characters longer than the old
 * `ru` strings at every value, and confirmed to still fit the SAME
 * `lg:` (1024px) cut with no new wrap at 320/375/768/1024.
 */
export const STATUS_FILTER_LABEL_MESSAGES = {
  ACTIVE: msg`Активні`,
  PENDING: msg`Очікують рішення`,
  REJECTED: msg`Відхилені`,
  ARCHIVED: msg`Архів`,
} satisfies Record<ProjectStatusFilter, MessageDescriptor>

/**
 * Short-text labels — design spec §5's `<640px` abbreviation convention
 * (same one already shipped for `vacancies/index.tsx`'s status filter: full
 * labels collide in a 4-column grid under 640px, confirmed live there).
 *
 * COPY-M-3 (PR #646 fix-round 2): the previous set kept 'Активные'
 * un-abbreviated ("already short enough" — measured and disproven: at
 * 320px the button's 46.5px text budget left only a 2.0px gap, 0.1px once
 * the scrollbar gutter Playwright actually renders is accounted for) and
 * abbreviated the other two to 'Ожид.'/'Откл.' — one letter apart, and
 * 'Откл.' separately reads as "disabled/off", not "rejected". Full
 * replacement set, all four measured to fit a ≤42px budget with ≥11px of
 * breathing room and no two labels a single letter apart.
 *
 * COPY-M-13 dozakrytie #1/#2 (PR #646 fix-round 6, two rounds of CI red —
 * see `STATUS_FILTER_LABEL_MESSAGES`'s own comment for the full mechanism and both
 * failures): this set now renders for the ENTIRE `<lg:` range (`<1024px`)
 * via the SAME `projects-status-tabs-mobile` toggle instance, not just
 * `<640px` — not because 640-1023px is a phone, but because a short label
 * that already clears the 320px mobile budget trivially clears every width
 * in that range too, which sidesteps the whole class of "how much room
 * does the full label ACTUALLY need under CI's font metrics" bugs the two
 * dozakrytie rounds kept hitting. The instance's own `min-h-11`
 * touch-target rule stays scoped to the true `<640px` window only
 * (`[&>button]:max-[639px]:min-h-11` in index.tsx) — the 44px minimum is
 * an a11y floor for touch targets (§5/§8/§10), not a width the layout
 * needs to reserve on every tablet/laptop width too.
 *
 * task-i18n-stage3c-pr3 (Task 3, Step 2, canon table): the plan's canon
 * gives PENDING a distinct short form ("Чекають") — re-measured against
 * `uk` live at 320/375/768/1024, no wrap.
 */
export const STATUS_FILTER_LABEL_MESSAGES_MOBILE = {
  ACTIVE: msg`Активні`,
  PENDING: msg`Чекають`,
  REJECTED: msg`Відмова`,
  ARCHIVED: msg`Архів`,
} satisfies Record<ProjectStatusFilter, MessageDescriptor>
