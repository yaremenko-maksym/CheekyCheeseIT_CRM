/**
 * TanStack Query hooks for the PHASE 6 Documents module.
 *
 * Two-tier caching strategy (lives entirely on the client — backend stays
 * stateless aside from S3 presign):
 *   - list query                 staleTime  5 min   gcTime 30 min
 *   - presigned download URL     staleTime  4 h     gcTime 24 h
 *
 * The URL cache aligns with the API default presign TTL of 24h: refreshing
 * 20 minutes earlier (4h staleTime ⇒ each render refetches roughly hourly
 * via the inactive refresh) keeps thumbnails working without ever serving a
 * stale-and-expired URL. Result: the browser hits S3 once per file per
 * stale window, even when the user toggles between tabs.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query'
import { toast } from 'sonner'
import type { AxiosProgressEvent } from 'axios'
import type {
  Document,
  DocumentCategory,
  DocumentListFilters,
  PresignedDownload,
} from '@crm/shared'
import { api } from '@/lib/axios'

// ---------------------------------------------------------------------------
// Caching constants — exported for tests / docs assertions
// ---------------------------------------------------------------------------

export const DOCUMENT_LIST_STALE_MS = 5 * 60 * 1000
export const DOCUMENT_LIST_GC_MS = 30 * 60 * 1000

export const DOCUMENT_URL_STALE_MS = 4 * 60 * 60 * 1000
export const DOCUMENT_URL_GC_MS = 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Query: list
// ---------------------------------------------------------------------------

/**
 * Stable query key for the documents list. Filters are spread shallowly so
 * referential equality of empty filters doesn't cause spurious refetches.
 */
export function documentsQueryKey(filters: DocumentListFilters) {
  return [
    'documents',
    {
      category: filters.category ?? null,
      ownerId: filters.ownerId ?? null,
      projectId: filters.projectId ?? null,
      includeDeleted: filters.includeDeleted ?? false,
    },
  ] as const
}

export function useDocuments(
  filters: DocumentListFilters,
  options?: { enabled?: boolean },
): UseQueryResult<Document[], Error> {
  return useQuery<Document[], Error>({
    queryKey: documentsQueryKey(filters),
    queryFn: async () => {
      const params: Record<string, string> = {}
      if (filters.category) params['category'] = filters.category
      if (filters.ownerId) params['ownerId'] = filters.ownerId
      if (filters.projectId) params['projectId'] = filters.projectId
      if (filters.includeDeleted) params['includeDeleted'] = 'true'

      const res = await api.get<Document[]>('/documents', { params })
      return res.data
    },
    staleTime: DOCUMENT_LIST_STALE_MS,
    gcTime: DOCUMENT_LIST_GC_MS,
    enabled: options?.enabled ?? true,
  })
}

// ---------------------------------------------------------------------------
// Query: presigned download URL
// ---------------------------------------------------------------------------

export function documentUrlQueryKey(docId: string) {
  return ['document-url', docId] as const
}

export function documentThumbnailUrlQueryKey(docId: string) {
  return ['document-thumb-url', docId] as const
}

export function useDocumentDownloadUrl(
  docId: string | undefined,
  options?: { enabled?: boolean },
): UseQueryResult<PresignedDownload, Error> {
  return useQuery<PresignedDownload, Error>({
    queryKey: documentUrlQueryKey(docId ?? ''),
    queryFn: async () => {
      const res = await api.get<PresignedDownload>(`/documents/${docId}/download`)
      return res.data
    },
    staleTime: DOCUMENT_URL_STALE_MS,
    gcTime: DOCUMENT_URL_GC_MS,
    enabled: Boolean(docId) && (options?.enabled ?? true),
    retry: 1,
  })
}

/**
 * Presigned URL for the 256x256 JPEG thumbnail.
 *
 * Returns `null` (not undefined) when the document has no thumbnail —
 * e.g. PDFs / legacy rows — which the UI uses to fall back to a
 * category icon. Treated as a regular query (not a mutation) so
 * thumbnails benefit from the same 4h staleTime caching as the full
 * download URL and stay snappy across tab switches.
 */
export function useDocumentThumbnailUrl(
  docId: string | undefined,
  options?: { enabled?: boolean },
): UseQueryResult<PresignedDownload | null, Error> {
  return useQuery<PresignedDownload | null, Error>({
    queryKey: documentThumbnailUrlQueryKey(docId ?? ''),
    queryFn: async () => {
      const res = await api.get<PresignedDownload | null>(
        `/documents/${docId}/thumbnail`,
      )
      return res.data
    },
    staleTime: DOCUMENT_URL_STALE_MS,
    gcTime: DOCUMENT_URL_GC_MS,
    enabled: Boolean(docId) && (options?.enabled ?? true),
    retry: 1,
  })
}

// ---------------------------------------------------------------------------
// Mutation: upload
// ---------------------------------------------------------------------------

export interface UploadDocumentInput {
  file: File
  category: DocumentCategory
  projectId?: string | null
  ownerId?: string | null
  /** Optional progress callback — receives 0..100 integer. */
  onProgress?: (percent: number) => void
}

export function useUploadDocument(): UseMutationResult<
  Document,
  Error,
  UploadDocumentInput
> {
  const qc = useQueryClient()
  return useMutation<Document, Error, UploadDocumentInput>({
    mutationFn: async ({ file, category, projectId, ownerId, onProgress }) => {
      const form = new FormData()
      form.append('file', file, file.name)
      form.append('category', category)
      if (projectId) form.append('projectId', projectId)
      if (ownerId) form.append('ownerId', ownerId)

      const res = await api.post<Document>('/documents', form, {
        // Let axios set the multipart boundary automatically.
        headers: { 'Content-Type': undefined as unknown as string },
        onUploadProgress: (event: AxiosProgressEvent) => {
          if (!event.total || !onProgress) return
          const percent = Math.min(
            100,
            Math.round((event.loaded / event.total) * 100),
          )
          onProgress(percent)
        },
      })
      return res.data
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['documents'] })
      toast.success('Документ загружен')
    },
    onError: (e: Error) => {
      toast.error(`Ошибка загрузки: ${e.message}`)
    },
  })
}

// ---------------------------------------------------------------------------
// Mutation: soft delete
// ---------------------------------------------------------------------------

export function useDeleteDocument(): UseMutationResult<void, Error, string> {
  const qc = useQueryClient()
  return useMutation<void, Error, string>({
    mutationFn: async (id: string) => {
      await api.delete(`/documents/${id}`)
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['documents'] })
      toast.success('Документ перемещён в корзину')
    },
    onError: (e: Error) => toast.error(`Ошибка: ${e.message}`),
  })
}

// ---------------------------------------------------------------------------
// Mutation: restore
// ---------------------------------------------------------------------------

export function useRestoreDocument(): UseMutationResult<Document, Error, string> {
  const qc = useQueryClient()
  return useMutation<Document, Error, string>({
    mutationFn: async (id: string) => {
      const res = await api.post<Document>(`/documents/${id}/restore`)
      return res.data
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['documents'] })
      toast.success('Документ восстановлен')
    },
    onError: (e: Error) => toast.error(`Ошибка: ${e.message}`),
  })
}

// ---------------------------------------------------------------------------
// Mutation: hard delete (ADMIN)
// ---------------------------------------------------------------------------

export function useHardDeleteDocument(): UseMutationResult<void, Error, string> {
  const qc = useQueryClient()
  return useMutation<void, Error, string>({
    mutationFn: async (id: string) => {
      await api.delete(`/documents/${id}/hard`)
    },
    onSuccess: (_data, id) => {
      void qc.invalidateQueries({ queryKey: ['documents'] })
      // Drop the URL caches for this id — the S3 object is gone and any
      // cached presigned URL would 404. Use removeQueries to evict instead
      // of invalidating (no need to refetch a 404).
      qc.removeQueries({ queryKey: documentUrlQueryKey(id) })
      qc.removeQueries({ queryKey: documentThumbnailUrlQueryKey(id) })
      toast.success('Документ удалён навсегда')
    },
    onError: (e: Error) => toast.error(`Ошибка: ${e.message}`),
  })
}
