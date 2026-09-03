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
 * Desktop (`sm:` and up) labels — full text, design spec §5 table. Used by
 * both the `/projects` SegmentedToggle and (PENDING only) the two dashboard
 * widgets that surface a project awaiting the viewer's own decision.
 *
 * COPY-M-2 (PR #646 fix-round 2): the original `PENDING: 'Ожидают
 * подтверждения'` (154px) forced the whole 4-column equal-width toggle
 * (`repeat(4, minmax(0,1fr))`) to need 701.9px — a real, measured break
 * (two-line tab strip) on 640-749px viewports, a width range this repo's
 * E2E suite does not test (only 320/375/768+), which is why the mechanical
 * gate stayed green through it. 'На подтверждении' (113.5px) drops the
 * requirement to 538px, fitting from 640px up.
 */
export const STATUS_FILTER_LABELS: Record<ProjectStatusFilter, string> = {
  ACTIVE: 'Активные',
  PENDING: 'На подтверждении',
  REJECTED: 'Отклонённые',
  ARCHIVED: 'Архив',
}

/**
 * Mobile (`<640px`) labels — design spec §5: the same abbreviation
 * convention already shipped for `vacancies/index.tsx`'s status filter
 * (full RU labels collide in a 4-column grid under 640px, confirmed live
 * there).
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
 */
export const STATUS_FILTER_LABELS_MOBILE: Record<ProjectStatusFilter, string> = {
  ACTIVE: 'Идут',
  PENDING: 'Ждут',
  REJECTED: 'Отказ',
  ARCHIVED: 'Архив',
}
