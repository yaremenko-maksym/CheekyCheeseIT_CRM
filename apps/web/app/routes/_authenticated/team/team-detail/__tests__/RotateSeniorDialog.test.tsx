import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'

// Radix AvatarImage renders nothing until the image loads (never in jsdom).
vi.mock('@/components/ui/avatar', () => ({
  Avatar: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  AvatarImage: ({ src, alt }: { src: string; alt?: string }) => (
    <img data-testid="avatar-image" src={src} alt={alt} />
  ),
  AvatarFallback: ({ children }: { children?: ReactNode }) => (
    <span data-testid="avatar-fallback">{children}</span>
  ),
}))

// Radix Select needs pointer-capture APIs jsdom lacks; replace it with a flat
// list that keeps the same value / onValueChange contract.
vi.mock('@/components/ui/select', () => {
  const Ctx = createContext<(v: string) => void>(() => undefined)
  return {
    Select: ({
      value,
      onValueChange,
      children,
    }: {
      value: string
      onValueChange: (v: string) => void
      children?: ReactNode
    }) => (
      <Ctx.Provider value={onValueChange}>
        <div data-testid="select-root" data-value={value}>
          {children}
        </div>
      </Ctx.Provider>
    ),
    SelectTrigger: ({ children, ...rest }: { children?: ReactNode; 'data-testid'?: string }) => (
      <div {...rest}>{children}</div>
    ),
    SelectValue: ({ placeholder }: { placeholder?: string }) => <span>{placeholder}</span>,
    SelectContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    SelectItem: function SelectItem({ value, children }: { value: string; children?: ReactNode }) {
      const onValueChange = useContext(Ctx)
      return (
        <button type="button" data-testid={`option-${value}`} onClick={() => onValueChange(value)}>
          {children}
        </button>
      )
    },
  }
})

import { RotateSeniorDialog } from '../components/RotateSeniorDialog'
import type { UserOption } from '../api'

function senior(id: string, extra: Partial<UserOption> = {}): UserOption {
  return {
    id,
    displayName: `Senior ${id}`,
    email: `${id}@test.dev`,
    role: 'SENIOR',
    avatarUrl: null,
    avatarDocumentId: null,
    ...extra,
  }
}

function renderDialog(
  opts: {
    open?: boolean
    activeSenior?: { displayName: string } | null
    vacantSeniors?: UserOption[]
    newSeniorId?: string
    isPending?: boolean
    onOpenChange?: (open: boolean) => void
    onSelect?: (id: string) => void
    onSubmit?: () => void
  } = {},
) {
  const onOpenChange = opts.onOpenChange ?? vi.fn()
  const onSelect = opts.onSelect ?? vi.fn()
  const onSubmit = opts.onSubmit ?? vi.fn()
  render(
    <I18nTestProvider>
      <RotateSeniorDialog
        open={opts.open ?? true}
        onOpenChange={onOpenChange}
        activeSenior={opts.activeSenior === undefined ? null : opts.activeSenior}
        vacantSeniors={opts.vacantSeniors ?? [senior('a'), senior('b')]}
        newSeniorId={opts.newSeniorId ?? ''}
        onSelect={onSelect}
        onSubmit={onSubmit}
        isPending={opts.isPending ?? false}
      />
    </I18nTestProvider>,
  )
  return { onOpenChange, onSelect, onSubmit }
}

function submitButton(): HTMLButtonElement {
  return screen.getByTestId('team-rotate-senior-submit') as HTMLButtonElement
}

beforeEach(async () => {
  await loadCatalog('uk')
})

describe('RotateSeniorDialog rendering', () => {
  it('renders nothing when closed', () => {
    renderDialog({ open: false })
    expect(screen.queryByTestId('team-rotate-senior-dialog')).toBeNull()
    expect(screen.queryByText('Senior a')).toBeNull()
  })

  it('with an active senior: replace title, warning naming them, and replace submit label', () => {
    renderDialog({ activeSenior: { displayName: 'Old Boss' } })
    expect(screen.getByText('Змінити сеньйора')).toBeTruthy()
    expect(screen.queryByText('Призначити сеньйора')).toBeNull()
    expect(
      screen.getByText(
        'Поточного сеньйора «Old Boss» буде знято з команди. Новий сеньйор має бути без активної команди.',
      ),
    ).toBeTruthy()
    expect(
      screen.queryByText(
        'Оберіть сеньйора без активної команди. Дроп та інші учасники команди залишаються.',
      ),
    ).toBeNull()
    expect(submitButton().textContent).toBe('Змінити')
  })

  it('without an active senior: assign title, assign hint and assign submit label', () => {
    renderDialog({ activeSenior: null })
    expect(screen.getByText('Призначити сеньйора')).toBeTruthy()
    expect(screen.queryByText('Змінити сеньйора')).toBeNull()
    expect(
      screen.getByText(
        'Оберіть сеньйора без активної команди. Дроп та інші учасники команди залишаються.',
      ),
    ).toBeTruthy()
    expect(screen.queryByText(/буде знято з команди/)).toBeNull()
    expect(submitButton().textContent).toBe('Призначити')
  })

  it('lists one option per vacant senior with name and email, plus the placeholder', () => {
    renderDialog({ vacantSeniors: [senior('a'), senior('b')] })
    expect(screen.getByText('Новий сеньйор')).toBeTruthy()
    expect(screen.getByText('— оберіть сеньйора —')).toBeTruthy()
    expect(screen.getByTestId('team-rotate-senior-select')).toBeTruthy()
    expect(screen.getByTestId('option-a')).toBeTruthy()
    expect(screen.getByTestId('option-b')).toBeTruthy()
    expect(screen.getByText('Senior a')).toBeTruthy()
    expect(screen.getByText('a@test.dev')).toBeTruthy()
    expect(screen.getByText('b@test.dev')).toBeTruthy()
    expect(screen.queryByText('Немає сеньйорів без активної команди')).toBeNull()
  })

  it('passes the current selection to the select', () => {
    renderDialog({ newSeniorId: 'b' })
    expect(screen.getByTestId('select-root').getAttribute('data-value')).toBe('b')
  })

  it('renders the avatar image when present and initials otherwise', () => {
    renderDialog({
      vacantSeniors: [
        senior('a', { avatarUrl: 'https://img.test/a.png' }),
        senior('b', { displayName: 'Ivan Petrenko' }),
      ],
    })
    const img = screen.getByTestId('avatar-image')
    expect(img.getAttribute('src')).toBe('https://img.test/a.png')
    expect(img.getAttribute('alt')).toBe('Senior a')
    expect(screen.getAllByTestId('avatar-fallback').map((n) => n.textContent)).toEqual(['SA', 'IP'])
  })

  it('shows the empty state and no select when there are no vacant seniors', () => {
    renderDialog({ vacantSeniors: [] })
    expect(screen.getByText('Немає сеньйорів без активної команди')).toBeTruthy()
    expect(screen.queryByTestId('team-rotate-senior-select')).toBeNull()
    expect(screen.queryByTestId('select-root')).toBeNull()
  })
})

describe('RotateSeniorDialog interaction', () => {
  it('fires onSelect with the picked senior id', () => {
    const { onSelect, onSubmit } = renderDialog()
    fireEvent.click(screen.getByTestId('option-b'))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith('b')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('fires onSubmit once when a senior is selected and not pending', () => {
    const { onSubmit } = renderDialog({ newSeniorId: 'a' })
    expect(submitButton().disabled).toBe(false)
    fireEvent.click(submitButton())
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('disables submit while no senior is selected', () => {
    const { onSubmit } = renderDialog({ newSeniorId: '' })
    expect(submitButton().disabled).toBe(true)
    fireEvent.click(submitButton())
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('disables submit and shows the saving label while pending', () => {
    const { onSubmit } = renderDialog({ newSeniorId: 'a', isPending: true })
    expect(submitButton().disabled).toBe(true)
    expect(submitButton().textContent).toBe('Зберігаємо…')
    fireEvent.click(submitButton())
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('shows the saving label while pending for the assign variant too', () => {
    renderDialog({ activeSenior: { displayName: 'Old Boss' }, newSeniorId: 'a', isPending: true })
    expect(submitButton().textContent).toBe('Зберігаємо…')
  })

  it('cancel requests close via onOpenChange(false) and does not submit or select', () => {
    const { onOpenChange, onSubmit, onSelect } = renderDialog({ newSeniorId: 'a' })
    fireEvent.click(screen.getByRole('button', { name: 'Скасувати' }))
    expect(onOpenChange).toHaveBeenCalledTimes(1)
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onSubmit).not.toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
  })
})
