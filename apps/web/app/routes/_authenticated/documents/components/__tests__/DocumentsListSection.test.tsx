import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import type { Document, SessionUser } from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

const useLocaleMock = vi.fn()
const sortDocumentsSpy = vi.fn()

vi.mock('@/lib/i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/i18n')>()
  return {
    ...actual,
    useLocale: () => useLocaleMock(),
  }
})

vi.mock('@/lib/documents-filter-sort', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/documents-filter-sort')>()
  return {
    ...actual,
    sortDocuments: (...args: Parameters<typeof actual.sortDocuments>) => {
      sortDocumentsSpy(...args)
      return actual.sortDocuments(...args)
    },
  }
})

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...props }: { children?: React.ReactNode }) => <a {...props}>{children}</a>,
}))

const mockDoc: Document = {
  id: 'doc-1',
  ownerId: 'owner-1',
  projectId: null,
  category: 'RESUME',
  name: 'resume.pdf',
  originalName: null,
  thumbnailS3Key: null,
  sizeBytes: 1024,
  mimeType: 'application/pdf',
  uploadedBy: 'owner-1',
  uploadedByDisplayName: null,
  deletedAt: null,
  deletedBy: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  invoiceTransactionId: null,
  invoicePendingSignature: false,
  source: undefined,
  statusBadge: null,
}

vi.mock('@/hooks/use-documents', () => ({
  useDocuments: () => ({
    data: [mockDoc],
    isLoading: false,
  }),
}))

vi.mock('@/components/documents/document-list', () => ({
  DocumentList: () => <div data-testid="document-list" />,
}))

vi.mock('@/components/documents/document-row', () => ({
  DocumentRow: () => <div data-testid="document-row" />,
}))

import { DocumentsListSection } from '../DocumentsListSection'

const viewer: SessionUser = {
  id: '00000000-0000-0000-0000-000000000001',
  email: 'viewer@example.com',
  displayName: 'Viewer',
  role: 'ADMIN',
  avatarUrl: null,
  seniorSharePercent: 0,
  locale: 'en',
}

describe('DocumentsListSection — locale-aware sorting', () => {
  beforeEach(async () => {
    await loadCatalog('uk')
    sortDocumentsSpy.mockClear()
    useLocaleMock.mockReturnValue('en')
  })

  it('passes the active locale from useLocale() to sortDocuments', () => {
    useLocaleMock.mockReturnValue('en')

    render(
      <I18nTestProvider>
        <DocumentsListSection
          viewer={viewer}
          categoryFilter="ALL"
          includeDeleted={false}
          statusTab="ACTIVE"
          onOpen={vi.fn()}
          view="grid"
          searchQuery=""
          sortKey="name_asc"
        />
      </I18nTestProvider>,
    )

    expect(sortDocumentsSpy).toHaveBeenCalledWith(
      expect.anything(),
      'name_asc',
      'en',
      expect.anything(),
    )
  })

  it('re-sorts with the updated locale when useLocale() changes', () => {
    useLocaleMock.mockReturnValue('en')

    const { rerender } = render(
      <I18nTestProvider>
        <DocumentsListSection
          viewer={viewer}
          categoryFilter="ALL"
          includeDeleted={false}
          statusTab="ACTIVE"
          onOpen={vi.fn()}
          view="grid"
          searchQuery=""
          sortKey="name_asc"
        />
      </I18nTestProvider>,
    )

    expect(sortDocumentsSpy).toHaveBeenLastCalledWith(
      expect.anything(),
      'name_asc',
      'en',
      expect.anything(),
    )

    useLocaleMock.mockReturnValue('uk')

    rerender(
      <I18nTestProvider>
        <DocumentsListSection
          viewer={viewer}
          categoryFilter="ALL"
          includeDeleted={false}
          statusTab="ACTIVE"
          onOpen={vi.fn()}
          view="grid"
          searchQuery=""
          sortKey="name_asc"
        />
      </I18nTestProvider>,
    )

    expect(sortDocumentsSpy).toHaveBeenLastCalledWith(
      expect.anything(),
      'name_asc',
      'uk',
      expect.anything(),
    )
  })
})
