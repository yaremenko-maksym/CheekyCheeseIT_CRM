/**
 * use-documents.ts — unit tests for `presignStaleTime`.
 *
 * task-file-storage-hardening §7: the presigned-URL query cache used to use
 * a flat 4h staleTime for every category, silently assuming the API's 24h
 * DEFAULT presign TTL applied everywhere. Sensitive categories (CONTRACT/
 * RECEIPT/INVOICE/RESUME/SCAN) actually presign for only 30 minutes
 * server-side — this pins that `presignStaleTime` derives the staleTime
 * from the response's own `expiresAt` instead, so it's correct for BOTH
 * TTLs without the client knowing the category.
 */
import { describe, expect, it } from 'vitest'
import type { Query } from '@tanstack/react-query'
import type { PresignedDownload } from '@crm/shared'
import { presignStaleTime } from './use-documents'

/** Minimal fake — `presignStaleTime` only reads `query.state.data`. */
function fakeQuery<TData extends PresignedDownload | null>(
  data: TData | undefined,
): Query<TData, Error, TData> {
  return { state: { data } } as unknown as Query<TData, Error, TData>
}

describe('presignStaleTime', () => {
  it('returns 0 when there is no cached data yet (always stale → refetch)', () => {
    expect(presignStaleTime(fakeQuery<PresignedDownload>(undefined))).toBe(0)
  })

  it('returns 0 for the thumbnail hook’s "no thumbnail" null case', () => {
    expect(presignStaleTime(fakeQuery<PresignedDownload | null>(null))).toBe(0)
  })

  it('derives a ~30min staleTime for a sensitive-category presign (short TTL)', () => {
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString() // 30 min out
    const result = presignStaleTime(
      fakeQuery<PresignedDownload>({ url: 'https://signed.example/x', expiresAt }),
    )
    // ~30 min minus the 60s safety margin, give or take test execution time.
    expect(result).toBeGreaterThan(28 * 60 * 1000)
    expect(result).toBeLessThanOrEqual(30 * 60 * 1000)
  })

  it('derives a ~24h staleTime for a default-category presign (long TTL)', () => {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    const result = presignStaleTime(
      fakeQuery<PresignedDownload>({ url: 'https://signed.example/x', expiresAt }),
    )
    expect(result).toBeGreaterThan(23 * 60 * 60 * 1000)
    expect(result).toBeLessThanOrEqual(24 * 60 * 60 * 1000)
  })

  it('never returns a negative number for an already-expired presign', () => {
    const expiresAt = new Date(Date.now() - 60 * 1000).toISOString() // already expired
    const result = presignStaleTime(
      fakeQuery<PresignedDownload>({ url: 'https://signed.example/x', expiresAt }),
    )
    expect(result).toBe(0)
  })
})
