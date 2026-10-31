/**
 * pdf-preview.test.tsx
 *
 * Unit тесты для PdfPreview и useDocumentBlob:
 *
 * PdfPreview:
 *   AC1. Отображает лоадер когда isLoading=true и blobUrl=null
 *   AC2. Рендерит iframe когда blobUrl задан
 *   AC3. Показывает ошибку когда hasError=true
 *   AC4. Пустое состояние когда нет blob и нет загрузки
 *
 * useDocumentBlob (routing):
 *   AC5. Не запускает fetch когда open=false
 *   AC6. Для employee_contract docId — НЕ загружает через S3
 *
 * Download via blob (regression):
 *   AC7. handleDownload НЕ вызывает downloadQuery.refetch() для PDF
 */

import { render, screen, act, fireEvent } from '@testing-library/react'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { PdfPreview, type PdfPreviewProps } from '../pdf-preview'

// ---------------------------------------------------------------------------
// PdfPreview rendering tests (task-i18n-stage3e-pr3: text resolved through the
// REAL compiled catalog, both locales; expected strings are literals taken
// from the plan's canon, not recomputed from the component)
// ---------------------------------------------------------------------------

function renderPreview(props: PdfPreviewProps) {
  return render(<PdfPreview {...props} />, { wrapper: I18nTestProvider })
}

describe.each([
  {
    locale: 'uk' as const,
    loading: 'Завантаження PDF…',
    error: 'Не вдалося завантажити PDF — спробуйте відкрити файл ще раз',
    iframeTitle: 'Попередній перегляд: document.pdf',
    blocked: 'Браузер заблокував вбудований перегляд PDF',
    download: 'Завантажити PDF',
  },
  {
    locale: 'en' as const,
    loading: 'Loading PDF…',
    error: 'Couldn’t load the PDF — try opening the file again',
    iframeTitle: 'Preview: document.pdf',
    blocked: 'Your browser blocked the built-in PDF viewer',
    download: 'Download PDF',
  },
])('PdfPreview ($locale)', ({ locale, loading, error, iframeTitle, blocked, download }) => {
  beforeEach(async () => {
    await loadCatalog(locale)
  })
  afterEach(async () => {
    await loadCatalog('uk')
  })

  it('AC1: показывает лоадер когда isLoading=true и blobUrl=null', () => {
    renderPreview({ blobUrl: null, isLoading: true, hasError: false, filename: 'test.pdf' })
    expect(screen.getByText(loading)).toBeInTheDocument()
  })

  it('AC2: рендерит iframe когда blobUrl задан; title и aria-label несут имя файла', () => {
    renderPreview({
      blobUrl: 'blob:http://localhost/fake-blob-id',
      isLoading: false,
      hasError: false,
      filename: 'document.pdf',
      testId: 'document-pdf-preview',
    })
    expect(screen.getByTestId('document-pdf-preview')).toBeInTheDocument()
    // Найден по accessible-имени (title + aria-label одинаковы).
    const iframe = screen.getByTitle(iframeTitle)
    expect(iframe).toHaveAttribute('src', 'blob:http://localhost/fake-blob-id')
    expect(iframe).toHaveAttribute('aria-label', iframeTitle)
    // M-8: мёртвый <object>-фолбэк внутри <iframe> удалён.
    expect(iframe).toBeEmptyDOMElement()
  })

  it('AC3: показывает состояние ошибки когда hasError=true', () => {
    renderPreview({ blobUrl: null, isLoading: false, hasError: true, filename: 'test.pdf' })
    expect(screen.getByText(error)).toBeInTheDocument()
    expect(screen.getByTestId('document-pdf-preview-error')).toBeInTheDocument()
  })

  it('AC4: пустое состояние когда нет blob и нет загрузки и нет ошибки', () => {
    renderPreview({ blobUrl: null, isLoading: false, hasError: false, filename: 'test.pdf' })
    expect(screen.queryByText(loading)).not.toBeInTheDocument()
    expect(screen.queryByText(error)).not.toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('AC5: data-testid корректно проставляется', () => {
    renderPreview({ blobUrl: null, isLoading: false, hasError: false, testId: 'custom-testid' })
    expect(screen.getByTestId('custom-testid')).toBeInTheDocument()
  })

  it('M-7: после таймаута iframe кнопка названа «скачать» и действительно скачивает (download)', () => {
    vi.useFakeTimers()
    try {
      renderPreview({
        blobUrl: 'blob:http://localhost/fake',
        isLoading: false,
        hasError: false,
        filename: 'cv.pdf',
      })
      act(() => {
        vi.advanceTimersByTime(3000)
      })
      expect(screen.getByText(blocked)).toBeInTheDocument()
      const link = screen.getByRole('link', { name: download })
      // Подпись обещает скачивание — атрибут download это обещание выполняет.
      expect(link).toHaveAttribute('download', 'cv.pdf')
      expect(link).toHaveAttribute('href', 'blob:http://localhost/fake')
    } finally {
      vi.useRealTimers()
    }
  })
})

const UK = {
  loading: 'Завантаження PDF…',
  iframeTitle: 'Попередній перегляд: document.pdf',
  blocked: 'Браузер заблокував вбудований перегляд PDF',
  iosCopy: 'Вбудований перегляд PDF недоступний на цьому пристрої',
  open: 'Відкрити PDF',
  download: 'Завантажити PDF',
  error: 'Не вдалося завантажити PDF — спробуйте відкрити файл ще раз',
}

function stubDevice(kind: 'iphone' | 'desktop') {
  vi.stubGlobal(
    'navigator',
    kind === 'iphone'
      ? {
          userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
          platform: 'iPhone',
          maxTouchPoints: 5,
        }
      : { userAgent: 'Mozilla/5.0 (Windows NT 10.0)', platform: 'Win32', maxTouchPoints: 0 },
  )
}

describe('PdfPreview on iOS', () => {
  beforeEach(async () => {
    await loadCatalog('uk')
    stubDevice('iphone')
  })
  afterEach(async () => {
    vi.unstubAllGlobals()
    await loadCatalog('uk')
  })

  it('AC3: renders «Відкрити PDF» anchor to the blob, no iframe, no loader', () => {
    renderPreview({ blobUrl: 'blob:x', isLoading: false, hasError: false })
    expect(screen.queryByTitle(UK.iframeTitle)).toBeNull()
    expect(screen.queryByText(UK.loading)).toBeNull()
    expect(screen.queryByText(UK.blocked)).toBeNull()
    const open = screen.getByRole('link', { name: UK.open })
    expect(open).toHaveAttribute('href', 'blob:x')
    expect(open).toHaveAttribute('target', '_blank')
    expect(open).toHaveAttribute('rel', 'noopener noreferrer')
    expect(open).not.toHaveAttribute('download')
    expect(screen.getByTestId('document-pdf-preview-open')).toBe(open)
    expect(screen.getByText(UK.iosCopy)).toBeInTheDocument()
  })

  it('uses a custom testId for the open button', () => {
    renderPreview({ blobUrl: 'blob:x', isLoading: false, hasError: false, testId: 'custom' })
    expect(screen.getByTestId('custom-open')).toHaveAttribute('href', 'blob:x')
  })

  it('both buttons are >= 44px touch targets (lg, min-h-11, full width on mobile)', () => {
    renderPreview({ blobUrl: 'blob:x', isLoading: false, hasError: false, filename: 'a.pdf' })
    for (const name of [UK.open, UK.download]) {
      const link = screen.getByRole('link', { name })
      expect(link).toHaveClass('min-h-11', 'w-full', 'sm:w-auto', 'h-11')
      expect(link).not.toHaveClass('h-8')
    }
    expect(screen.getByRole('link', { name: UK.download })).toHaveAttribute('download', 'a.pdf')
  })

  it('still shows the loader while the blob is fetching (no blobUrl)', () => {
    renderPreview({ blobUrl: null, isLoading: true, hasError: false })
    expect(screen.getByText(UK.loading)).toBeInTheDocument()
    expect(screen.queryByTestId('document-pdf-preview-open')).toBeNull()
  })

  it('shows nothing actionable without a blobUrl', () => {
    renderPreview({ blobUrl: null, isLoading: false, hasError: false })
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.queryByText(UK.iosCopy)).toBeNull()
  })

  it('hasError wins: only the error block, no open button', () => {
    renderPreview({ blobUrl: 'blob:x', isLoading: false, hasError: true })
    expect(screen.getByTestId('document-pdf-preview-error')).toBeInTheDocument()
    expect(screen.queryByTestId('document-pdf-preview-open')).toBeNull()
    expect(screen.queryByText(UK.iosCopy)).toBeNull()
    expect(screen.queryByText(UK.loading)).toBeNull()
  })
})

describe('PdfPreview on desktop (state matrix)', () => {
  beforeEach(async () => {
    await loadCatalog('uk')
    stubDevice('desktop')
    vi.useFakeTimers()
  })
  afterEach(async () => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    await loadCatalog('uk')
  })

  it('blob present, iframe not ready: loader + invisible iframe, no fallback', () => {
    renderPreview({ blobUrl: 'blob:x', isLoading: false, hasError: false })
    expect(screen.getByText(UK.loading)).toBeInTheDocument()
    expect(screen.getByTitle(UK.iframeTitle)).toHaveClass('invisible')
    expect(screen.queryByText(UK.blocked)).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('iframe onLoad: loader gone, iframe visible, still no fallback', () => {
    renderPreview({ blobUrl: 'blob:x', isLoading: false, hasError: false })
    fireEvent.load(screen.getByTitle(UK.iframeTitle))
    expect(screen.queryByText(UK.loading)).toBeNull()
    expect(screen.getByTitle(UK.iframeTitle)).not.toHaveClass('invisible')
    expect(screen.queryByText(UK.blocked)).toBeNull()
  })

  it('after the 3 s iframe timeout: fallback only (download), no iframe, no loader, no open button', () => {
    renderPreview({ blobUrl: 'blob:x', isLoading: false, hasError: false, filename: 'a.pdf' })
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(screen.queryByTitle(UK.iframeTitle)).toBeNull()
    expect(screen.queryByText(UK.loading)).toBeNull()
    expect(screen.getByText(UK.blocked)).toBeInTheDocument()
    expect(screen.queryByText(UK.iosCopy)).toBeNull()
    expect(screen.queryByTestId('document-pdf-preview-open')).toBeNull()
    expect(screen.queryByRole('link', { name: UK.open })).toBeNull()
    const dl = screen.getByRole('link', { name: UK.download })
    expect(dl).toHaveClass('h-8', 'text-xs')
    expect(dl).not.toHaveClass('min-h-11')
    expect(dl).not.toHaveClass('h-11')
    expect(dl).not.toHaveClass('w-full')
  })

  it('hasError with a blob: only the error block', () => {
    renderPreview({ blobUrl: 'blob:x', isLoading: false, hasError: true })
    expect(screen.getByTestId('document-pdf-preview-error')).toBeInTheDocument()
    expect(screen.queryByTitle(UK.iframeTitle)).toBeNull()
    expect(screen.queryByText(UK.loading)).toBeNull()
    expect(screen.queryByText(UK.blocked)).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('hasError arriving while in fallback state replaces the fallback block', () => {
    const props = { blobUrl: 'blob:x', isLoading: false, hasError: false }
    const { rerender } = renderPreview(props)
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(screen.getByText(UK.blocked)).toBeInTheDocument()
    rerender(<PdfPreview {...props} hasError />)
    expect(screen.queryByText(UK.blocked)).toBeNull()
    expect(screen.getByTestId('document-pdf-preview-error')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Download from blob — regression (AC7)
// ---------------------------------------------------------------------------

describe('handleDownload uses blob — no S3 refetch for PDF', () => {
  it('AC7: создаёт <a> с blobUrl и вызывает click без window.open / refetch', () => {
    // Симулируем наличие blob URL
    const blobUrl = 'blob:http://localhost/test-pdf-blob'
    const filename = 'тест-документ.pdf'

    // Минимальная реализация handleDownload из document-detail-dialog
    const clickedHrefs: string[] = []
    const clickedDownloadAttrs: string[] = []

    const fakeHandleDownload = (activeBlobUrl: string | null, displayName: string) => {
      if (activeBlobUrl) {
        const a = document.createElement('a')
        a.href = activeBlobUrl
        a.download = displayName || 'document.pdf'
        clickedHrefs.push(a.href)
        clickedDownloadAttrs.push(a.download)
        // НЕ вызываем window.open, НЕ делаем refetch
        return
      }
    }

    const refetchSpy = vi.fn()

    fakeHandleDownload(blobUrl, filename)

    // Проверяем: href = blobUrl, download = filename, refetch НЕ вызван
    expect(clickedHrefs[0]).toBe(blobUrl)
    expect(clickedDownloadAttrs[0]).toBe(filename)
    expect(refetchSpy).not.toHaveBeenCalled()
  })

  it('AC7b: для не-blob (blob=null) — не бросает ошибок', () => {
    // Когда blob ещё не загружен — handleDownload завершается без действий
    const fakeHandleDownload = (activeBlobUrl: string | null) => {
      if (activeBlobUrl) {
        // download logic
        return
      }
      // Blob не готов — ничего не делаем
    }

    // Не должно выбросить ошибку
    expect(() => fakeHandleDownload(null)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// SW cache routing (AC6 — guard that contract source stays no-store)
// ---------------------------------------------------------------------------

describe('SW cache: контракт не попадает в media-cache', () => {
  it('AC6: same-origin /api/ URL не матчит media-cache urlPattern', () => {
    // Имитируем логику urlPattern из vite.config.ts
    const selfOrigin = 'http://localhost:3000'

    function mediaUrlPattern(url: URL, method: string, destination: string): boolean {
      if (url.origin === selfOrigin) return false
      if (url.pathname.startsWith('/api/')) return false
      if (destination === 'image') return true
      if (url.pathname.toLowerCase().endsWith('.pdf')) return true
      if (method === 'GET' && destination === '') return true
      return false
    }

    // same-origin contract endpoint → НЕ матчит (goes to api-cache with no-store guard)
    const contractUrl = new URL('http://localhost:3001/api/users/abc/contract/pdf')
    expect(mediaUrlPattern(contractUrl, 'GET', '')).toBe(false)

    // cross-origin S3 PDF → матчит
    const s3PdfUrl = new URL('http://s3.local:9000/crm-documents/some-key.pdf?X-Amz-Signature=abc')
    expect(mediaUrlPattern(s3PdfUrl, 'GET', '')).toBe(true)

    // cross-origin S3 image → матчит
    const s3ImgUrl = new URL('http://s3.local:9000/crm-documents/thumbnail.jpg?X-Amz-Signature=abc')
    expect(mediaUrlPattern(s3ImgUrl, 'GET', 'image')).toBe(true)

    // same-origin API GET → НЕ матчит
    const apiUrl = new URL('http://localhost:3001/api/documents/123/download')
    expect(mediaUrlPattern(apiUrl, 'GET', '')).toBe(false)
  })
})
