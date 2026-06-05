import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { EmployeeContractDto, EmployeeContractStatus } from '@crm/shared'
import { employeeContractSchema } from '@crm/shared'
import { api } from '@/lib/axios'

// ─── Action state ─────────────────────────────────────────────────────────────

export interface ContractActionState {
  /** Can the body markdown be edited. */
  editable: boolean
  /** Show the "Сохранить" button (PATCH). */
  showSave: boolean
  /** Show the "Отметить готовым" button (POST /ready). DRAFT only. */
  showMarkReady: boolean
  /** Show the "Сбросить к шаблону" button (POST /reset). DRAFT only. */
  showReset: boolean
  /** Show the "Вернуть в черновик" button (POST /revert). */
  showRevert: boolean
  /** Whether the revert action is destructive (SIGNED state — deletes ToS). */
  revertDestructive: boolean
}

/**
 * Pure helper — maps contract status to the set of available UI actions.
 * Mirrors the §4 lifecycle/action matrix in the spec.
 */
export function contractActionState(status: EmployeeContractStatus): ContractActionState {
  switch (status) {
    case 'DRAFT':
      return {
        editable: true,
        showSave: true,
        showMarkReady: true,
        showReset: true,
        showRevert: false,
        revertDestructive: false,
      }
    case 'READY_TO_SIGN':
      return {
        editable: false,
        showSave: false,
        showMarkReady: false,
        showReset: false,
        showRevert: true,
        revertDestructive: false,
      }
    case 'SIGNED':
      return {
        editable: false,
        showSave: false,
        showMarkReady: false,
        showReset: false,
        showRevert: true,
        revertDestructive: true,
      }
    case 'CANCELLED':
    default:
      return {
        editable: false,
        showSave: false,
        showMarkReady: false,
        showReset: false,
        showRevert: false,
        revertDestructive: false,
      }
  }
}

// ─── Query key factory ────────────────────────────────────────────────────────

export const contractKeys = {
  detail: (userId: string) => ['employee-contract', userId] as const,
}

// ─── Query ────────────────────────────────────────────────────────────────────

/**
 * Fetches (or lazy-creates) the active employee_contract for a user.
 * ADMIN-only endpoint: GET /api/users/:id/contract.
 */
export function useEmployeeContract(userId: string | undefined) {
  return useQuery({
    queryKey: contractKeys.detail(userId ?? ''),
    queryFn: async () => {
      const res = await api.get<unknown>(`/users/${userId}/contract`)
      return employeeContractSchema.parse(res.data)
    },
    enabled: !!userId,
    staleTime: 30_000,
    retry: false,
  })
}

// ─── Mutations ────────────────────────────────────────────────────────────────

/** PATCH /api/users/:id/contract — save body markdown. DRAFT only. */
export function useSaveContractBody(userId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (bodyMarkdown: string) => {
      const res = await api.patch<unknown>(`/users/${userId}/contract`, { bodyMarkdown })
      return employeeContractSchema.parse(res.data)
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: contractKeys.detail(userId) })
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`Не удалось сохранить контракт: ${msg}`)
    },
  })
}

/** POST /api/users/:id/contract/ready — DRAFT → READY_TO_SIGN. */
export function useMarkContractReady(userId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const res = await api.post<unknown>(`/users/${userId}/contract/ready`)
      return employeeContractSchema.parse(res.data)
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: contractKeys.detail(userId) })
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`Не удалось отметить готовым: ${msg}`)
    },
  })
}

/** POST /api/users/:id/contract/revert — READY_TO_SIGN | SIGNED → DRAFT. */
export function useRevertContract(userId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const res = await api.post<unknown>(`/users/${userId}/contract/revert`)
      return employeeContractSchema.parse(res.data)
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: contractKeys.detail(userId) })
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`Не удалось вернуть в черновик: ${msg}`)
    },
  })
}

/** POST /api/users/:id/contract/reset — re-derive body from active template. DRAFT only. */
export function useResetContractToTemplate(userId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const res = await api.post<unknown>(`/users/${userId}/contract/reset`)
      return employeeContractSchema.parse(res.data)
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: contractKeys.detail(userId) })
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`Не удалось сбросить к шаблону: ${msg}`)
    },
  })
}

// ─── PDF blob fetch ───────────────────────────────────────────────────────────

/**
 * Returns a function that fetches the PDF blob on demand and creates an object URL.
 * The caller is responsible for revoking the URL when done.
 * Throttle: 5 req/min — backend returns 429 if exceeded.
 */
export async function fetchContractPdfBlob(
  userId: string,
  signal?: AbortSignal,
): Promise<{ blobUrl: string; revoke: () => void }> {
  const config = signal
    ? { responseType: 'blob' as const, signal }
    : { responseType: 'blob' as const }
  const res = await api.get<Blob>(`/users/${userId}/contract/pdf`, config)
  const blobUrl = URL.createObjectURL(res.data as Blob)
  return { blobUrl, revoke: () => URL.revokeObjectURL(blobUrl) }
}

// ─── Re-export shared type for convenience ────────────────────────────────────

export type { EmployeeContractDto }
