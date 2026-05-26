/**
 * TanStack Query hooks for the Invoice Signing Epic frontend.
 *
 * Two query groups:
 *   - list (`useInvoices(filters)`)            staleTime 60s, gcTime 5 min
 *   - detail (`useInvoice(transactionId)`)     staleTime 30s, gcTime 5 min
 *
 * Mutation: `useSignInvoice()` — POSTs `/api/invoices/:id/sign`, invalidates
 * both the list and the specific detail entry, plus `['notifications']`
 * (signing emits an `INVOICE_SIGNED` notification to ADMIN, and the
 * counterparty's row was marked read implicitly by clicking on the
 * notification — either way the dropdown needs a refetch).
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query'
import { toast } from 'sonner'
import type {
  InvoiceDto,
  InvoiceListFilters,
  InvoiceListItem,
} from '@crm/shared'
import { api } from '@/lib/axios'

// ---------------------------------------------------------------------------
// Caching constants — exported for tests / docs assertions
// ---------------------------------------------------------------------------

export const INVOICE_LIST_STALE_MS = 60_000
export const INVOICE_LIST_GC_MS = 5 * 60_000

export const INVOICE_DETAIL_STALE_MS = 30_000
export const INVOICE_DETAIL_GC_MS = 5 * 60_000

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

/**
 * Stable list query key. Filters are spread into a normalized object so that
 * referential equality between two empty filter calls does not retrigger
 * refetches.
 */
export function invoicesListQueryKey(filters: InvoiceListFilters) {
  return [
    'invoices',
    'list',
    {
      status: filters.status ?? null,
      type: filters.type ?? null,
    },
  ] as const
}

export function invoiceDetailQueryKey(transactionId: string) {
  return ['invoices', 'detail', transactionId] as const
}

// ---------------------------------------------------------------------------
// Query: list
// ---------------------------------------------------------------------------

export function useInvoices(
  filters: InvoiceListFilters,
  options?: { enabled?: boolean },
): UseQueryResult<InvoiceListItem[], Error> {
  return useQuery<InvoiceListItem[], Error>({
    queryKey: invoicesListQueryKey(filters),
    queryFn: async () => {
      const params: Record<string, string> = {}
      if (filters.status) params['status'] = filters.status
      if (filters.type) params['type'] = filters.type
      const res = await api.get<{ items: InvoiceListItem[] } | InvoiceListItem[]>(
        '/invoices',
        { params },
      )
      // Backend returns InvoiceListItem[] directly today; tolerate the
      // `{ items: [] }` envelope as future-proofing for pagination.
      return Array.isArray(res.data) ? res.data : res.data.items
    },
    staleTime: INVOICE_LIST_STALE_MS,
    gcTime: INVOICE_LIST_GC_MS,
    enabled: options?.enabled ?? true,
  })
}

// ---------------------------------------------------------------------------
// Query: detail
// ---------------------------------------------------------------------------

export function useInvoice(
  transactionId: string | undefined,
  options?: { enabled?: boolean },
): UseQueryResult<InvoiceDto, Error> {
  return useQuery<InvoiceDto, Error>({
    queryKey: invoiceDetailQueryKey(transactionId ?? ''),
    queryFn: async () => {
      const res = await api.get<InvoiceDto>(`/invoices/${transactionId}`)
      return res.data
    },
    staleTime: INVOICE_DETAIL_STALE_MS,
    gcTime: INVOICE_DETAIL_GC_MS,
    enabled: Boolean(transactionId) && (options?.enabled ?? true),
    retry: 1,
  })
}

// ---------------------------------------------------------------------------
// Mutation: sign
// ---------------------------------------------------------------------------

/**
 * Counterparty-side click signing. On success:
 *   - invalidate the list (status may have flipped PENDING → SIGNED)
 *   - invalidate the specific detail entry (new COUNTERPARTY signature row)
 *   - invalidate notifications (the related INVOICE_SIGN_REQUIRED row was
 *     either already marked read by the deep link or remains unread; the
 *     refetch keeps the badge in sync)
 *
 * The mutation deliberately throws on error so the dialog component can
 * keep the confirm modal open and surface the message — toasts are emitted
 * here only for the happy path.
 */
export function useSignInvoice(): UseMutationResult<InvoiceDto, Error, string> {
  const qc = useQueryClient()
  return useMutation<InvoiceDto, Error, string>({
    mutationFn: async (transactionId: string) => {
      const res = await api.post<InvoiceDto>(`/invoices/${transactionId}/sign`, {})
      return res.data
    },
    onSuccess: (_data, transactionId) => {
      void qc.invalidateQueries({ queryKey: ['invoices'] })
      void qc.invalidateQueries({ queryKey: invoiceDetailQueryKey(transactionId) })
      void qc.invalidateQueries({ queryKey: ['notifications'] })
      toast.success('Инвойс подписан')
    },
    onError: (err: Error) => {
      toast.error(`Не удалось подписать инвойс: ${err.message}`)
    },
  })
}
