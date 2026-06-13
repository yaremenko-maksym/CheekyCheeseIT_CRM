import { useQuery } from '@tanstack/react-query'
import type { ProjectDto } from '@crm/shared'
import { api } from '@/lib/axios'

/**
 * Stable query-key for the JUNIOR-facing projects list.
 *
 * Namespaced as `['junior', 'projects']` (NOT the shared `['projects']`):
 *  1. Avoids cache collision with the ADMIN/SENIOR `['projects']` list —
 *     a non-junior list would otherwise overwrite / be read by the hub,
 *     leaking unmasked rows or stale shapes.
 *  2. Keeps junior project data OFF disk — `'junior'` is NOT in the
 *     `PERSISTED_KEY_PREFIXES` allow-list in __root.tsx (where `'projects'`
 *     IS listed), so masked junior data is never written to IndexedDB.
 *
 * IMPORTANT: Do NOT add `'junior'` to the persist allow-list in __root.tsx.
 */
export const JUNIOR_PROJECTS_QUERY_KEY = ['junior', 'projects'] as const

/**
 * JUNIOR-facing hook for fetching the current user's projects.
 *
 * Used on both /crm/project (hub) and /crm/legend to derive activeProject.
 * See query-key comment above for persist-isolation rationale.
 */
export function useJuniorProjects() {
  return useQuery<ProjectDto[]>({
    queryKey: JUNIOR_PROJECTS_QUERY_KEY,
    queryFn: () => api.get<ProjectDto[]>('/projects').then((r) => r.data),
    staleTime: 5 * 60_000,
  })
}
