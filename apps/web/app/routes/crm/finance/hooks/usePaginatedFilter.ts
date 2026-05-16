import { useEffect, useMemo, useState } from 'react'

export interface SortConfig<K extends string> {
  key: K
  dir: 'asc' | 'desc'
}

const DEFAULT_PAGE_SIZE = 50

export function usePaginatedFilter<T, K extends string>(
  items: T[],
  filter: (item: T) => boolean,
  sort: (a: T, b: T) => number,
) {
  const [page, setPage] = useState(1)

  const filtered = useMemo(() => items.filter(filter), [items, filter])
  const sorted = useMemo(() => [...filtered].sort(sort), [filtered, sort])
  const totalPages = Math.max(1, Math.ceil(sorted.length / DEFAULT_PAGE_SIZE))

  // Clamp page when filters shrink total pages
  useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [totalPages, page])

  // Reset to page 1 when filter changes (items.length change is a proxy)
  const filteredLen = filtered.length
  useEffect(() => {
    setPage(1)
  }, [filteredLen])

  const paged = useMemo(
    () => sorted.slice((page - 1) * DEFAULT_PAGE_SIZE, page * DEFAULT_PAGE_SIZE),
    [sorted, page],
  )

  return {
    paged,
    page,
    setPage,
    totalPages,
    totalItems: filtered.length,
    pageSize: DEFAULT_PAGE_SIZE,
  }
}
