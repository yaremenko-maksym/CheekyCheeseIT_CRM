/**
 * Characterization tests for `WizardStep2` (create-wizard contract step) after it
 * moved out of `UserDialog.tsx` verbatim. Pins the seed/notify effects and the
 * editor/action-bar wiring that the wizard-level tests only cover indirectly.
 */
import { render as rtlRender, screen, type RenderOptions } from '@testing-library/react'
import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

function render(ui: ReactElement, options?: RenderOptions) {
  return rtlRender(ui, { wrapper: I18nTestProvider, ...options })
}

vi.mock('@/components/user-profile/contract/useEmployeeContract', () => ({
  useEmployeeContract: vi.fn(),
  useSaveContractBody: vi.fn(),
}))

vi.mock('@/components/user-profile/contract/ContractEditor', () => ({
  ContractEditor: (props: { value: string; readOnly?: boolean; frozenBanner?: string }) => (
    <div
      data-testid="editor"
      data-value={props.value}
      data-readonly={String(props.readOnly)}
      data-banner={props.frozenBanner}
    />
  ),
}))
vi.mock('@/components/user-profile/contract/ContractActionBar', () => ({
  ContractActionBar: (props: { isDirty: boolean; isSaving: boolean; onSave: () => void }) => (
    <button
      data-testid="action-bar"
      data-dirty={String(props.isDirty)}
      data-saving={String(props.isSaving)}
      onClick={props.onSave}
    />
  ),
}))

import {
  useEmployeeContract,
  useSaveContractBody,
} from '@/components/user-profile/contract/useEmployeeContract'
import { WizardStep2 } from '../WizardStep2'

const FROZEN_BANNER =
  'Контракт надіслано на підпис — редагування заблоковано, щоб внести правки, поверніть у чернетку'

function mockHook(state: { contract?: object; isLoading?: boolean; error?: unknown }) {
  vi.mocked(useEmployeeContract).mockReturnValue({
    data: state.contract,
    isLoading: state.isLoading ?? false,
    error: state.error ?? null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double, real UseQueryResult has many more fields WizardStep2 never reads
  } as any)
}

const mutate = vi.fn()

function props(over: Partial<React.ComponentProps<typeof WizardStep2>> = {}) {
  return {
    userId: 'u1',
    onHasContract: vi.fn(),
    body: '',
    onBodyChange: vi.fn(),
    isDirty: false,
    ...over,
  }
}

beforeEach(() => {
  loadCatalog('uk')
  mutate.mockReset()
  vi.mocked(useSaveContractBody).mockReturnValue({
    mutate,
    isPending: false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double
  } as any)
})

describe('WizardStep2 — seed + notify effects', () => {
  it('seeds the local body from the contract and reports hasContract=true when body is empty', () => {
    mockHook({ contract: { id: 'c1', status: 'DRAFT', bodyMarkdown: 'FROM-SERVER' } })
    const p = props()
    render(<WizardStep2 {...p} />)
    expect(p.onBodyChange).toHaveBeenCalledWith('FROM-SERVER')
    expect(p.onHasContract).toHaveBeenCalledWith(true)
    expect(p.onHasContract).not.toHaveBeenCalledWith(false)
  })

  it('seeds an empty string when the contract has a null bodyMarkdown', () => {
    mockHook({ contract: { id: 'c1', status: 'DRAFT', bodyMarkdown: null } })
    const p = props()
    render(<WizardStep2 {...p} />)
    expect(p.onBodyChange).toHaveBeenCalledWith('')
  })

  it('does not clobber an in-progress body, but still reports hasContract=true', () => {
    mockHook({ contract: { id: 'c1', status: 'DRAFT', bodyMarkdown: 'FROM-SERVER' } })
    const p = props({ body: 'typed by user' })
    render(<WizardStep2 {...p} />)
    expect(p.onBodyChange).not.toHaveBeenCalled()
    expect(p.onHasContract).toHaveBeenCalledWith(true)
  })

  it('seeds when the contract arrives after the first render', () => {
    mockHook({ isLoading: true })
    const p = props()
    const { rerender } = render(<WizardStep2 {...p} />)
    expect(p.onBodyChange).not.toHaveBeenCalled()
    expect(p.onHasContract).not.toHaveBeenCalled()
    mockHook({ contract: { id: 'c1', status: 'DRAFT', bodyMarkdown: 'LATE' } })
    rerender(<WizardStep2 {...p} />)
    expect(p.onBodyChange).toHaveBeenCalledWith('LATE')
    expect(p.onHasContract).toHaveBeenCalledWith(true)
  })

  it('reports hasContract=false when the fetch errors, and nothing while merely loading', () => {
    mockHook({ isLoading: true })
    const p = props()
    const { rerender } = render(<WizardStep2 {...p} />)
    expect(p.onHasContract).not.toHaveBeenCalled()
    mockHook({ error: { response: { status: 500, data: { message: 'boom' } } } })
    rerender(<WizardStep2 {...p} />)
    expect(p.onHasContract).toHaveBeenCalledTimes(1)
    expect(p.onHasContract).toHaveBeenCalledWith(false)
    expect(p.onBodyChange).not.toHaveBeenCalled()
  })
})

describe('WizardStep2 — editor + action bar wiring', () => {
  it('does not render the editor while loading, even if a contract is buffered', () => {
    mockHook({ isLoading: true, contract: { id: 'c1', status: 'DRAFT', bodyMarkdown: 'x' } })
    render(<WizardStep2 {...props()} />)
    expect(screen.queryByTestId('editor')).not.toBeInTheDocument()
    expect(screen.queryByTestId('action-bar')).not.toBeInTheDocument()
  })

  it('does not render the editor when there is no contract', () => {
    mockHook({})
    render(<WizardStep2 {...props()} />)
    expect(screen.queryByTestId('editor')).not.toBeInTheDocument()
  })

  it('shows the contract body when local body is empty, the local body once typed', () => {
    mockHook({ contract: { id: 'c1', status: 'DRAFT', bodyMarkdown: 'SERVER' } })
    const { unmount } = render(<WizardStep2 {...props({ body: '' })} />)
    expect(screen.getByTestId('editor')).toHaveAttribute('data-value', 'SERVER')
    unmount()
    render(<WizardStep2 {...props({ body: 'EDITED' })} />)
    expect(screen.getByTestId('editor')).toHaveAttribute('data-value', 'EDITED')
  })

  it('DRAFT: editable, no frozen banner', () => {
    mockHook({ contract: { id: 'c1', status: 'DRAFT', bodyMarkdown: 'x' } })
    render(<WizardStep2 {...props()} />)
    const editor = screen.getByTestId('editor')
    expect(editor).toHaveAttribute('data-readonly', 'false')
    expect(editor).not.toHaveAttribute('data-banner')
  })

  it('READY_TO_SIGN: read-only with the frozen banner', () => {
    mockHook({ contract: { id: 'c1', status: 'READY_TO_SIGN', bodyMarkdown: 'x' } })
    render(<WizardStep2 {...props()} />)
    const editor = screen.getByTestId('editor')
    expect(editor).toHaveAttribute('data-readonly', 'true')
    expect(editor).toHaveAttribute('data-banner', FROZEN_BANNER)
  })

  it('other non-DRAFT status: read-only without the banner', () => {
    mockHook({ contract: { id: 'c1', status: 'SIGNED', bodyMarkdown: 'x' } })
    render(<WizardStep2 {...props()} />)
    const editor = screen.getByTestId('editor')
    expect(editor).toHaveAttribute('data-readonly', 'true')
    expect(editor).not.toHaveAttribute('data-banner')
  })

  it('action bar receives isDirty/isSaving and Save mutates the current body', () => {
    mockHook({ contract: { id: 'c1', status: 'DRAFT', bodyMarkdown: 'x' } })
    vi.mocked(useSaveContractBody).mockReturnValue({
      mutate,
      isPending: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double
    } as any)
    render(<WizardStep2 {...props({ body: 'BODY', isDirty: true })} />)
    const bar = screen.getByTestId('action-bar')
    expect(bar).toHaveAttribute('data-dirty', 'true')
    expect(bar).toHaveAttribute('data-saving', 'true')
    bar.click()
    expect(mutate).toHaveBeenCalledWith('BODY')
  })
})
