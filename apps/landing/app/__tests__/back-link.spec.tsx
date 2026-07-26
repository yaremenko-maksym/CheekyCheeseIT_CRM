/**
 * BackLink — plain `<Link>` wrapper for semantically "back" navigations
 * (task-landing-remove-page-transitions.md removed the transition-direction
 * marking it used to do on click, docs/design/landing-redesign.md §M v3.1,
 * now SUPERSEDED). Same lightweight router-harness pattern as
 * `careers-teaser.spec.tsx` — `<Link>` needs a real router context to render.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { BackLink } from '@/components/marketing/back-link'

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
  it('navigates to the target route on click', async () => {
    renderBackLink()
    const user = userEvent.setup()

    const link = await screen.findByRole('link', { name: 'All roles' })
    await user.click(link)

    expect(await screen.findByText('Careers page')).toBeTruthy()
  })

  it('forwards className and children through to the underlying <Link>', async () => {
    renderBackLink()
    const link = await screen.findByRole('link', { name: 'All roles' })
    expect(link.className).toContain('test-back-link')
  })
})
