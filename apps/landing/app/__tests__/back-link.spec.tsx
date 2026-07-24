/**
 * BackLink — wraps `<Link>` for semantically "back" navigations, forcing the
 * lightweight page-transition variant (docs/design/landing-redesign.md
 * §M.3 step 3). Same lightweight router-harness pattern as
 * `careers-teaser.spec.tsx` — `<Link>` needs a real router context to render.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { BackLink } from '@/components/marketing/back-link'
import * as pageTransition from '@/lib/page-transition'

function renderBackLink() {
  const rootRoute = createRootRoute({
    component: () => (
      <div>
        <BackLink to="/careers" className="test-back-link">
          All roles
        </BackLink>
        <Outlet />
      </div>
    ),
  })
  const careersRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/careers',
    component: () => <div>Careers page</div>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([careersRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  return render(<RouterProvider router={router} />)
}

describe('BackLink', () => {
  it('marks the next page-transition as the lightweight variant on click, before navigating', async () => {
    const spy = vi.spyOn(pageTransition, 'markNextTransitionLight')
    renderBackLink()
    const user = userEvent.setup()

    const link = await screen.findByRole('link', { name: 'All roles' })
    await user.click(link)

    expect(spy).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('Careers page')).toBeTruthy()
  })

  it('forwards className and children through to the underlying <Link>', async () => {
    renderBackLink()
    const link = await screen.findByRole('link', { name: 'All roles' })
    expect(link.className).toContain('test-back-link')
  })
})
