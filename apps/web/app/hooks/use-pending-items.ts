import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/axios'

/**
 * task-pending-screen (position 7c). `GET /pending` is the API-half's
 * deliverable (task file §"Что сделать" п.1) — this file mirrors its
 * contract locally so the web half can build and test against it before
 * that half lands on this branch (task's "Разделение на две половины":
 * "до появления схемы в ветке работай по контракту из task-файла").
 *
 * TODO(merge): once `origin/feat/pending-screen` carries the real
 * `packages/shared/src/schemas/pending.ts`, delete this local shape and
 * `import type { PendingItem, PendingItemKind, PendingResponse } from
 * '@crm/shared'` instead — the field names/types below are copied
 * byte-for-byte from the task file's §1 contract so the swap is a pure
 * import-path change, no call-site edits.
 */
export type PendingItemKind = 'PROJECT_APPROVAL' | 'SHARE_APPROVAL' | 'CONTRACT_TO_SIGN'
export type PendingItemAction = 'approve' | 'reject' | 'cancel' | 'open'

export interface PendingItem {
  kind: PendingItemKind
  approvalId?: string
  subjectId: string
  /**
   * ASSUMPTION (A1, autonomy-levels.md — reversible, one field on a local
   * placeholder type, resolved for real at the `origin/feat/pending-screen`
   * merge). The task file's own `PendingItem` contract (§1) does not list
   * this field, but design spec §5.1 point 2's mapping recipe for
   * `CancelPendingShareButton` explicitly reads it
   * ("scope = subjectType === 'USER_SENIOR_SHARE' ? 'user' : 'project'") —
   * and `approvals.subjectType` is a real column the aggregation endpoint
   * already has in hand for every row it maps into a `PendingItem`. Without
   * SOME way to tell a base-share proposal from a project-share proposal,
   * neither `SeniorShareApprovalActions` (mine) nor `CancelPendingShareButton`
   * (proposedByMe) can pick the right endpoint (`/users/:id/...` vs
   * `/projects/:id/...`) — re-exposing an already-fetched DB column is the
   * lowest-risk way to close that gap without guessing business logic.
   * `undefined` (schema not merged yet, or a future kind) falls back to
   * `'project'` in `shareScopeOf` — see that function's own doc.
   */
  subjectType?: string
  /** Project name / «Контракт сотрудника». */
  title: string
  /** Who proposed this — present for `mine`. */
  proposedBy?: string
  /** Who hasn't answered yet — present for `proposedByMe`. */
  waitingFor?: string[]
  /** SHARE_APPROVAL only, and only when it's the viewer's own share. */
  currentPercent?: number
  /**
   * SHARE_APPROVAL only. Always `effectivePercentAfterApproval`, never the
   * raw (possibly `null`) `percent` — task addendum item 4 (2026-09-07):
   * a "clear the override" proposal has `percent === null` but a concrete
   * effective value, and this field must carry that resolved number so a
   * clear-override row never renders an empty percent cell.
   */
  pendingPercent?: number
  createdAt: string
  actions: PendingItemAction[]
  link: string
}

export interface PendingResponse {
  mine: PendingItem[]
  proposedByMe: PendingItem[]
}

/**
 * AC3 (client half): kept OUT of `PERSISTED_KEY_PREFIXES` (__root.tsx) on
 * purpose, same pattern as `PENDING_APPROVALS_QUERY_KEY`
 * (use-project-approvals.ts) — a SHARE_APPROVAL item's `pendingPercent` must
 * never reach IndexedDB. See `__tests__/persisted-key-prefixes.test.ts` for
 * the regression guard against the real allow-list constant (not a copy of
 * its literal keys).
 */
export const PENDING_QUERY_KEY = ['pending'] as const

/**
 * The single source both the `/pending` screen, the nav-sidebar badge, and
 * `PendingProjectApprovalsPanel` (SR-L-6) read from — same query key means
 * react-query dedupes the network call across all three mount points
 * instead of each firing its own `GET /pending`.
 */
export function usePendingItems(enabled = true) {
  const query = useQuery({
    queryKey: PENDING_QUERY_KEY,
    queryFn: () => api.get<PendingResponse>('/pending').then((r) => r.data),
    enabled,
  })
  const mine = query.data?.mine ?? []
  const proposedByMe = query.data?.proposedByMe ?? []
  return { ...query, mine, proposedByMe }
}
