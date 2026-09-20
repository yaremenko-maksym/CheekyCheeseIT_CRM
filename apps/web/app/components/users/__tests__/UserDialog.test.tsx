/**
 * task-i18n-stage2-task5. `WizardStep2`'s `isNoTemplate` moved from
 * `error.response?.status === 404 || String(error.message).includes('template')`
 * to `getApiErrorCode(error) === 'CONTRACT_TEMPLATE_MISSING'` — the
 * envelope-by-code check `ContractTab.test.tsx` already covers for its
 * sibling migration. `WizardStep2` was module-private; exported (see
 * `UserDialog.tsx`) so it can be rendered directly here without the full
 * `UserDialog` mock surface `UserDialog.create-wizard.test.tsx` needs.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/components/user-profile/contract/useEmployeeContract', () => ({
  useEmployeeContract: vi.fn(),
  useSaveContractBody: vi.fn().mockReturnValue({ mutate: vi.fn(), isPending: false }),
}))

// Not exercised by these cases (`contract` stays undefined throughout — every
// case here is an error/loading state) but WizardStep2 imports it, so a
// heavy CodeMirror-backed real component must not mount.
vi.mock('@/components/user-profile/contract/ContractEditor', () => ({
  ContractEditor: () => <div data-testid="contract-editor-mock" />,
}))
vi.mock('@/components/user-profile/contract/ContractActionBar', () => ({
  ContractActionBar: () => <div data-testid="contract-action-bar-mock" />,
}))

import { useEmployeeContract } from '@/components/user-profile/contract/useEmployeeContract'
import { WizardStep2 } from '../UserDialog'

function renderStep2() {
  return render(
    <WizardStep2
      userId="senior-uuid"
      onHasContract={vi.fn()}
      body=""
      onBodyChange={vi.fn()}
      isDirty={false}
    />,
  )
}

describe('WizardStep2 — isNoTemplate via API error envelope code', () => {
  it('shows the no-template empty state for a real envelope with CONTRACT_TEMPLATE_MISSING', () => {
    vi.mocked(useEmployeeContract).mockReturnValue({
      data: undefined,
      isLoading: false,
      error: {
        response: {
          status: 404,
          data: {
            statusCode: 404,
            code: 'CONTRACT_TEMPLATE_MISSING',
            params: { role: 'SENIOR' },
            message: 'No active contract template for role SENIOR',
          },
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double, real UseQueryResult has many more fields WizardStep2 never reads
    } as any)
    renderStep2()
    expect(screen.getByText('Нет активного шаблона')).toBeInTheDocument()
  })

  it('does NOT show the no-template empty state for prose without a code', () => {
    vi.mocked(useEmployeeContract).mockReturnValue({
      data: undefined,
      isLoading: false,
      error: { response: { status: 500, data: { message: 'Internal server error' } } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see previous test's identical note
    } as any)
    renderStep2()
    expect(screen.queryByText('Нет активного шаблона')).not.toBeInTheDocument()
  })

  it('does NOT show the no-template empty state while loading, even with a matching code buffered from a previous render', () => {
    vi.mocked(useEmployeeContract).mockReturnValue({
      data: undefined,
      isLoading: true,
      error: {
        response: { data: { statusCode: 404, code: 'CONTRACT_TEMPLATE_MISSING', message: 'x' } },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see previous test's identical note
    } as any)
    renderStep2()
    expect(screen.queryByText('Нет активного шаблона')).not.toBeInTheDocument()
    expect(screen.getByText('Загружаем контракт...')).toBeInTheDocument()
  })
})
