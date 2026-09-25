/**
 * ProfileEditFields.tech-placeholder.test.tsx — task-i18n-stage3b (Task 1),
 * mutation-gate coverage.
 *
 * No unit test existed for this component at all before this PR (E2E-only).
 * The tech-stack autocomplete's custom placeholder
 * (`t\`Почніть вводити: React, Node.js…\``) is passed straight through to
 * the underlying input's `placeholder` attribute unconditionally (no
 * tech-selected gate), so a plain render is enough to reach it.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import type { UserProfileDto } from '@crm/shared'

vi.mock('@/hooks/use-user-profile', () => ({
  useUpdateMe: () => ({ mutate: vi.fn(), isPending: false }),
}))

import { ProfileEditFields } from '../ProfileEditFields'

function makeUser(): UserProfileDto {
  return {
    id: 'u1',
    displayName: 'Test User',
    role: 'JUNIOR',
    email: 'test@example.com',
    telegram: null,
    phone: null,
    techStack: [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double, only the fields ProfileEditFields reads are populated
  } as any
}

beforeEach(async () => {
  await loadCatalog('uk')
})

describe('ProfileEditFields — tech-stack autocomplete placeholder', () => {
  it('renders the exact custom placeholder, not the autocomplete’s own generic default', () => {
    render(<ProfileEditFields user={makeUser()} />, { wrapper: I18nTestProvider })
    expect(screen.getByPlaceholderText('Почніть вводити: React, Node.js…')).toBeInTheDocument()
  })
})
