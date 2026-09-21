/**
 * CascadeUnarchiveModal (`components/archive/`) — shown when
 * `POST /projects/:id/unarchive` returns 409 with `requiresCascade: true`.
 * Lists the related entities (senior + team pair) that must also be
 * unarchived.
 *
 * task-i18n-stage3a (Task 1), fix-round 2 (MUT-1/MUT-2). ZERO tests
 * existed for this file before this round — the fix-round-1 mutation-gate
 * follow-up flagged it in "Remaining gap, itemized" (2 survived, 1
 * no-coverage) as pre-existing Steps 1-7 debt never given dedicated
 * coverage.
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { CascadeUnarchiveModal } from '../CascadeUnarchiveModal'
import type { UnarchiveCascadeEntity } from '@/hooks/use-archive'

beforeEach(async () => {
  vi.clearAllMocks()
  await loadCatalog('uk')
})

function renderModal(entities: UnarchiveCascadeEntity[], onConfirm = vi.fn(), onCancel = vi.fn()) {
  return render(
    <I18nTestProvider>
      <CascadeUnarchiveModal
        projectName="Alpha"
        entities={entities}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    </I18nTestProvider>,
  )
}

describe('CascadeUnarchiveModal', () => {
  it('names the project being restored, immediately followed by the rest of the sentence with no gap', () => {
    renderModal([{ type: 'user', id: 'u1', name: 'Іван Петренко' }])
    // Pins the boundary between the bolded project name and the sentence
    // that continues right after it — the JSX separates them with a `{' '}`
    // expression; if that space were dropped the two words would run
    // together ("Alphaпотрібно").
    const paragraph = screen.getByText(/Для відновлення проєкту/)
    expect(paragraph.textContent).toBe(
      'Для відновлення проєкту Alpha потрібно також відновити пару:',
    )
  })

  it('labels a user-type entity "Користувач (сеньйор)", not the team label', () => {
    renderModal([{ type: 'user', id: 'u1', name: 'Іван Петренко' }])
    expect(screen.getByText('Користувач (сеньйор)')).toBeInTheDocument()
    expect(screen.queryByText('Команда')).not.toBeInTheDocument()
    expect(screen.getByText('Іван Петренко')).toBeInTheDocument()
  })

  it('labels a team-type entity "Команда", not the user label', () => {
    renderModal([{ type: 'team', id: 't1', name: 'Проєкт Alpha' }])
    expect(screen.getByText('Команда')).toBeInTheDocument()
    expect(screen.queryByText('Користувач (сеньйор)')).not.toBeInTheDocument()
    expect(screen.getByText('Проєкт Alpha')).toBeInTheDocument()
  })

  it('renders BOTH entities with their own distinct labels when given the full cascade pair', () => {
    renderModal([
      { type: 'user', id: 'u1', name: 'Іван Петренко' },
      { type: 'team', id: 't1', name: 'Проєкт Alpha' },
    ])
    expect(screen.getByTestId('cascade-entity-user')).toBeInTheDocument()
    expect(screen.getByTestId('cascade-entity-team')).toBeInTheDocument()
    expect(screen.getByText('Користувач (сеньйор)')).toBeInTheDocument()
    expect(screen.getByText('Команда')).toBeInTheDocument()
  })
})
