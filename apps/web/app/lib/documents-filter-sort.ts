/**
 * documents-filter-sort.ts — pure, side-effect-free helpers for the
 * /documents search and sort toolbar (AC6, task-documents-search-sort).
 *
 * Both functions return a NEW array and never mutate their input.
 * They operate on the already RBAC-filtered list returned by useDocuments()
 * so no backend calls are made — this is purely client-side presentation logic.
 */
import type { Document } from '@crm/shared'

// ---------------------------------------------------------------------------
// Sort key union
// ---------------------------------------------------------------------------

export type SortKey = 'date_desc' | 'date_asc' | 'name_asc' | 'name_desc' | 'size_desc' | 'size_asc'

export const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: 'date_desc', label: 'Сначала новые' },
  { value: 'date_asc', label: 'Сначала старые' },
  { value: 'name_asc', label: 'Имя: А-Я' },
  { value: 'name_desc', label: 'Имя: Я-А' },
  { value: 'size_desc', label: 'Размер: больше' },
  { value: 'size_asc', label: 'Размер: меньше' },
]

export const DEFAULT_SORT: SortKey = 'date_desc'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the human-readable filename (unicode-preserved original, or the
 *  sanitised ASCII name for rows that pre-date migration 0011). */
function resolveDisplayName(doc: Document): string {
  return doc.originalName ?? doc.name
}

// ---------------------------------------------------------------------------
// filterDocuments
// ---------------------------------------------------------------------------

/**
 * Case-insensitive substring filter against `originalName ?? name`.
 * Empty / whitespace-only query returns the full list unchanged (new array
 * reference via slice so callers can use the result safely in useMemo).
 */
export function filterDocuments(docs: Document[], query: string): Document[] {
  const trimmed = query.trim()
  if (!trimmed) return docs.slice()
  const lower = trimmed.toLowerCase()
  return docs.filter((doc) => resolveDisplayName(doc).toLowerCase().includes(lower))
}

// ---------------------------------------------------------------------------
// sortDocuments
// ---------------------------------------------------------------------------

/**
 * Sort `docs` by `key`. Returns a NEW array (no mutation).
 *
 * Stability guarantee: JavaScript Array.prototype.sort is stable in V8 (Node ≥ 11)
 * and in every modern browser, so equal keys preserve the original order.
 *
 * Name sort uses `localeCompare` with `'ru'` locale for correct Cyrillic ordering.
 */
export function sortDocuments(docs: Document[], key: SortKey): Document[] {
  const copy = docs.slice()

  switch (key) {
    case 'date_desc':
      copy.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      break
    case 'date_asc':
      copy.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      break
    case 'name_asc':
      copy.sort((a, b) =>
        resolveDisplayName(a).localeCompare(resolveDisplayName(b), 'ru', { sensitivity: 'base' }),
      )
      break
    case 'name_desc':
      copy.sort((a, b) =>
        resolveDisplayName(b).localeCompare(resolveDisplayName(a), 'ru', { sensitivity: 'base' }),
      )
      break
    case 'size_desc':
      copy.sort((a, b) => b.sizeBytes - a.sizeBytes)
      break
    case 'size_asc':
      copy.sort((a, b) => a.sizeBytes - b.sizeBytes)
      break
  }

  return copy
}
