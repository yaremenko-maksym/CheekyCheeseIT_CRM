/**
 * UX-M-1 (PR #667, design review round 1). The popup's footer link «Всё, что
 * ждёт решения» looked comfortably padded, but the padding sat on the
 * `<footer>` — which is not clickable. The designer measured the `<a>` itself
 * with `getBoundingClientRect` live: 16px tall, below WCAG 2.2 SC 2.5.8 (24px)
 * and far below the ≥44px the design spec §9.2 promised «включая паддинг
 * footer».
 *
 * jsdom has no layout, so this asserts the MECHANISM rather than the measured
 * box: the vertical size must come from classes on the anchor itself, and the
 * anchor must be a block-ish box that those classes can act on. The measured
 * pixel height is re-checked live in the browser (Playwright) — see the
 * fix-round-3 screenshots.
 */
import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router'
import { NotificationsBell } from '../notifications-bell'

vi.mock('@/hooks/use-notifications-api', () => ({
  useNotificationsList: () => ({ data: { items: [], unreadCount: 0 }, isLoading: false }),
  useMarkNotificationRead: () => ({ mutate: vi.fn() }),
  useMarkAllNotificationsRead: () => ({ mutate: vi.fn() }),
  useDeleteNotification: () => ({ mutate: vi.fn() }),
}))

async function renderBellOpen() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={qc}>
        <NotificationsBell />
      </QueryClientProvider>
    ),
  })
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  render(<RouterProvider router={router} />)

  // Radix opens the dropdown on pointerdown, not click.
  const trigger = await screen.findByRole('button', { name: /уведомления/i })
  trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
  trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))

  return screen.findByTestId('notifications-bell-footer-pending-link')
}

describe('NotificationsBell — UX-M-1: the footer link is the hit box, not the footer around it', () => {
  it('carries its own ≥44px vertical floor (min-h-11) and the vertical padding, on the <a> itself', async () => {
    const link = await renderBellOpen()

    expect(link.tagName).toBe('A')
    expect(link.className).toMatch(/\bmin-h-11\b/)
    expect(link.className).toMatch(/\bpy-2\.5\b/)
  })

  it('is a flex box so the floor can actually apply — an inline <a> ignores a height', async () => {
    const link = await renderBellOpen()

    expect(link.className).toMatch(/\bflex\b/)
    expect(link.className).not.toMatch(/\binline-flex\b/)
  })

  it('clicking it closes the popup — the link is a way OUT of the bell, not a second surface', async () => {
    const link = await renderBellOpen()
    expect(screen.getByTestId('notifications-bell-dropdown')).toBeInTheDocument()

    link.click()

    await waitFor(() =>
      expect(screen.queryByTestId('notifications-bell-dropdown')).not.toBeInTheDocument(),
    )
  })

  it('the <footer> no longer holds the vertical padding that used to fake the size', async () => {
    await renderBellOpen()
    const footer = screen.getByRole('contentinfo')

    expect(footer.className).not.toMatch(/\bpy-2\.5\b/)
  })
})
