import { useQuery } from '@tanstack/react-query'
import type { BoardSeniorDto } from '@crm/shared'
import { api } from '@/lib/axios'

/**
 * Board selector data source — `GET /interviews/seniors`
 * (task-hr-drop-team-senior-board).
 *
 * Replaces the OLD client-side derivation the `/interviews` selector used:
 * `GET /users` (queryKey ['users']) intersected in JS with `GET /teams`
 * (queryKey ['teams']) for HR. That intersection silently diverged from the
 * server's own access gate — `TeamsService.findAll` filters out DROP-type
 * teams for an HR caller (a separate, unrelated decision about the
 * team-LIST page), so an HR whose only shared team with a senior was a
 * drop-team lost that senior from the selector, even though
 * `GET /interviews?seniorId=<id>` would have opened the board just fine.
 * `GET /interviews/seniors` is backed by `InterviewsService
 * .getAccessibleSeniorIds` for HR — the SAME function that gates
 * `GET /interviews` — so the selector and the list endpoint can never
 * disagree again.
 *
 * `enabled` is the caller's role gate (ADMIN/HR see the selector; SENIOR
 * doesn't need it — the backend would answer with just themselves, but the
 * page never renders a `<select>` for SENIOR in the first place).
 */
export function useBoardSeniors(enabled: boolean) {
  return useQuery<BoardSeniorDto[]>({
    queryKey: ['interviews', 'seniors'],
    queryFn: () => api.get<BoardSeniorDto[]>('/interviews/seniors').then((r) => r.data),
    enabled,
    staleTime: 5 * 60_000,
  })
}
