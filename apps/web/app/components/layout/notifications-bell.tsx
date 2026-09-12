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
import {
  Bell,
  CheckCheck,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleX,
  FileSignature,
  FolderPlus,
  Inbox,
  Trash2,
  Users,
  Wallet,
} from 'lucide-react'
import type { Notification } from '@crm/shared'
import { renderNotification } from '@crm/shared'
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
  // task-notification-types-producers (позиция 6). Значок — единственная часть
  // строки, которую клиент выбирает НЕ по реестру подписей: реестр отвечает за
  // текст, здесь — за то, чтобы событие узнавалось до чтения. Неизвестный тип
  // получает нейтральный кружок, а не падение (AC2).
  switch (type) {
    case 'INVOICE_SIGN_REQUIRED':
      return <FileSignature className="h-4 w-4 text-amber-300" />
    case 'INVOICE_SIGNED':
      return <FileSignature className="h-4 w-4 text-emerald-300" />
    case 'TRANSACTION_ADDED':
    case 'TRANSACTION_STATUS_CHANGED':
      return <Wallet className="h-4 w-4 text-sky-300" />
    case 'TEAM_MEMBER_ADDED':
    case 'TEAM_NEW_MEMBER':
      return <Users className="h-4 w-4 text-violet-300" />
    case 'PROJECT_MEMBER_ADDED':
      return <FolderPlus className="h-4 w-4 text-violet-300" />
    case 'PROJECT_CONFIRM_REQUIRED':
    case 'SHARE_CONFIRM_REQUIRED':
    case 'DOCUMENT_SIGN_REQUIRED':
      // Семейство «Ждёт решения» — один значок на все три, потому что от
      // человека во всех трёх случаях ждут одного и того же: решения.
      return <CircleAlert className="h-4 w-4 text-amber-300" />
    case 'APPROVAL_CONFIRMED':
      return <CircleCheck className="h-4 w-4 text-emerald-300" />
    case 'APPROVAL_REJECTED':
      return <CircleX className="h-4 w-4 text-rose-300" />
    default:
      return <Circle className="h-4 w-4 text-muted-foreground/60" />
  }
}

/**
 * Ссылки, сохранённые до перекорчёвки CRM из `/crm/*` в корень, и совсем
 * старые path-ссылки на инвойс. Логика не менялась — только переехала из
 * `handleItemClick` в отдельную функцию, потому что теперь адрес приходит из
 * реестра (`notificationActions`), а не читается из строки напрямую.
 */
function normalizeLegacyLink(link: string): string {
  const legacyInvoice = link.match(/^\/crm\/finance\/invoices\/([0-9a-f-]{36})$/i)
  if (legacyInvoice) return `/documents?category=INVOICE&openTx=${legacyInvoice[1]}`
  if (link === '/crm' || link.startsWith('/crm/')) return link.slice('/crm'.length) || '/'
  return link
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

  /**
   * Клик по строке: сначала отметить прочитанной (fire-and-forget — попап
   * закрывается сразу), затем перейти.
   *
   * task-notification-types-producers (позиция 6, §7.1): адрес БОЛЬШЕ НЕ
   * читается из строки — его выводит реестр по типу и идентификаторам объекта
   * (`notificationActions`). Колонка `link` осталась источником только для трёх
   * старых типов, и реестр для них возвращает ровно её.
   *
   * `href === null` — объекта больше нет (§7.4): строку отмечаем прочитанной,
   * попап закрываем, но никуда не ведём. Белого экрана вместо честного ответа
   * не будет, потому что перехода не будет вовсе.
   */
  function handleItemClick(item: Notification, href: string | null) {
    if (!item.readAt) {
      markRead.mutate(item.id)
    }
    setOpen(false)
    if (href === null) return
    const target = normalizeLegacyLink(href)
    try {
      // `navigate` accepts `to: string` for non-typed paths.
      void navigate({ to: target as never })
    } catch {
      window.location.assign(target)
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
            {/* COPY-M-6 = UX-M-1 (copy + design review круг 1, #664): строка
              досталась от #620 и диффом не тронута, но именно этот дифф
              сделал её ложной — попап теперь несёт не только инвойсы, а
              «инвойс» вдобавок слово из `_Избегать_` (CONTEXT.md: «Счёт»). */}
            <p className="mt-1 text-xs text-muted-foreground">
              Здесь появятся события по вашим проектам, деньгам и документам
            </p>
          </div>
        ) : (
          <ul
            className="max-h-[28rem] divide-y divide-border/40 overflow-y-auto overflow-x-hidden"
            data-testid="notifications-list"
          >
            {items.map((n) => {
              // §7.1: заголовок, подробности и подписи кнопок выводятся ЗДЕСЬ,
              // по типу — не читаются из базы. Неизвестный тип и битые данные
              // дают общий вид по сохранённым `title`/`body`/`link`, а не
              // роняют попап (AC2).
              const view = renderNotification(n)
              const action = view.actions[0] ?? null
              return (
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
                      onClick={() => handleItemClick(n, action?.href ?? null)}
                      // `min-w-0` на САМОЙ кнопке, а не только на внутреннем
                      // блоке: кнопка — flex-элемент строки, и её
                      // автоматический минимум (`min-width: auto`) считается по
                      // min-content содержимого. Заголовок несёт `truncate`
                      // (`white-space: nowrap`), чей min-content равен ПОЛНОЙ
                      // ширине строки, — поэтому кнопка растягивалась под
                      // самый длинный заголовок и вылезала за 320 px, а
                      // `overflow-x-hidden` списка просто срезал хвост. То же
                      // семейство, что чинил #620, только на уровень выше:
                      // там лечили перенос слов, здесь — способность
                      // контейнера сжаться.
                      className="flex min-w-0 flex-1 cursor-pointer items-start gap-3 px-4 py-3 text-left"
                      data-testid={`notification-item-${n.id}-open`}
                    >
                      <TypeIcon type={n.type} />
                      <div className="min-w-0 flex-1">
                        <p
                          className={cn(
                            'truncate text-sm',
                            n.readAt ? 'font-normal text-muted-foreground' : 'font-medium',
                          )}
                          data-testid={`notification-item-${n.id}-title`}
                        >
                          {view.title}
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
                        {view.detail ? (
                          <p
                            // UX-L-1 (design review круг 1, #664): `tabular-nums`
                            // по `foundation.md` §4 — суммы/проценты в этой
                            // строке не должны «прыгать» на непропорциональных
                            // цифрах; влияет только на цифровые глифы, не на
                            // буквы вокруг них. `whitespace-pre-wrap`
                            // (COPY-H-6/COPY-M-3): `describeNotification`
                            // выносит причину отказа отдельной строкой (`\n`)
                            // — без этого класса браузер схлопнул бы перевод
                            // строки в пробел, и разделение исчезло бы молча.
                            className="mt-0.5 line-clamp-2 wrap-anywhere whitespace-pre-wrap text-xs tabular-nums text-muted-foreground"
                            data-testid={`notification-item-${n.id}-detail`}
                          >
                            {view.detail}
                          </p>
                        ) : null}
                        {/* Подпись кнопки — тоже из реестра. Отдельная строка, а
                          не настоящая вложенная кнопка: вся строка и так
                          кликабельна, а <button> внутри <button> — невалидный
                          HTML (та же причина, по которой корзина вынесена в
                          соседний элемент).

                          COPY-L-3 (copy-review круг 2, #664): здесь стояло
                          «Объекта больше нет» — строка, снятая кругом раньше
                          (COPY-M-4), то есть комментарий велел вернуть
                          снятое. Исчезнувший объект показывает, ЧТО именно
                          исчезло («Проект удалён», «Команда удалена», …), и
                          никуда не ведёт (§7.4); архивный — что он в архиве
                          (QA-M-3/QA-L-2). */}
                        {action ? (
                          <p
                            className={cn(
                              'mt-1 wrap-anywhere text-xs font-medium',
                              action.disabled ? 'text-muted-foreground/60' : 'text-primary',
                            )}
                            data-testid={`notification-item-${n.id}-action`}
                          >
                            {action.label}
                          </p>
                        ) : null}
                        <p className="mt-1 text-[11px] text-muted-foreground/70">
                          {fmtRelative(n.createdAt)}
                        </p>
                      </div>
                      {!n.readAt ? (
                        <span
                          aria-hidden
                          className="mt-1 h-2 w-2 shrink-0 rounded-full bg-primary"
                        />
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
              )
            })}
          </ul>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
