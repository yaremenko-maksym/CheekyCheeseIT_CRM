/**
 * Unit tests for ContractFillForm — focuses on AutoFilledRow rendering
 * of real resolved variable values (feat: contract-variables-real-values).
 *
 * These tests verify:
 * 1. AutoFilledRow renders variable.value when the variable is not empty.
 * 2. AutoFilledRow does NOT render a value when isEmpty=true (only label).
 * 3. The list renders all auto-variables returned by the API.
 *
 * Interaction / submit flow is covered by E2E; this file tests the display logic.
 */
import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import type { ContractVariablesResponse } from '@crm/shared'

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('@/lib/axios', () => ({
  api: {
    get: vi.fn(),
    patch: vi.fn(),
    post: vi.fn(),
  },
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

// Mock react-router-dom / TanStack Router navigate (used by MissingFieldsBanner)
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}))

// Stub useContractVariables so we control the data without HTTP
vi.mock('../useEmployeeContract', () => ({
  useContractVariables: vi.fn(),
  useSaveContractCustomValues: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useMarkContractReady: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}))

import { useContractVariables } from '../useEmployeeContract'
import { ContractFillForm } from '../ContractFillForm'

const mockUseContractVariables = useContractVariables as ReturnType<typeof vi.fn>

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  return Wrapper
}

function makeVariablesResponse(
  overrides: Partial<ContractVariablesResponse> = {},
): ContractVariablesResponse {
  return {
    variables: [],
    customVariables: [],
    ...overrides,
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ContractFillForm — AutoFilledRow displays resolved values', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the real resolved value for a filled company variable', async () => {
    mockUseContractVariables.mockReturnValue({
      data: makeVariablesResponse({
        variables: [
          {
            key: 'companyName',
            label: 'Название компании',
            source: 'company',
            value: 'Cheeky Cheese IT',
            isEmpty: false,
          },
        ],
      }),
      isLoading: false,
      error: null,
    })

    render(<ContractFillForm userId="user-uuid" savedCustomValues={{}} onReady={() => {}} />, {
      wrapper: makeWrapper(),
    })

    await waitFor(() => {
      // The real value should be visible in the DOM
      expect(screen.getByTestId('auto-var-value-companyName')).toBeTruthy()
      expect(screen.getByTestId('auto-var-value-companyName').textContent).toBe('Cheeky Cheese IT')
    })
  })

  it('renders the real resolved value for a filled user variable (employeeName)', async () => {
    mockUseContractVariables.mockReturnValue({
      data: makeVariablesResponse({
        variables: [
          {
            key: 'employeeName',
            label: 'ФИО сотрудника',
            source: 'user',
            value: 'Коваленко Олена Іванівна',
            isEmpty: false,
          },
        ],
      }),
      isLoading: false,
      error: null,
    })

    render(<ContractFillForm userId="user-uuid" savedCustomValues={{}} onReady={() => {}} />, {
      wrapper: makeWrapper(),
    })

    await waitFor(() => {
      expect(screen.getByTestId('auto-var-value-employeeName').textContent).toBe(
        'Коваленко Олена Іванівна',
      )
    })
  })

  it('does NOT render value element when variable isEmpty=true', async () => {
    mockUseContractVariables.mockReturnValue({
      data: makeVariablesResponse({
        variables: [
          {
            key: 'salary',
            label: 'Зарплата',
            source: 'user',
            value: '',
            isEmpty: true,
          },
        ],
      }),
      isLoading: false,
      error: null,
    })

    render(<ContractFillForm userId="user-uuid" savedCustomValues={{}} onReady={() => {}} />, {
      wrapper: makeWrapper(),
    })

    await waitFor(() => {
      // The value element should NOT be present for empty vars
      expect(screen.queryByTestId('auto-var-value-salary')).toBeNull()
      // The empty badge should appear
      expect(screen.getByTestId('auto-var-empty-salary')).toBeTruthy()
      // Label (description) should still show
      expect(screen.getByTestId('auto-var-label-salary')).toBeTruthy()
    })
  })

  it('renders all auto-variables in the list', async () => {
    mockUseContractVariables.mockReturnValue({
      data: makeVariablesResponse({
        variables: [
          {
            key: 'companyName',
            label: 'Компания',
            source: 'company',
            value: 'Cheeky Cheese IT',
            isEmpty: false,
          },
          {
            key: 'employeeName',
            label: 'ФИО',
            source: 'user',
            value: 'Тест Тестовий',
            isEmpty: false,
          },
          {
            key: 'salary',
            label: 'Зарплата',
            source: 'user',
            value: '',
            isEmpty: true,
          },
        ],
      }),
      isLoading: false,
      error: null,
    })

    render(<ContractFillForm userId="user-uuid" savedCustomValues={{}} onReady={() => {}} />, {
      wrapper: makeWrapper(),
    })

    await waitFor(() => {
      expect(screen.getByTestId('auto-var-row-companyName')).toBeTruthy()
      expect(screen.getByTestId('auto-var-row-employeeName')).toBeTruthy()
      expect(screen.getByTestId('auto-var-row-salary')).toBeTruthy()

      // Filled vars show value
      expect(screen.getByTestId('auto-var-value-companyName').textContent).toBe('Cheeky Cheese IT')
      expect(screen.getByTestId('auto-var-value-employeeName').textContent).toBe('Тест Тестовий')

      // Empty var shows badge, no value element
      expect(screen.queryByTestId('auto-var-value-salary')).toBeNull()
      expect(screen.getByTestId('auto-var-empty-salary')).toBeTruthy()
    })
  })

  it('renders long values (address/requisites) with break-words — no overflow truncation', async () => {
    const longAddress = 'м. Київ, вул. Богдана Хмельницького, буд. 123, кв. 45, 01054'
    mockUseContractVariables.mockReturnValue({
      data: makeVariablesResponse({
        variables: [
          {
            key: 'registrationAddress',
            label: 'Адрес регистрации',
            source: 'user',
            value: longAddress,
            isEmpty: false,
          },
        ],
      }),
      isLoading: false,
      error: null,
    })

    render(<ContractFillForm userId="user-uuid" savedCustomValues={{}} onReady={() => {}} />, {
      wrapper: makeWrapper(),
    })

    await waitFor(() => {
      const el = screen.getByTestId('auto-var-value-registrationAddress')
      expect(el.textContent).toBe(longAddress)
      // Verify break-words class is applied (not overflow:hidden / truncate)
      expect(el.className).toContain('break-words')
    })
  })
})
