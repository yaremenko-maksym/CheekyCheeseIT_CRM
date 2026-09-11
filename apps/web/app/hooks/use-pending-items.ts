import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/axios'
import type { PendingResponse } from '@crm/shared'

/**
 * task-pending-screen (position 7c). Client side of `GET /pending` — the one
 * screen-wide aggregate of everything the viewer owes a decision on, plus
 * (ADMIN only) what they are waiting on others for.
 *
 * The response TYPE lives in `@crm/shared` (`pending.ts`) and nowhere else:
 * this file used to carry a hand-copied placeholder shape, written while the
 * API half was still landing on the branch (task file "Разделение на две
 * половины"). That placeholder is gone — integration decision 5, 2026-09-11.
 * Consumers import `PendingItem` / `PendingItemKind` straight from
 * `@crm/shared`.
 */

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
