import { msg } from '@lingui/core/macro'
import { i18n } from '@lingui/core'
import type { MessageDescriptor } from '@lingui/core'
import type { ProjectDto } from '@crm/shared'

/**
 * task-projects-followups-web (backlog 201). Single source of the "approval
 * status" caption that used to live only inside `ProjectRow.tsx` — the row
 * list already tells a viewer WHY a project was rejected and WHO a DRAFT
 * project is still waiting on; the project detail page header
 * (`$projectId.tsx`) said only the bare status word ("Отклонён" /
 * "Ждёт решения") with no further detail. Both places now call this ONE
 * function so the two halves of the same click-through (row → detail page)
 * can never drift into saying the same fact two different ways.
 *
 * `rejectionReason` is masked to `null` server-side for every viewer except
 * ADMIN (SR-M-5, PR #646 fix-round 2) — this function has no role branch of
 * its own on purpose, same as `ProjectRow.tsx` never had one: by the time a
 * `rejectionReason` string reaches here, the backend has already decided
 * this viewer is allowed to see it.
 *
 * task-i18n-stage3c-pr3 (Task 3, Step 3, template K, COPY-H-proj-2). The old
 * `from ${имя}` (именительный) при требуемом родительном падеже — заменено
 * на конструкцию БЕЗ падежа: «Підтверджують: {дроп}, {сеньйор}» вместо
 * «від {імені}», тот же приём `cancel-pending-share.tsx`'s
 * `PendingShareEditNotice` уже использует («Підтверджує {approverName}»).
 * `en` падежа не имеет, поэтому одна структура ложится на оба языка.
 *
 * Signature stays `(project, viewerId) => string | null` — unchanged from
 * before this migration — so `$projectId.tsx` (PR4, not this PR's file)
 * keeps compiling unmodified: the function resolves the ACTIVE catalog
 * itself via the shared `i18n` singleton (`@lingui/core`, NOT a React
 * hook), the same pattern `axios-utils.ts`'s `getUserFacingErrorMessage`
 * already uses for a plain (non-component) function that needs translated
 * text — see that file's own `i18n._()` calls.
 */
export type ProjectApprovalCaptionInput = Pick<
  ProjectDto,
  | 'status'
  | 'rejectionReason'
  | 'seniorId'
  | 'seniorName'
  | 'dropId'
  | 'dropName'
  | 'seniorApprovalPending'
  | 'dropApprovalPending'
>

const SENIOR_FALLBACK: MessageDescriptor = msg`сеньйора`
const DROP_FALLBACK: MessageDescriptor = msg`дропа`
const BOTH_PENDING: MessageDescriptor = msg`Підтверджують: {drop}, {senior}`
const SENIOR_PENDING: MessageDescriptor = msg`Підтверджує {senior}`
const DROP_PENDING: MessageDescriptor = msg`Підтверджує {drop}`
const VIEWER_WAITS_FOR_DROP: MessageDescriptor = msg`Ви підтвердили. Чекаємо дропа`
const VIEWER_WAITS_FOR_SENIOR: MessageDescriptor = msg`Ви підтвердили. Чекаємо сеньйора`

/**
 * Returns the caption text to render under a project's status badge, or
 * `null` when there is nothing to say (ACTIVE / ARCHIVED, or a REJECTED
 * project whose reason this viewer does not receive).
 *
 * - `REJECTED` → the quoted reason («…»), same literal format
 *   `ProjectRow.tsx` has always used — `null` when the DTO carries no
 *   reason (either genuinely absent, or masked for this viewer).
 * - `DRAFT` → who the approval is still waiting on, first-person
 *   ("Ви підтвердили. Чекаємо …") for the viewer who has already acted
 *   themselves, third-person ("Підтверджує <сеньйор>" / "Підтверджує
 *   дропа" / "Підтверджують: <дроп>, <сеньйор>") for anyone else —
 *   extracted verbatim from `ProjectRow.tsx`'s own `pendingCaption` /
 *   `viewerAlreadyActedCaption` (SPEC-M-2/COPY-H-2, PR #646), including the
 *   drop-first ordering COPY-M-1 chose there (the senior's name is the one
 *   safe to lose to truncation elsewhere, since it also renders untruncated
 *   in the row's own "Синьор" column — this function does not truncate
 *   anything itself, but keeps the same string shape callers already rely
 *   on). COPY-H-proj-2: the frame no longer needs a case at all, so it
 *   works identically on `uk` and `en`.
 * - `ACTIVE` → `null`. Archival (`archivedAt`) is a separate axis from
 *   `status` entirely (business spec §4.2 — never mixed) and is not
 *   inspected by this function at all; callers that show an "В архиве"
 *   badge instead of any of the above already branch on `archivedAt`
 *   BEFORE reaching this helper (see `ProjectRow.tsx`'s own
 *   `isArchived`-first priority).
 */
export function resolveProjectApprovalCaption(
  project: ProjectApprovalCaptionInput,
  viewerId: string | null | undefined,
): string | null {
  if (project.status === 'REJECTED') {
    return project.rejectionReason ? `«${project.rejectionReason}»` : null
  }

  if (project.status !== 'DRAFT') return null

  const seniorStillPending = project.seniorApprovalPending ?? true
  const dropStillPending = !!project.dropId && (project.dropApprovalPending ?? true)

  // COPY-M-4 (fix-round 2): `seniorName` is `z.string().nullable()` on the
  // DTO and the server really does return `null` for it in some paths — an
  // un-fallbacked name would print the literal "null" on screen. Symmetric
  // with `dropName`'s own fallback below.
  const seniorLabel = project.seniorName || i18n._(SENIOR_FALLBACK)
  const dropLabel = project.dropName || i18n._(DROP_FALLBACK)

  const pendingCaption =
    seniorStillPending && dropStillPending
      ? i18n._(BOTH_PENDING, { drop: dropLabel, senior: seniorLabel })
      : seniorStillPending
        ? i18n._(SENIOR_PENDING, { senior: seniorLabel })
        : dropStillPending
          ? // COPY-M-2 (fix-round 2): symmetric with the "both pending"
            // branch above — a drop whose senior already confirmed should
            // not lose its name from the caption when the senior's own name
            // does not. `dropName` is `null` for a SENIOR viewer (RBAC rule
            // #2 — masking, unaffected: the fallback is the same one the
            // masked branch already used before this change).
            i18n._(DROP_PENDING, { drop: dropLabel })
          : null

  const viewerIsSenior = !!viewerId && viewerId === project.seniorId
  const viewerIsDrop = !!viewerId && viewerId === project.dropId

  const viewerAlreadyActedCaption =
    viewerIsSenior && !seniorStillPending
      ? i18n._(VIEWER_WAITS_FOR_DROP)
      : viewerIsDrop && !dropStillPending
        ? i18n._(VIEWER_WAITS_FOR_SENIOR)
        : null

  return viewerAlreadyActedCaption ?? pendingCaption
}
