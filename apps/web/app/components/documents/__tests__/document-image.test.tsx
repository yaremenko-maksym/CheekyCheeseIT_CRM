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
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
// task-i18n-stage3e-pr2 — `DocumentImage` now calls `useLingui()` (accessible
// names for the loading / unavailable placeholders), so every render needs an
// `I18nProvider`. Cross-consumers (ProjectLogo, UserAvatar, image-upload-field)
// get the same wrapper in their own tests.
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

beforeEach(async () => {
  await loadCatalog('uk')
})

const queryState = {
  thumb: {
    data: { url: 'https://s3.example.com/bucket/documents/SCAN/owner-1/doc-1-thumb.jpg' } as {
      url: string
    } | null,
    isLoading: false,
    isError: false,
  },
}

const THUMBNAIL_URL = 'https://s3.example.com/bucket/documents/SCAN/owner-1/doc-1-thumb.jpg'

vi.mock('@/hooks/use-documents', () => ({
  useDocumentThumbnailUrl: () => queryState.thumb,
  useDocumentDownloadUrl: () => ({
    data: { url: THUMBNAIL_URL, expiresAt: '2099-01-01T00:00:00.000Z' },
    isLoading: false,
    isError: false,
  }),
}))

import { DocumentImage } from '../document-image'

function renderImage(
  variant: 'thumbnail' | 'full' = 'thumbnail',
  extra: { fallbackToParent?: boolean } = {},
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <I18nTestProvider>
      <QueryClientProvider client={qc}>
        <DocumentImage docId="doc-1" alt="Скан документа" variant={variant} {...extra} />
      </QueryClientProvider>
    </I18nTestProvider>,
  )
}

const LOADED = { data: { url: THUMBNAIL_URL }, isLoading: false, isError: false }

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

// task-i18n-stage3e-pr2 (COPY-L-docs-21): `aria-label` on a bare <div> is
// ignored by screen readers — the placeholders now carry a role.
describe('DocumentImage — accessible placeholders (L-21)', () => {
  it('loading → role="status" named «Зображення завантажується»', () => {
    queryState.thumb = { data: null, isLoading: true, isError: false }
    try {
      renderImage()
      expect(screen.getByRole('status', { name: 'Зображення завантажується' })).toBeInTheDocument()
    } finally {
      queryState.thumb = LOADED
    }
  })

  it('no thumbnail → role="img" named «Попередній перегляд недоступний»', () => {
    queryState.thumb = { data: null, isLoading: false, isError: false }
    try {
      renderImage()
      expect(
        screen.getByRole('img', { name: 'Попередній перегляд недоступний' }),
      ).toBeInTheDocument()
    } finally {
      queryState.thumb = LOADED
    }
  })

  it('error → the same unavailable placeholder', () => {
    queryState.thumb = { data: null, isLoading: false, isError: true }
    try {
      renderImage()
      expect(
        screen.getByRole('img', { name: 'Попередній перегляд недоступний' }),
      ).toBeInTheDocument()
    } finally {
      queryState.thumb = LOADED
    }
  })

  it('fallbackToParent → renders nothing (parent draws its own icon)', () => {
    queryState.thumb = { data: null, isLoading: false, isError: false }
    try {
      const { container } = renderImage('thumbnail', { fallbackToParent: true })
      expect(container).toBeEmptyDOMElement()
    } finally {
      queryState.thumb = LOADED
    }
  })

  it('en names', async () => {
    await loadCatalog('en')
    queryState.thumb = { data: null, isLoading: true, isError: false }
    try {
      const { unmount } = renderImage()
      expect(screen.getByRole('status', { name: 'Loading the image' })).toBeInTheDocument()
      unmount()
      queryState.thumb = { data: null, isLoading: false, isError: false }
      renderImage()
      expect(screen.getByRole('img', { name: 'Preview unavailable' })).toBeInTheDocument()
    } finally {
      queryState.thumb = LOADED
    }
  })
})
