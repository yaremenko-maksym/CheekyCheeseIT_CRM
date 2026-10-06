/* Node access: the checkbox glyph, divider and avatar have no role/label of their own; reached from the row. */
/* eslint-disable testing-library/no-node-access */
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

import { AddMemberDialog } from '../components/AddMemberDialog'
import type { CandidateUser } from '../components/AddMemberDialog'

function candidate(id: string, role: string, extra: Partial<CandidateUser> = {}): CandidateUser {
  return {
    id,
    displayName: `Name ${id}`,
    email: `${id}@test.dev`,
    role,
    avatarUrl: null,
    avatarDocumentId: null,
    ...extra,
  }
}

function renderDialog(
  candidateUsers: CandidateUser[],
  opts: {
    open?: boolean
    selected?: string[]
    isPending?: boolean
    onToggle?: (id: string) => void
    onSubmit?: () => void
    onOpenChange?: (open: boolean) => void
  } = {},
) {
  const onToggle = opts.onToggle ?? vi.fn()
  const onSubmit = opts.onSubmit ?? vi.fn()
  const onOpenChange = opts.onOpenChange ?? vi.fn()
  render(
    <I18nTestProvider>
      <AddMemberDialog
        open={opts.open ?? true}
        onOpenChange={onOpenChange}
        candidateUsers={candidateUsers}
        selectedUserIds={new Set(opts.selected ?? [])}
        onToggle={onToggle}
        onSubmit={onSubmit}
        isPending={opts.isPending ?? false}
      />
    </I18nTestProvider>,
  )
  return { onToggle, onSubmit, onOpenChange }
}

function rowButton(id: string): HTMLButtonElement {
  return screen.getByText(`Name ${id}`).closest('button') as HTMLButtonElement
}

beforeEach(async () => {
  await loadCatalog('uk')
})

describe('AddMemberDialog rendering', () => {
  it('renders nothing when closed', () => {
    renderDialog([candidate('a', 'HR')], { open: false })
    expect(screen.queryByText('Додати учасника')).toBeNull()
    expect(screen.queryByText('Name a')).toBeNull()
  })

  it('renders title, description and one row per candidate with role badge', () => {
    renderDialog([candidate('a', 'HR'), candidate('b', 'SENIOR'), candidate('c', 'JUNIOR')])
    expect(screen.getByText('Додати учасника')).toBeTruthy()
    expect(screen.getByText('Оберіть, кого додати до команди.')).toBeTruthy()
    expect(screen.getByText('Name a')).toBeTruthy()
    expect(screen.getByText('Name b')).toBeTruthy()
    expect(screen.getByText('Name c')).toBeTruthy()
    expect(screen.getByText('HR')).toBeTruthy()
    expect(screen.getByText('Сеньйор')).toBeTruthy()
    expect(screen.getByText('Джуніор')).toBeTruthy()
    expect(screen.queryByText('Немає користувачів, яких можна додати')).toBeNull()
  })

  it('shows the empty state and no rows for an empty candidate list', () => {
    renderDialog([])
    expect(screen.getByText('Немає користувачів, яких можна додати')).toBeTruthy()
    const list = screen.getByText('Немає користувачів, яких можна додати').parentElement!
    expect(list.querySelectorAll('button')).toHaveLength(0)
  })

  it('renders the avatar image when present and initials otherwise', () => {
    renderDialog([
      candidate('a', 'HR', { avatarUrl: 'https://img.test/a.png' }),
      candidate('b', 'HR', { displayName: 'Ivan Petrenko' }),
    ])
    const img = screen.getByTestId('avatar-image')
    expect(img.getAttribute('src')).toBe('https://img.test/a.png')
    expect(img.getAttribute('alt')).toBe('Name a')
    expect(screen.getAllByTestId('avatar-fallback').map((n) => n.textContent)).toEqual(['NA', 'IP'])
  })

  it('shows the disabled reason only for ineligible candidates', () => {
    renderDialog([candidate('a', 'HR'), candidate('b', 'SENIOR', { disabledReason: 'в команді' })])
    expect(screen.getByText('в команді')).toBeTruthy()
    expect(screen.getAllByText('в команді')).toHaveLength(1)
  })
})

describe('AddMemberDialog selection', () => {
  it('fires onToggle with the candidate id on click', () => {
    const { onToggle } = renderDialog([candidate('a', 'HR'), candidate('b', 'HR')])
    fireEvent.click(rowButton('b'))
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onToggle).toHaveBeenCalledWith('b')
  })

  it('disables ineligible rows and never fires onToggle for them', () => {
    const { onToggle } = renderDialog([
      candidate('a', 'SENIOR', { disabledReason: 'вже є сеньйор' }),
    ])
    const btn = rowButton('a')
    expect(btn.disabled).toBe(true)
    expect(btn.className).toContain('cursor-not-allowed')
    fireEvent.click(btn)
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('keeps eligible rows enabled', () => {
    renderDialog([candidate('a', 'HR')])
    expect(rowButton('a').disabled).toBe(false)
    expect(rowButton('a').className).not.toContain('cursor-not-allowed')
  })

  it('marks only selected eligible rows with a check and highlight', () => {
    renderDialog([candidate('a', 'HR'), candidate('b', 'HR')], { selected: ['a'] })
    expect(rowButton('a').textContent).toContain('✓')
    expect(rowButton('a').className).toContain('bg-primary/10')
    expect(rowButton('b').textContent).not.toContain('✓')
    expect(rowButton('b').className).toContain('hover:bg-muted/50')
    expect(rowButton('b').className).not.toContain('bg-primary/10')
  })

  it('draws no checkbox for a disabled row even if its id is in the selection', () => {
    renderDialog([candidate('a', 'HR', { disabledReason: 'є проєкт' })], { selected: ['a'] })
    expect(rowButton('a').textContent).not.toContain('✓')
    expect(rowButton('a').querySelector('.rounded.border')).toBeNull()
    expect(rowButton('a').className).not.toContain('bg-primary/10')
  })
})

describe('AddMemberDialog divider', () => {
  it('draws one divider before the first disabled row that follows an enabled one', () => {
    renderDialog([
      candidate('a', 'HR'),
      candidate('b', 'HR', { disabledReason: 'в команді' }),
      candidate('c', 'HR', { disabledReason: 'в команді' }),
    ])
    expect(document.querySelectorAll('.my-2.border-t')).toHaveLength(1)
    const divider = document.querySelector('.my-2.border-t') as HTMLElement
    expect(divider.nextElementSibling).toBe(rowButton('b'))
  })

  it('draws no divider when the list starts with a disabled row', () => {
    renderDialog([
      candidate('a', 'HR', { disabledReason: 'в команді' }),
      candidate('b', 'HR', { disabledReason: 'в команді' }),
    ])
    expect(document.querySelectorAll('.my-2.border-t')).toHaveLength(0)
  })

  it('draws no divider when all rows are enabled', () => {
    renderDialog([candidate('a', 'HR'), candidate('b', 'HR')])
    expect(document.querySelectorAll('.my-2.border-t')).toHaveLength(0)
  })
})

describe('AddMemberDialog footer', () => {
  it('disables submit with the plain label when nothing is selected', () => {
    renderDialog([candidate('a', 'HR')])
    const submit = screen.getByRole('button', { name: 'Додати' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
  })

  it('enables submit with the count label and fires onSubmit', () => {
    const { onSubmit } = renderDialog([candidate('a', 'HR'), candidate('b', 'HR')], {
      selected: ['a', 'b'],
    })
    const submit = screen.getByRole('button', { name: 'Додати (2)' }) as HTMLButtonElement
    expect(submit.disabled).toBe(false)
    fireEvent.click(submit)
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('disables submit while the add mutation is pending', () => {
    renderDialog([candidate('a', 'HR')], { selected: ['a'], isPending: true })
    const submit = screen.getByRole('button', { name: 'Додати (1)' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
  })

  it('cancel requests close via onOpenChange(false)', () => {
    const { onOpenChange, onSubmit } = renderDialog([candidate('a', 'HR')], { selected: ['a'] })
    fireEvent.click(screen.getByRole('button', { name: 'Скасувати' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
