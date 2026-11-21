/**
 * routes/_authenticated/admin/sources.index.tsx — the AI-limits banner over the source health table
 * (ADR 2026-11-03 §H.8, task 5.4c-H4).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render as rtlRender, screen, within } from '@testing-library/react'
import type { ReactElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'

vi.mock('@tanstack/react-router', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router')
  return {
    ...actual,
    Link: ({
      children,
      to,
      params,
      ...props
    }: React.PropsWithChildren<
      { to: string; params?: Record<string, string> } & Record<string, unknown>
    >) => (
      <a href={to.replace('$sourceId', params?.sourceId ?? '')} {...props}>
        {children}
      </a>
    ),
  }
})

const apiGetMock = vi.fn()
vi.mock('@/lib/axios', () => ({
  api: { get: (...args: unknown[]) => apiGetMock(...args) },
}))

import { Route } from '../sources.index'

const SourcesHealthPage = Route.options.component!

const ROW = {
  id: '11111111-1111-4111-8111-111111111111',
  type: 'REMOTIVE_API',
  enabled: true,
  state: 'HEALTHY',
  reasonCode: null,
  lastCollectedAt: null,
  lastAttemptAt: null,
  lastSuccessAt: null,
  readiness: 'VERIFIED',
  readinessReason: null,
  consecutiveFailures: 0,
  cooldownUntil: null,
  newestItemPublishedAt: null,
  profileSummary: null,
}

function render(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return rtlRender(ui, {
    wrapper: ({ children }) => (
      <I18nTestProvider>
        <QueryClientProvider client={qc}>{children}</QueryClientProvider>
      </I18nTestProvider>
    ),
  })
}

const serve = (sourcingNotice: 'AI_LIMITS_EXHAUSTED' | null) =>
  apiGetMock.mockResolvedValue({ data: { items: [ROW], sourcingNotice } })

describe('/admin/sources — AI-limits banner (H.8)', () => {
  beforeEach(async () => {
    apiGetMock.mockReset()
    await loadCatalog('uk')
  })

  it('shows the owner text in a live region above the health table, the table still rendered', async () => {
    serve('AI_LIMITS_EXHAUSTED')
    render(<SourcesHealthPage />)
    const banner = await screen.findByTestId('job-source-admin-ai-limits')
    expect(banner).toHaveTextContent(
      'Пошук вакансій тимчасово недоступний: ліміти AI-моделей вичерпано. Спробуйте пізніше.',
    )
    expect(screen.getByRole('status')).toContainElement(banner)
    const row = await screen.findByTestId('job-source-health-row')
    // Over the table: the banner comes first in document order.
    expect(banner.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(apiGetMock).toHaveBeenCalledWith('/job-sourcing/admin/sources/health')
  })

  it('shows no banner when the field is null', async () => {
    serve(null)
    render(<SourcesHealthPage />)
    await screen.findByTestId('job-source-health-row')
    expect(screen.queryByTestId('job-source-admin-ai-limits')).toBeNull()
  })
})

describe('/admin/sources — each row links to its own source and shows the runtime stamps', () => {
  beforeEach(async () => {
    apiGetMock.mockReset()
    await loadCatalog('uk')
  })

  it('links the row to /admin/sources/<its id>', async () => {
    apiGetMock.mockResolvedValue({ data: { items: [ROW], sourcingNotice: null } })
    render(<SourcesHealthPage />)
    const row = await screen.findByTestId('job-source-health-row')
    expect(within(row).getByRole('link')).toHaveAttribute('href', `/admin/sources/${ROW.id}`)
  })

  it('shows the last attempt and the last success from the runtime stamps', async () => {
    const attempted = {
      ...ROW,
      lastAttemptAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      lastSuccessAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    }
    apiGetMock.mockResolvedValue({ data: { items: [attempted], sourcingNotice: null } })
    render(<SourcesHealthPage />)
    const row = await screen.findByTestId('job-source-health-row')
    expect(row).toHaveTextContent('Остання спроба:')
    expect(row).toHaveTextContent('Остання вдала:')
    expect(row).not.toHaveTextContent('Ще не запускалося')
  })

  it('says "not run yet" and hides the success line while both stamps are NULL', async () => {
    apiGetMock.mockResolvedValue({ data: { items: [ROW], sourcingNotice: null } })
    render(<SourcesHealthPage />)
    const row = await screen.findByTestId('job-source-health-row')
    expect(row).toHaveTextContent('Ще не запускалося')
    expect(row).not.toHaveTextContent('Остання спроба:')
    expect(row).not.toHaveTextContent('Остання вдала:')
  })

  it('names the reason of a failing source, and shows the newest item only when there is one', async () => {
    const failing = {
      ...ROW,
      state: 'DEGRADED',
      reasonCode: 'VOLUME_DROP',
      newestItemPublishedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    }
    apiGetMock.mockResolvedValue({ data: { items: [failing], sourcingNotice: null } })
    render(<SourcesHealthPage />)
    const row = await screen.findByTestId('job-source-health-row')
    expect(row).toHaveTextContent('Падіння обсягу')
    expect(row).toHaveTextContent('Остання вакансія:')
  })

  it('omits the reason and the newest-item line for a healthy source with no items yet', async () => {
    apiGetMock.mockResolvedValue({ data: { items: [ROW], sourcingNotice: null } })
    render(<SourcesHealthPage />)
    const row = await screen.findByTestId('job-source-health-row')
    expect(row).not.toHaveTextContent('Падіння обсягу')
    expect(row).not.toHaveTextContent('Остання вакансія:')
  })
})
