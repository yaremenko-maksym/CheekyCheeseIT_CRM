import type { ProjectPaymentType } from '@crm/shared'

/**
 * task-drop-share-override-and-receiver (Surface C). Single label source for
 * the "Тип оплаты" Select in both the create and edit project forms AND the
 * read-only InfoRow — keeps the enum → RU label mapping in exactly one place
 * so the Select options and the read-view never drift.
 */
export const PAYMENT_TYPE_LABELS: Record<ProjectPaymentType, string> = {
  FOP: 'ФОП',
  GIG_CONTRACT: 'гіг-контракт',
  USDT: 'USDT',
}

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
 * SegmentedToggle (rendered in the 640-767px AND 800px+ windows — see
 * index.tsx's `projects-status-tabs` instance) and (PENDING only) the two
 * dashboard widgets that surface a project awaiting the viewer's own
 * decision.
 *
 * COPY-M-2 (PR #646 fix-round 2): the original `PENDING: 'Ожидают
 * подтверждения'` (154px) forced the whole 4-column equal-width toggle
 * (`repeat(4, minmax(0,1fr))`) to need 701.9px — a real, measured break
 * (two-line tab strip) on 640-749px viewports, a width range this repo's
 * E2E suite does not test (only 320/375/768+), which is why the mechanical
 * gate stayed green through it. 'На подтверждении' (113.5px) drops the
 * requirement to 538px.
 *
 * UX-M-3(r5) (PR #646 fix-round 5, MED — design review). "Fitting from
 * 640px up" (this comment's own prior claim) was never true: the desktop
 * `<aside>` sidebar (nav-sidebar.tsx, `hidden md:flex` + `w-52` = 208px)
 * does not exist below `md:` (768px) at all, so 640-767px genuinely has
 * the full viewport width to spare — but the SAME 538px toggle, sharing a
 * row with that sidebar from exactly 768px on, only has
 * `768 − 208(sidebar) − ~48(page padding) ≈ 512px` left, ~26px short —
 * confirmed to wrap in that band and to stop wrapping again once viewport
 * width outgrows the sidebar tax (≈795px, where the same arithmetic
 * clears 538px again).
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
 * COPY-M-13 dozakrytie (same PR, after the CI failure): stop trying to
 * squeeze the full labels into the tight 768-799px slice at all — show the
 * SHORT (`STATUS_FILTER_LABELS_MOBILE`) label set there instead, reusing
 * the EXISTING mobile toggle instance (index.tsx's
 * `projects-status-tabs-mobile`) rather than adding a third DOM instance.
 * This full-label set now renders in two disjoint windows —
 * `sm:max-[767px]:grid` (640-767, no sidebar tax) and `min-[800px]:grid`
 * (800px+, sidebar tax absorbed again) — with the 768-799px gap between
 * them covered by the short set below. No padding/gap compaction needed
 * any more: a font-metric difference cannot make an already-short label
 * wrap.
 */
export const STATUS_FILTER_LABELS: Record<ProjectStatusFilter, string> = {
  ACTIVE: 'Активные',
  PENDING: 'На подтверждении',
  REJECTED: 'Отклонённые',
  ARCHIVED: 'Архив',
}

/**
 * Short-text labels — design spec §5's `<640px` abbreviation convention
 * (same one already shipped for `vacancies/index.tsx`'s status filter: full
 * RU labels collide in a 4-column grid under 640px, confirmed live there).
 *
 * COPY-M-3 (PR #646 fix-round 2): the previous set kept 'Активные'
 * un-abbreviated ("already short enough" — measured and disproven: at
 * 320px the button's 46.5px text budget left only a 2.0px gap, 0.1px once
 * the scrollbar gutter Playwright actually renders is accounted for) and
 * abbreviated the other two to 'Ожид.'/'Откл.' — one letter apart, and
 * 'Откл.' separately reads as "disabled/off", not "rejected". Full
 * replacement set, all four measured to fit a ≤42px budget with ≥11px of
 * breathing room and no two labels a single letter apart:
 * 'Идут'/'Ждут'/'Отказ'/'Архив'.
 *
 * COPY-M-13 dozakrytie (PR #646 fix-round 6, after CI red on the padding-
 * compaction attempt — see `STATUS_FILTER_LABELS`'s own comment for the
 * mechanism): this set now ALSO renders in the 768-799px slice, via the
 * SAME `projects-status-tabs-mobile` toggle instance's second visibility
 * window (`min-[768px]:max-[799px]:grid` in index.tsx) — not because that
 * slice is a phone, but because it is the one sub-band of the "планшет"
 * class where the sidebar tax leaves too little room for the full set,
 * and a short label that already clears the 320px mobile budget trivially
 * clears the larger 768-799px one too. The instance's own `min-h-11`
 * touch-target rule stays scoped to the true `<640px` window only
 * (`[&>button]:max-[639px]:min-h-11` in index.tsx) — forcing 44px-tall
 * buttons in the 768-799px slice would itself look like a wrap to a
 * single-line-height check that has no notion of "deliberately taller".
 */
export const STATUS_FILTER_LABELS_MOBILE: Record<ProjectStatusFilter, string> = {
  ACTIVE: 'Идут',
  PENDING: 'Ждут',
  REJECTED: 'Отказ',
  ARCHIVED: 'Архив',
}
