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
 */
export const STATUS_FILTER_LABELS: Record<ProjectStatusFilter, string> = {
  ACTIVE: 'Активные',
  PENDING: 'Ожидают подтверждения',
  REJECTED: 'Отклонённые',
  ARCHIVED: 'Архив',
}

/**
 * Mobile (`<640px`) labels — design spec §5: the same abbreviation
 * convention already shipped for `vacancies/index.tsx`'s status filter
 * (full RU labels collide in a 4-column grid under 640px, confirmed live
 * there). `ACTIVE`/`ARCHIVED` are already short enough and stay unchanged.
 */
export const STATUS_FILTER_LABELS_MOBILE: Record<ProjectStatusFilter, string> = {
  ACTIVE: 'Активные',
  PENDING: 'Ожид.',
  REJECTED: 'Откл.',
  ARCHIVED: 'Архив',
}
