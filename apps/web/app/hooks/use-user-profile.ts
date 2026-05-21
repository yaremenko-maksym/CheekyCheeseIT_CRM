import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import type {
  AdminUpdateUserDto,
  AuditLogList,
  ChangeRequisitesDto,
  ChangeRoleDto,
  ChangeSalaryDto,
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

export function useUserAuditLog(
  userId: string | undefined,
  page: number,
  limit: number,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ['user-audit-log', userId, page, limit],
    queryFn: () =>
      api
        .get<AuditLogList>(`/users/${userId}/audit-log?page=${page}&limit=${limit}`)
        .then((r) => r.data),
    enabled: enabled && !!userId,
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

export function useAdminUpdateUser(userId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: AdminUpdateUserDto) =>
      api.patch(`/users/${userId}`, data).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['user-profile', userId] })
      qc.invalidateQueries({ queryKey: ['user-audit-log', userId] })
      toast.success('Профиль обновлён')
    },
  })
}

export function useAdminChangeRole(userId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: ChangeRoleDto) =>
      api.patch(`/users/${userId}/role`, data).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['user-profile', userId] })
      qc.invalidateQueries({ queryKey: ['user-audit-log', userId] })
      toast.success('Роль изменена')
    },
  })
}

export function useAdminChangeSalary(userId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: ChangeSalaryDto) =>
      api.patch(`/users/${userId}/salary`, data).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['user-profile', userId] })
      qc.invalidateQueries({ queryKey: ['user-audit-log', userId] })
      toast.success('Зарплата обновлена')
    },
  })
}

export function useAdminChangeRequisites(userId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: ChangeRequisitesDto) =>
      api.patch(`/users/${userId}/requisites`, data).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['user-profile', userId] })
      qc.invalidateQueries({ queryKey: ['user-audit-log', userId] })
      toast.success('Реквизиты обновлены')
    },
  })
}

export function useAdminSetNote(userId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: SetNoteDto) =>
      api.patch(`/users/${userId}/note`, data).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['user-profile', userId] })
      qc.invalidateQueries({ queryKey: ['user-audit-log', userId] })
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
      toast.success('Пользователь архивирован')
    },
  })
}
