import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { AxiosError } from 'axios'
import type { ArchiveImpact } from '@crm/shared'
import { api } from '@/lib/axios'

export type EntityType = 'user' | 'team' | 'project'

const ENDPOINTS: Record<EntityType, string> = {
  user: 'users',
  team: 'teams',
  project: 'projects',
}

// ── Archive impact ────────────────────────────────────────────────────────────

export function useArchiveImpact(entityType: EntityType, entityId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: [entityType, 'archive-impact', entityId],
    queryFn: () =>
      api.get<ArchiveImpact>(`/${ENDPOINTS[entityType]}/${entityId}/archive-impact`).then((r) => r.data),
    enabled: enabled && !!entityId,
    staleTime: 0,
  })
}

// ── Archive mutation ──────────────────────────────────────────────────────────

export function useArchiveEntity(entityType: EntityType, entityId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.delete(`/${ENDPOINTS[entityType]}/${entityId}`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [`${entityType}s`] })
      qc.invalidateQueries({ queryKey: [entityType, entityId] })
      // Sibling entities affected by cascade
      if (entityType === 'user' || entityType === 'team') {
        qc.invalidateQueries({ queryKey: ['teams'] })
        qc.invalidateQueries({ queryKey: ['projects'] })
        qc.invalidateQueries({ queryKey: ['users'] })
      }
      if (entityType === 'project') {
        qc.invalidateQueries({ queryKey: ['projects'] })
      }
      const labels: Record<EntityType, string> = {
        user: 'Пользователь архивирован',
        team: 'Команда и синьор архивированы',
        project: 'Проект архивирован',
      }
      toast.success(labels[entityType])
    },
    onError: (err: AxiosError<{ message?: string }>) => {
      toast.error(err?.response?.data?.message ?? 'Не удалось архивировать')
    },
  })
}

// ── Unarchive mutation ────────────────────────────────────────────────────────

export type UnarchiveCascadeEntity = { type: 'user' | 'team'; id: string; name: string }
export type UnarchiveError = {
  requiresCascade: true
  entities: UnarchiveCascadeEntity[]
}

export function useUnarchiveEntity(entityType: EntityType, entityId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ cascade }: { cascade?: boolean } = {}) =>
      api
        .post(
          `/${ENDPOINTS[entityType]}/${entityId}/unarchive${cascade ? '?cascade=true' : ''}`,
        )
        .then((r) => r.data),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: [`${entityType}s`] })
      qc.invalidateQueries({ queryKey: [entityType, entityId] })
      if (entityType === 'user' || entityType === 'team') {
        qc.invalidateQueries({ queryKey: ['teams'] })
        qc.invalidateQueries({ queryKey: ['users'] })
      }
      if (entityType === 'project') {
        qc.invalidateQueries({ queryKey: ['projects'] })
        if (variables?.cascade) {
          qc.invalidateQueries({ queryKey: ['teams'] })
          qc.invalidateQueries({ queryKey: ['users'] })
        }
      }
      const labels: Record<EntityType, string> = {
        user: 'Пользователь восстановлен',
        team: 'Команда и синьор восстановлены',
        project: variables?.cascade
          ? 'Восстановлено: проект, синьор, команда'
          : 'Проект восстановлен',
      }
      toast.success(labels[entityType])
    },
    onError: (err: AxiosError<{ message?: string } | UnarchiveError>) => {
      // 409 cascade-required is rethrown — caller handles modal.
      const status = err.response?.status
      if (status === 409) return
      const msg = (err.response?.data as { message?: string } | undefined)?.message
      toast.error(msg ?? 'Не удалось восстановить')
    },
  })
}

