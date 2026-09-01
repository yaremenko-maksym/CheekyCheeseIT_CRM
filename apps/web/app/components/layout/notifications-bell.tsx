/**
 * NotificationsBell — header bell + dropdown for in-app notifications.
 *
 * Round 4 of the Invoice Signing Epic replaces the PHASE 1 in-memory
 * `NotificationsContext` stub with a real backend feed:
 *   - `useNotificationsList()` polls `GET /api/notifications?limit=10` every
 *     30s and returns `{ items, unreadCount }`.
 *   - Clicking a row calls `PATCH /api/notifications/:id/read` and (if the
 *     row has a `link`) navigates the user to it.
 *   - Header footer button: «Прочитать всё» → `PATCH /read-all`.
 *
 * The previous client-only context is kept in
 * `apps/web/app/context/notifications.tsx` for backward compatibility with
 * its existing spec, but it's no longer mounted in the header. Future code
 * can either drop it entirely or repurpose it for ephemeral toast-like
 * notifications.
 */
import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { formatDistanceToNow } from 'date-fns'
import { ru } from 'date-fns/locale'
import { Bell, CheckCheck, FileSignature, Inbox, Trash2 } from 'lucide-react'
import type { Notification } from '@crm/shared'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import {
  useNotificationsList,
  useDeleteNotification,
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
} from '@/hooks/use-notifications-api'

// ---------------------------------------------------------------------------
// Per-type icon — keep small and tinted by accent color
// ---------------------------------------------------------------------------

function TypeIcon({ type }: { type: Notification['type'] }) {
  if (type === 'INVOICE_SIGN_REQUIRED') {
    return <FileSignature className="h-4 w-4 text-amber-300" />
  }
  // INVOICE_SIGNED — emerald
  return <FileSignature className="h-4 w-4 text-emerald-300" />
}

function fmtRelative(iso: string): string {
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true, locale: ru })
  } catch {
    return iso
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface NotificationsBellProps {
  /**
   * Gate flag: when false the underlying query is disabled and no network
   * request is issued. Use `useOnboardingGate().isComplete` to populate this
   * so the bell stays silent while the user is still in the onboarding wizard
   * (avoids 403 spam from pre-onboarding API calls).
   *
   * Defaults to `true` for backward compatibility.
   */
  enabled?: boolean
}

export function NotificationsBell({ enabled = true }: NotificationsBellProps) {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const { data, isLoading } = useNotificationsList({ limit: 10, enabled })
  const markRead = useMarkNotificationRead()
  const markAllRead = useMarkAllNotificationsRead()
  const deleteNotification = useDeleteNotification()

  const items = data?.items ?? []
  const unreadCount = data?.unreadCount ?? 0
  const hasUnread = unreadCount > 0

  // Click on an item: mark read first (fire-and-forget — the UI optimistically
  // reflects the action by closing the dropdown) + navigate if there is a
  // deep link.
  function handleItemClick(item: Notification) {
    if (!item.readAt) {
      markRead.mutate(item.id)
    }
    setOpen(false)
    if (item.link) {
      // The notification.link is a relative front-end path stored as a
      // VARCHAR(500). Backend invoice notifications now emit
      // `/documents?category=INVOICE&openTx=<txId>` — opens the
      // `/documents` page with the INVOICE category filter active and
      // the invoice dialog auto-popped via the `openTx` deep-link param.
      //
      // Legacy compat (CRM re-root /crm/* → /*): historic rows stored before
      // the re-root carry a leading `/crm` prefix — strip it so they resolve
      // against the new root-mounted routes. Even older rows (before batch 2)
      // use the path-style `/crm/finance/invoices/<txId>`; we rewrite that
      // shape to the documents deep-link first, then prefix-strip handles the
      // remaining `/crm/*` links generically.
      let target = item.link
      const legacyInvoice = target.match(/^\/crm\/finance\/invoices\/([0-9a-f-]{36})$/i)
      if (legacyInvoice) {
        target = `/documents?category=INVOICE&openTx=${legacyInvoice[1]}`
      } else if (target === '/crm' || target.startsWith('/crm/')) {
        target = target.slice('/crm'.length) || '/'
      }
      try {
        // `navigate` accepts `to: string` for non-typed paths.
        void navigate({ to: target as never })
      } catch {
        window.location.assign(target)
      }
    }
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative h-11 w-11 cursor-pointer sm:h-9 sm:w-9"
          aria-label="Уведомления"
          data-testid="notifications-bell-trigger"
        >
          <Bell className="h-4 w-4" />
          {hasUnread ? (
            <span
              className="absolute right-1 top-1 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold leading-none text-primary-foreground"
              data-testid="notifications-bell-badge"
            >
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-80 p-0"
        data-testid="notifications-bell-dropdown"
      >
        <header className="flex items-center justify-between border-b border-border/50 px-4 py-2.5">
          <h3 className="text-sm font-semibold tracking-tight">Уведомления</h3>
          <Button
            variant="ghost"
            size="sm"
            disabled={!hasUnread || markAllRead.isPending}
            onClick={() => markAllRead.mutate()}
            className="h-7 cursor-pointer gap-1 px-2 text-xs"
            data-testid="notifications-mark-all-read"
          >
            <CheckCheck className="h-3 w-3" />
            Прочитать всё
          </Button>
        </header>

        {isLoading ? (
          <div className="space-y-2 p-3">
            <Skeleton className="h-12 rounded-md" />
            <Skeleton className="h-12 rounded-md" />
            <Skeleton className="h-12 rounded-md" />
          </div>
        ) : items.length === 0 ? (
          <div
            className="flex flex-col items-center justify-center px-4 py-10 text-center"
            data-testid="notifications-empty"
          >
            <Inbox className="h-8 w-8 text-muted-foreground/40" />
            <p className="mt-2 text-sm font-medium">Уведомлений нет</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Здесь появятся события об инвойсах и других задачах
            </p>
          </div>
        ) : (
          <ul
            className="max-h-[28rem] divide-y divide-border/40 overflow-y-auto overflow-x-hidden"
            data-testid="notifications-list"
          >
            {items.map((n) => (
              <li key={n.id}>
                {/* Row wraps a click-to-open <button> + a sibling Trash
                    <button>. Two buttons in a `flex` container avoids the
                    invalid-HTML "button inside button" problem while keeping
                    each interactive zone trivially testable. */}
                <div
                  className={cn(
                    'group/notif relative flex items-start transition-colors hover:bg-accent/40',
                    !n.readAt && 'bg-primary/5',
                  )}
                  data-testid={`notification-item-${n.id}`}
                >
                  <button
                    type="button"
                    onClick={() => handleItemClick(n)}
                    className="flex flex-1 cursor-pointer items-start gap-3 px-4 py-3 text-left"
                    data-testid={`notification-item-${n.id}-open`}
                  >
                    <TypeIcon type={n.type} />
                    <div className="min-w-0 flex-1">
                      <p
                        className={cn(
                          'truncate text-sm',
                          n.readAt ? 'font-normal text-muted-foreground' : 'font-medium',
                        )}
                      >
                        {n.title}
                      </p>
                      {/* `wrap-anywhere` (overflow-wrap: anywhere), not `break-words`
                          (overflow-wrap: break-word) — break-word is explicitly
                          excluded from min-content intrinsic-size calculations per the
                          CSS Text spec, so an unbreakable run (a wallet address, a long
                          link) still forces this flex-nested box to grow to fit it on
                          one line before break-word ever gets a chance to wrap.
                          wrap-anywhere factors mid-word breaks into that intrinsic-size
                          calculation, so the box actually stays inside the 320px
                          popover instead of growing past it. */}
                      {n.body ? (
                        <p className="mt-0.5 line-clamp-2 wrap-anywhere text-xs text-muted-foreground">
                          {n.body}
                        </p>
                      ) : null}
                      <p className="mt-1 text-[11px] text-muted-foreground/70">
                        {fmtRelative(n.createdAt)}
                      </p>
                    </div>
                    {!n.readAt ? (
                      <span aria-hidden className="mt-1 h-2 w-2 shrink-0 rounded-full bg-primary" />
                    ) : null}
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      deleteNotification.mutate(n.id)
                    }}
                    disabled={deleteNotification.isPending}
                    aria-label="Удалить уведомление"
                    title="Удалить уведомление"
                    className="mr-2 mt-3 inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover/notif:opacity-100 focus-visible:opacity-100 disabled:cursor-not-allowed disabled:opacity-40"
                    data-testid={`notification-item-${n.id}-delete`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
