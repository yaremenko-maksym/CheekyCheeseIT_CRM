/**
 * NotificationSettingsTab — «Уведомления» tab on the SELF profile (position
 * 7b, `docs/design/notification-settings.md`).
 *
 * Ten notification types (position 6 registry), grouped and rendered as a
 * type -> channel matrix. "В приложении" is a static "Всегда" label (never a
 * control — the owner decided the in-app channel is not user-configurable);
 * "Письмо" is a `Switch` wired to `GET/PUT /notifications/preferences`
 * (position 7a). `locked` rows (the three action-required types) render the
 * switch fixed ON and non-interactive.
 *
 * Two independent layouts share the SAME grouped data (design spec §8):
 * a `<table>` for md+ and a per-row card stack below md. Both stay mounted
 * simultaneously (Tailwind `hidden md:block` / `md:hidden` — CSS visibility,
 * not conditional render), so every row exists twice in the DOM. Each
 * variant carries its own `data-testid` prefix (`-desktop-` / `-mobile-`) so
 * Playwright locators scoped to one container never hit the classic
 * dual-render strict-mode violation (`playwright-patterns` skill).
 */
import { Fragment } from 'react'
import { AlertTriangle } from 'lucide-react'
import {
  ACTION_REQUIRED_NOTIFICATION_TYPES,
  ADMIN_NOTIFICATION_TYPES,
  INFORMING_NOTIFICATION_TYPES,
  NEW_NOTIFICATION_TYPES,
  NOTIFICATION_TITLES,
  type NewNotificationType,
  type Notification,
} from '@crm/shared'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/context/auth'
import { cn } from '@/lib/utils'
import { TypeIcon } from '@/lib/notification-type-icon'
import {
  useNotificationPreferences,
  useUpdateNotificationPreference,
} from '@/hooks/use-notification-preferences'

// ---------------------------------------------------------------------------
// Grouping (design spec §2) — computed on the client; the backend sends all
// ten types for any role, the client decides which groups are visible.
// ---------------------------------------------------------------------------

export interface PreferenceRow {
  type: string
  emailEnabled: boolean
  locked: boolean
}

export interface PreferenceGroup {
  key: string
  /** null for the trailing "unknown type" bucket — no group header rendered. */
  title: string | null
  rows: PreferenceRow[]
}

const KNOWN_TYPES = new Set<string>(NEW_NOTIFICATION_TYPES as readonly string[])
const ACTION_REQUIRED_SET = new Set<string>(ACTION_REQUIRED_NOTIFICATION_TYPES as readonly string[])
const ADMIN_SET = new Set<string>(ADMIN_NOTIFICATION_TYPES as readonly string[])
const INFORMING_SET = new Set<string>(INFORMING_NOTIFICATION_TYPES as readonly string[])

/**
 * Predicate by TYPE NAME, not array index (design spec §2 rationale) — stays
 * correct if the registry ever reorders or inserts an eleventh informing
 * type between the two transaction types.
 *
 * Exported (with the rest of this section) so the grouping contract has a
 * pure-function seam to test directly — `NotificationSettingsTab.grouping.
 * test.ts` — instead of re-deriving every combination through full DOM
 * renders (`codebase-design`: the interface IS the test surface).
 */
export function isMoneyType(type: string): boolean {
  return type.startsWith('TRANSACTION_')
}

export function groupPreferences(
  items: readonly PreferenceRow[],
  isAdmin: boolean,
): PreferenceGroup[] {
  const actionRequired = items.filter((i) => ACTION_REQUIRED_SET.has(i.type))
  const money = items.filter((i) => INFORMING_SET.has(i.type) && isMoneyType(i.type))
  const team = items.filter((i) => INFORMING_SET.has(i.type) && !isMoneyType(i.type))
  const admin = items.filter((i) => ADMIN_SET.has(i.type))
  const unknown = items.filter((i) => !KNOWN_TYPES.has(i.type))

  const groups: PreferenceGroup[] = [
    { key: 'action-required', title: 'Требуют ответа', rows: actionRequired },
    { key: 'money', title: 'Деньги', rows: money },
    { key: 'team', title: 'Команда и проекты', rows: team },
  ]
  // §2: composition comes from the backend (it may send the admin types to
  // any role by mistake) — the UI is the second, independent line of
  // defense and never renders the group for a non-ADMIN viewer regardless.
  if (isAdmin) {
    groups.push({ key: 'admin', title: 'Для администратора', rows: admin })
  }
  // Pushed unconditionally (no `unknown.length > 0` guard) — the trailing
  // filter below already drops any empty group, admin included when
  // `isAdmin` is true but the backend sent no admin-only types. A separate
  // length check here would just be the same predicate spelled twice.
  groups.push({ key: 'unknown', title: null, rows: unknown })
  return groups.filter((g) => g.rows.length > 0)
}

const UNKNOWN_TYPE_EXPLANATION = 'Новый тип уведомления, ожидайте обновления интерфейса.'
const LOCKED_EXPLANATION =
  'Письма о запросах на подтверждение и подпись отключить нельзя — без них процесс встанет.'

export function rowTitle(row: PreferenceRow): string {
  return KNOWN_TYPES.has(row.type) ? NOTIFICATION_TITLES[row.type as NewNotificationType] : row.type
}

export function rowExplanation(row: PreferenceRow): string | null {
  if (row.locked) return LOCKED_EXPLANATION
  if (!KNOWN_TYPES.has(row.type)) return UNKNOWN_TYPE_EXPLANATION
  return null
}

/** Locked rows AND unknown-type rows never accept a click — see §7/§9. */
export function isRowInteractive(row: PreferenceRow): boolean {
  return !row.locked && KNOWN_TYPES.has(row.type)
}

/** Locked rows are forced ON regardless of what the server sent (§6.3). */
export function rowChecked(row: PreferenceRow): boolean {
  return row.locked ? true : row.emailEnabled
}

// ---------------------------------------------------------------------------
// Switch — shared between the two layouts
// ---------------------------------------------------------------------------

function PreferenceSwitch({
  row,
  variant,
  onToggle,
}: {
  row: PreferenceRow
  variant: 'desktop' | 'mobile'
  onToggle: (type: string, next: boolean) => void
}) {
  const interactive = isRowInteractive(row)
  const explanationId = rowExplanation(row)
    ? `notification-pref-explain-${variant}-${row.type}`
    : undefined
  // `exactOptionalPropertyTypes` rejects `onCheckedChange={undefined}` (Radix's
  // prop is typed as a plain function, not `fn | undefined`) — so the locked/
  // unknown-type case omits the prop entirely via conditional spread instead
  // of assigning `undefined` to it (§9: no handler at all keeps `checked`
  // pinned by the `checked` prop above without ever calling the mutation).
  const interactiveProps = interactive
    ? { onCheckedChange: (next: boolean) => onToggle(row.type, next) }
    : {}
  return (
    <span
      data-testid={`notification-switch-wrapper-${variant}-${row.type}`}
      className={cn(
        'inline-flex shrink-0 items-center justify-center',
        // Design spec §8: the tap TARGET must be >=44x44 on mobile, WITHOUT
        // inflating the visual track (§8's own warning: "иначе трек
        // визуально «раздувается»"). A plain `min-h-11`/`min-w-11` on the
        // wrapping span alone would reserve invisible padding the click
        // never lands on (the Radix Switch button keeps its own h-5/w-9 box
        // centered inside; clicking the span's edge hits the SPAN, not the
        // button, since the span has no click handler of its own) — and
        // applying `min-h-11`/`min-w-11` directly to the BUTTON would work
        // for hit-testing but also grow its `height`/`width` (CSS min-height
        // overrides a smaller fixed `height` per spec), visibly puffing up
        // the track into a near-square blob instead of a pill.
        //
        // Fix: grow the button's BORDER-BOX (the actual clickable area)
        // via invisible padding while keeping its CONTENT-BOX (the visible
        // track) at the original h-5/w-9 — `box-content` makes `h-5`/`w-9`
        // describe the content box specifically (Tailwind Preflight
        // defaults every element to `border-box`, which would otherwise
        // consume the added padding out of the fixed height/width instead
        // of growing the box); `bg-clip-content` + `bg-origin-content` keep
        // the track/thumb paint confined to that original content box, so
        // the extra padding stays fully transparent. py-3 (12px × 2 = 24px)
        // brings 20px → 44px; px-1 (4px × 2 = 8px) brings 36px → 44px.
        // Scoped to <640px — the desktop/tablet table keeps the compact,
        // dense switch as-is.
        '[&>button]:max-[639px]:box-content [&>button]:max-[639px]:bg-clip-content [&>button]:max-[639px]:bg-origin-content [&>button]:max-[639px]:px-1 [&>button]:max-[639px]:py-3',
      )}
    >
      <Switch
        data-testid={`notification-switch-${variant}-${row.type}`}
        checked={rowChecked(row)}
        aria-label={`«${rowTitle(row)}» — письмо`}
        aria-disabled={!interactive}
        aria-describedby={explanationId}
        className={cn(!interactive && 'opacity-60 cursor-not-allowed')}
        {...interactiveProps}
      />
    </span>
  )
}

// ---------------------------------------------------------------------------
// Desktop table (design spec §5.1)
// ---------------------------------------------------------------------------

function DesktopGroupHeader({ group }: { group: PreferenceGroup }) {
  if (!group.title) return null
  return (
    <tr data-testid={`notification-group-${group.key}`}>
      <td
        colSpan={3}
        className="bg-muted/40 px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground"
      >
        {group.title}
      </td>
    </tr>
  )
}

function DesktopRow({
  row,
  onToggle,
}: {
  row: PreferenceRow
  onToggle: (type: string, next: boolean) => void
}) {
  const explanation = rowExplanation(row)
  const known = KNOWN_TYPES.has(row.type)
  return (
    <tr
      className="border-b border-border/50 hover:bg-muted/20"
      data-testid={`notification-row-desktop-${row.type}`}
    >
      <td className="px-4 py-3 align-top">
        <div className="flex items-start gap-2">
          <span className="mt-0.5 shrink-0">
            <TypeIcon type={row.type as Notification['type']} />
          </span>
          <div className="min-w-0">
            <p className={cn('text-sm font-medium text-foreground', !known && 'font-mono text-xs')}>
              {rowTitle(row)}
            </p>
            {explanation && (
              <p
                id={`notification-pref-explain-desktop-${row.type}`}
                data-testid={`notification-pref-explain-desktop-${row.type}`}
                className="mt-0.5 text-xs text-muted-foreground"
              >
                {explanation}
              </p>
            )}
          </div>
        </div>
      </td>
      <td className="w-[120px] px-4 py-3 align-top text-xs text-muted-foreground">Всегда</td>
      <td className="w-[100px] px-4 py-3 align-top">
        <PreferenceSwitch row={row} variant="desktop" onToggle={onToggle} />
      </td>
    </tr>
  )
}

function DesktopTable({
  groups,
  onToggle,
}: {
  groups: PreferenceGroup[]
  onToggle: (type: string, next: boolean) => void
}) {
  return (
    <div className="hidden overflow-x-auto md:block" data-testid="notification-settings-desktop">
      <table className="w-full">
        <thead>
          <tr className="border-b border-border text-xs text-muted-foreground">
            <th className="px-4 py-3 text-left font-medium">Тип уведомления</th>
            <th className="w-[120px] px-4 py-3 text-left font-medium">В приложении</th>
            <th className="w-[100px] px-4 py-3 text-left font-medium">Письмо</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => (
            <Fragment key={group.key}>
              <DesktopGroupHeader group={group} />
              {group.rows.map((row) => (
                <DesktopRow key={row.type} row={row} onToggle={onToggle} />
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Mobile card stack (design spec §5.2)
// ---------------------------------------------------------------------------

function MobileRow({
  row,
  onToggle,
}: {
  row: PreferenceRow
  onToggle: (type: string, next: boolean) => void
}) {
  const explanation = rowExplanation(row)
  const known = KNOWN_TYPES.has(row.type)
  return (
    <div
      className="flex flex-col gap-1 border-b border-border/50 p-4 last:border-b-0"
      data-testid={`notification-row-mobile-${row.type}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <span className="mt-0.5 shrink-0">
            <TypeIcon type={row.type as Notification['type']} />
          </span>
          <p
            className={cn(
              'min-w-0 break-words text-sm font-medium text-foreground',
              !known && 'font-mono text-xs',
            )}
          >
            {rowTitle(row)}
          </p>
        </div>
        <PreferenceSwitch row={row} variant="mobile" onToggle={onToggle} />
      </div>
      <p className="text-xs text-muted-foreground">Всегда — в приложении</p>
      {explanation && (
        <p
          id={`notification-pref-explain-mobile-${row.type}`}
          data-testid={`notification-pref-explain-mobile-${row.type}`}
          className="break-words text-xs text-muted-foreground"
        >
          {explanation}
        </p>
      )}
    </div>
  )
}

function MobileStack({
  groups,
  onToggle,
}: {
  groups: PreferenceGroup[]
  onToggle: (type: string, next: boolean) => void
}) {
  return (
    <div className="md:hidden" data-testid="notification-settings-mobile">
      {groups.map((group) => (
        <div key={group.key} data-testid={`notification-group-${group.key}`}>
          {group.title && (
            <div
              className="bg-muted/40 px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground"
              data-testid="notification-group-heading"
            >
              {group.title}
            </div>
          )}
          {group.rows.map((row) => (
            <MobileRow key={row.type} row={row} onToggle={onToggle} />
          ))}
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Loading / error states (design spec §6.1/§7)
// ---------------------------------------------------------------------------

const SKELETON_ROW_COUNT = NEW_NOTIFICATION_TYPES.length

function LoadingState() {
  return (
    <>
      <div className="hidden md:block" data-testid="notification-settings-loading-desktop">
        <table className="w-full">
          <tbody>
            {Array.from({ length: SKELETON_ROW_COUNT }).map((_, i) => (
              <tr key={i} className="border-b border-border/50">
                <td className="px-4 py-3" colSpan={3}>
                  <Skeleton className="h-5 w-full" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="md:hidden" data-testid="notification-settings-loading-mobile">
        {Array.from({ length: SKELETON_ROW_COUNT }).map((_, i) => (
          <div
            key={i}
            className="border-b border-border/50 p-4 last:border-b-0"
            data-testid="notification-settings-loading-mobile-row"
          >
            <Skeleton className="h-5 w-full" />
          </div>
        ))}
      </div>
    </>
  )
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      className="flex flex-col items-center gap-3 px-6 py-10 text-center"
      data-testid="notification-settings-error"
    >
      <AlertTriangle className="h-8 w-8 text-destructive/60" />
      <p className="text-sm text-muted-foreground">Не удалось загрузить настройки уведомлений.</p>
      <Button size="sm" variant="outline" onClick={onRetry}>
        Повторить
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export function NotificationSettingsTab() {
  const { user: viewer } = useAuth()
  const isAdmin = viewer?.role === 'ADMIN'
  const { data, isLoading, isError, refetch } = useNotificationPreferences()
  const updateMutation = useUpdateNotificationPreference()

  // `data` is only read below inside the `!isLoading && !isError` render
  // branch, so this fallback is a defensive guard against a TanStack Query
  // edge state (`isPending && !isFetching`, e.g. the instant before the
  // first fetch begins) rather than a path any current test can reach —
  // `data` is otherwise always populated by that point.
  // Stryker disable next-line ArrayDeclaration: unobservable by rendering — see comment above.
  const groups = data ? groupPreferences(data.items, isAdmin) : []

  // No `KNOWN_TYPES` guard here: `onToggle` is only ever wired to a `Switch`
  // via `interactiveProps` in `PreferenceSwitch`, which itself is only
  // populated when `isRowInteractive(row)` is true — and that predicate
  // already requires `KNOWN_TYPES.has(row.type)`. A second check here would
  // guard a call path that cannot occur, restated instead of removed.
  function handleToggle(type: string, next: boolean) {
    updateMutation.mutate({ type: type as NewNotificationType, emailEnabled: next })
  }

  return (
    <Card>
      <CardContent className="p-0">
        <div className="border-b border-border/50 px-4 py-3">
          <p className="text-sm text-muted-foreground">
            Письма по типам событий. В приложении уведомления видны всегда.
          </p>
        </div>
        {isLoading ? (
          <LoadingState />
        ) : isError ? (
          <ErrorState onRetry={() => void refetch()} />
        ) : (
          <>
            <DesktopTable groups={groups} onToggle={handleToggle} />
            <MobileStack groups={groups} onToggle={handleToggle} />
          </>
        )}
      </CardContent>
    </Card>
  )
}
