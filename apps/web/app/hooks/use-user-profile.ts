import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import type {
  PaymentRequisites,
  SetNoteDto,
  UpdateProfileDto,
  UserWithPermissionsResponse,
} from '@crm/shared'
import { api } from '@/lib/axios'

export function useUser(userId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['user-profile', userId],
    queryFn: () =>
      api.get<UserWithPermissionsResponse>(`/users/${userId}`).then((r) => r.data),
    enabled: enabled && !!userId,
    staleTime: 30_000,
  })
}

export function useMe(enabled = true) {
  return useQuery({
    queryKey: ['user-profile', 'me'],
    queryFn: () =>
      api.get<UserWithPermissionsResponse>('/users/me').then((r) => r.data),
    enabled,
    staleTime: 30_000,
  })
}

export function useUpdateMe() {
  const qc = useQueryClient()
  return useMutation({
    mutationKey: ['update-me'],
    mutationFn: (data: UpdateProfileDto) =>
      api.patch('/users/me', data).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['user-profile', 'me'] })
      // Refresh /auth/me — avatar / displayName feed the global header dropdown.
      qc.invalidateQueries({ queryKey: ['auth', 'me'] })
      toast.success('Сохранено')
    },
    onError: (e: Error) => toast.error(`Ошибка: ${e.message}`),
  })
}

export function useUpdateMeRequisites() {
  const qc = useQueryClient()
  return useMutation({
    mutationKey: ['update-me-requisites'],
    mutationFn: (data: PaymentRequisites) =>
      api.patch('/users/me/requisites', data).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['user-profile', 'me'] })
      toast.success('Реквизиты обновлены')
    },
    onError: (e: Error) => toast.error(`Ошибка: ${e.message}`),
  })
}

export function useAdminSetNote(userId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: SetNoteDto) =>
      api.patch(`/users/${userId}/note`, data).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['user-profile', userId] })
      toast.success('Заметка сохранена')
    },
  })
}

export function useArchiveUser(userId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.delete(`/users/${userId}`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['user-profile', userId] })
      qc.invalidateQueries({ queryKey: ['users'] })
      qc.invalidateQueries({ queryKey: ['users-admin'] })
      toast.success('Пользователь архивирован')
    },
  })
}

export function useUnarchiveUser(userId: string, opts?: { isSenior?: boolean }) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.post(`/users/${userId}/unarchive`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['user-profile', userId] })
      qc.invalidateQueries({ queryKey: ['users'] })
      qc.invalidateQueries({ queryKey: ['users-admin'] })
      if (opts?.isSenior) {
        qc.invalidateQueries({ queryKey: ['teams'] })
      }
      const msg = opts?.isSenior
        ? 'Синьор и команда восстановлены'
        : 'Пользователь восстановлен из архива'
      toast.success(msg)
    },
    onError: (e: Error) => toast.error(`Ошибка: ${e.message}`),
  })
}
