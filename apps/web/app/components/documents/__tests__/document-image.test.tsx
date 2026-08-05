/**
 * DocumentImage — crossOrigin regression guard (security HIGH-1,
 * task-scan-cache-leak).
 *
 * Without `crossOrigin="anonymous"` on the rendered `<img>`, the browser
 * fetches it in `no-cors` mode and gets back an OPAQUE Response (status
 * forced to `0`, `Cache-Control` unreadable) — which defeats the Service
 * Worker's `media-cache` `cacheWillUpdate` no-store check by construction
 * (see apps/web/app/lib/pwa-runtime-caching.ts). This is a pure DOM-attribute
 * assertion (the actual opaque-vs-transparent fetch behavior can't be
 * observed from a unit test — that's covered by
 * pwa-runtime-caching.spec.ts's predicate-level tests instead), but it
 * pins the one thing that actually has to be true for that fix to matter:
 * the rendered element must ask the browser for a `cors`-mode fetch.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const THUMBNAIL_URL = 'https://s3.example.com/bucket/documents/SCAN/owner-1/doc-1-thumb.jpg'

vi.mock('@/hooks/use-documents', () => ({
  useDocumentThumbnailUrl: () => ({
    data: { url: THUMBNAIL_URL, expiresAt: '2099-01-01T00:00:00.000Z' },
    isLoading: false,
    isError: false,
  }),
  useDocumentDownloadUrl: () => ({
    data: { url: THUMBNAIL_URL, expiresAt: '2099-01-01T00:00:00.000Z' },
    isLoading: false,
    isError: false,
  }),
}))

import { DocumentImage } from '../document-image'

function renderImage(variant: 'thumbnail' | 'full' = 'thumbnail') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <DocumentImage docId="doc-1" alt="Скан документа" variant={variant} />
    </QueryClientProvider>,
  )
}

describe('DocumentImage — crossOrigin="anonymous" (security HIGH-1)', () => {
  it('sets crossOrigin="anonymous" on the thumbnail <img>', async () => {
    renderImage('thumbnail')
    const img = await screen.findByRole('img', { name: 'Скан документа' })
    expect(img).toHaveAttribute('crossorigin', 'anonymous')
    expect(img).toHaveAttribute('src', THUMBNAIL_URL)
  })

  it('sets crossOrigin="anonymous" on the full-res <img> too (same shared element)', async () => {
    renderImage('full')
    const img = await screen.findByRole('img', { name: 'Скан документа' })
    expect(img).toHaveAttribute('crossorigin', 'anonymous')
  })
})
