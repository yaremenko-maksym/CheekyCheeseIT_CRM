/**
 * ProfileNameLink — viewer-role gated profile navigation.
 *
 * task-drop-profile-lockdown (RBAC, OWASP A01): DROP has NO access to any other
 * user's profile. ProfileNameLink renders the name as PLAIN TEXT (no anchor) for
 * a DROP viewer and as a navigable <Link to="/crm/profile/$userId"> for every
 * other role.
 *
 * Setup: minimal in-memory TanStack Router (one __root__ route) so the inner
 * `<Link>` can build a valid <a href="…"> for the non-DROP cases. Mirrors the
 * ProjectRow.test.tsx convention.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router'
import type { Role } from '@/lib/route-access'
import { ProfileNameLink } from '../ProfileNameLink'

const TARGET_ID = '00000000-0000-0000-0000-0000000000a1'

function renderForRole(role: Role) {
  const rootRoute = createRootRoute({
    component: () => (
      <ProfileNameLink userId={TARGET_ID} viewerRole={role} testId="profile-name-link">
        Иван Иванов
      </ProfileNameLink>
    ),
  })
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  return render(<RouterProvider router={router} />)
}

describe('ProfileNameLink', () => {
  it('DROP viewer — renders PLAIN TEXT (span), NOT a profile link', async () => {
    renderForRole('DROP')
    const el = await screen.findByTestId('profile-name-link')
    // Plain text → <span>, never an anchor, no href.
    expect(el.tagName).toBe('SPAN')
    expect(el).not.toHaveAttribute('href')
    expect(el).toHaveTextContent('Иван Иванов')
    // No navigable anchor for the name anywhere in the output.
    expect(screen.queryByRole('link')).toBeNull()
  })

  it.each<Role>(['ADMIN', 'SENIOR', 'HR', 'ACCOUNTANT', 'JUNIOR'])(
    '%s viewer — renders a profile <Link> to /crm/profile/$userId',
    async (role) => {
      renderForRole(role)
      const el = await screen.findByTestId('profile-name-link')
      expect(el.tagName).toBe('A')
      expect(el).toHaveAttribute('href', `/crm/profile/${TARGET_ID}`)
      expect(el).toHaveTextContent('Иван Иванов')
    },
  )
})
