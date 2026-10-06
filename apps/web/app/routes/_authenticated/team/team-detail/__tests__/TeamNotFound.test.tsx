import type { ReactNode } from 'react'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    Link: ({ children, to }: { children?: ReactNode; to?: string }) => (
      <a href={to ?? '#'}>{children}</a>
    ),
  }
})

import { TeamNotFound } from '../components/TeamNotFound'

function renderNotFound(userRole: string | undefined) {
  return render(
    <I18nTestProvider>
      <TeamNotFound userRole={userRole} />
    </I18nTestProvider>,
  )
}

beforeEach(async () => {
  await loadCatalog('uk')
})

describe('TeamNotFound', () => {
  it('renders the not-found copy and a back link to /team for a non-DROP role', () => {
    renderNotFound('ADMIN')
    const root = screen.getByTestId('team-not-found')
    expect(root.textContent).toContain('Команду не знайдено')
    expect(root.textContent).toContain('Можливо, у вас немає доступу до цієї команди')
    const link = screen.getByRole('link')
    expect(link.getAttribute('href')).toBe('/team')
    expect(link.textContent).toBe('Повернутися до списку')
  })

  it('shows the back link when the role is not yet known', () => {
    renderNotFound(undefined)
    expect(screen.getByRole('link').getAttribute('href')).toBe('/team')
  })

  it('hides the back link for DROP but keeps the copy', () => {
    renderNotFound('DROP')
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByTestId('team-not-found').textContent).toContain('Команду не знайдено')
  })
})
