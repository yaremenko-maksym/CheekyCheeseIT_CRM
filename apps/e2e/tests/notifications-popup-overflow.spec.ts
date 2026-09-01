/**
 * notifications-popup-overflow.spec.ts
 *
 * Positional plan item 1 (2026-08-30 cascade session) — the notifications
 * bell popover is fixed at 320px (`w-80`, see NotificationsBell) but two
 * holes let content escape that width once a notification carries an
 * unbroken run of characters (a wallet address, a long link, a filename
 * with no spaces):
 *
 *   1. `notifications-list` (<ul>) declares only `overflow-y-auto` — per
 *      the CSS overflow spec, once one axis is non-`visible` the browser
 *      computes the other as `auto` too, so an internal element wider than
 *      320px shows up as a horizontal scrollbar instead of being contained.
 *   2. The notification body clamps to two lines via `line-clamp-2`, which
 *      limits LINE COUNT, not character width — it does not confer
 *      `overflow-wrap: break-word`, so an unbreakable run of characters is
 *      not wrapped and can widen its box past the 320px popover.
 *
 * Not reproducible on today's live data — all three existing notification
 * types carry short, space-separated text. This spec manufactures the
 * shape deliberately so the regression is caught before new notification
 * types (transaction amounts + wallet addresses) ship it for real.
 */
import { test, expect, API_RE } from './fixtures'

// Deliberately unbreakable — no spaces or hyphens at any wrap-safe
// position — and long enough that it MUST widen a 320px box if nothing
// stops it. Modeled on the wallet-address / long-identifier shape called
// out in the task (a paid-transaction notification carrying an address).
const UNBREAKABLE_BODY = 'TxRef' + 'a1b2c3d4e5f6a7b8c9d0'.repeat(10) + 'End'

function makeOverflowNotification(): object {
  return {
    id: 'notif-overflow-1',
    userId: 'irrelevant-for-this-spec',
    type: 'INVOICE_SIGN_REQUIRED',
    title: 'Требуется подпись инвойса',
    body: UNBREAKABLE_BODY,
    link: null,
    readAt: null,
    createdAt: '2026-08-30T12:00:00.000Z',
  }
}

test.describe('Notifications popup — horizontal overflow (positional plan item 1)', () => {
  test('an unbreakable-string notification does not create horizontal scroll in the popover', async ({
    asSenior,
  }) => {
    // Override the default `mockAuthAs` notifications route — registered
    // here, AFTER the fixture ran, so it wins (Playwright route matching is
    // LIFO; same pattern as invoices-signing-flow.spec.ts's mockInvoiceFlow).
    await asSenior.route(new RegExp(`${API_RE}/notifications(\\?.*)?$`), (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [makeOverflowNotification()], unreadCount: 1 }),
      }),
    )

    // 320px is the mandatory mobile-class test width (responsive-design.md).
    // The popover itself is fixed-width (`w-80`) regardless of viewport, so
    // the bug reproduces at any width — 320px is asserted separately here
    // because the project rule requires the mobile class be proven live.
    await asSenior.setViewportSize({ width: 320, height: 800 })
    await asSenior.goto('/')

    const bell = asSenior.getByTestId('notifications-bell-trigger')
    await expect(bell).toBeVisible()
    await bell.click()

    const list = asSenior.getByTestId('notifications-list')
    await expect(list).toBeVisible()
    await expect(asSenior.getByText('Требуется подпись инвойса')).toBeVisible()

    // The real assertion: the scrollable list must not have grown a
    // horizontal scrollbar. scrollWidth > clientWidth means some descendant
    // rendered wider than the 320px popover instead of wrapping/clipping.
    const overflow = await list.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }))
    expect(
      overflow.scrollWidth - overflow.clientWidth,
      `notifications-list scrollWidth=${overflow.scrollWidth} clientWidth=${overflow.clientWidth} — ` +
        `a positive delta means the popover grew horizontal overflow instead of wrapping/clipping the ` +
        `unbreakable body string within its 320px box`,
    ).toBeLessThanOrEqual(1)
  })
})
