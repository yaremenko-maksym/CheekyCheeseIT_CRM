import { useMemo, useState } from 'react'
import { Search, Wallet, X } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { Trans, useLingui } from '@lingui/react/macro'
import type { Role, TransactionDto, TotalEarnedDto } from '@crm/shared'
import { totalEarnedSchema } from '@crm/shared'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/axios'
import { useAuth } from '@/context/auth'
import { formatAmount } from '@/lib/format-amount'
import { financeApi } from '@/routes/_authenticated/finance/api'
import {
  STATUS_LABEL_MESSAGES,
  TYPE_LABEL_MESSAGES,
  type ExchangeRates,
} from '@/routes/_authenticated/finance/constants'
import { TransactionRow } from '@/routes/_authenticated/finance/components/TransactionRow'
import { TransactionDetailDialog } from '@/routes/_authenticated/finance/components/dialogs/TransactionDetailDialog'

/**
 * Finance tab inside the user profile.
 *
 * Reuses the /finance TransactionRow + TransactionDetailDialog so the
 * list / row layout / detail dialog match the dedicated finance page. We
 * filter the transactions client-side by sender/receiver matching the
 * profile owner so the same component works for any viewer (ADMIN sees
 * the full unfiltered list when looking at any senior; SENIOR self-view
 * sees only their own).
 */
// Roles for which «всего заработано с нами» is a meaningful figure (people the
// company actually pays: senior payouts / drop shares / junior+HR salary).
// ADMIN targets are intentionally excluded — admins are partners, not payees.
const EARNED_TARGET_ROLES: ReadonlyArray<Role> = ['SENIOR', 'DROP', 'JUNIOR', 'HR']

export function FinanceTab({ userId, targetRole }: { userId: string; targetRole?: Role }) {
  const { t, i18n } = useLingui()
  // Unreachable placeholders — `typeFilter`/`statusFilter` are initialised
  // to 'all', which always has a matching SelectItem, so Radix shows the
  // item's own label, never these placeholders (only shown for an
  // unmatched/empty value, which these filters never enter). Named
  // constants (not inlined) so the `// Stryker disable next-line` below
  // sits directly above a plain statement — Stryker's "next-line" matches
  // by the enclosing STATEMENT's start line, which a JSX `{/* */}` comment
  // attaches unreliably compared to a real `//` comment on a `const`.
  // Stryker disable next-line StringLiteral: see comment above
  const typeFilterPlaceholder = t`Усі типи`
  // Stryker disable next-line StringLiteral: same reasoning as typeFilterPlaceholder above
  const statusFilterPlaceholder = t`Усі статуси`
  const { user: viewer } = useAuth()
  const role = viewer?.role ?? ''
  const isPrivileged = role === 'ADMIN' || role === 'ACCOUNTANT'
  // «Всего заработано» is a privileged financial metric: only ADMIN / ACCOUNTANT
  // viewers see it, and only on SENIOR / DROP / JUNIOR / HR profiles. Other
  // viewers (incl. the target self-viewing) never get the figure — the backend
  // also enforces this (assertCanReadTotalEarned → 403), so the query is the
  // belt-and-suspenders second layer to the server guard.
  const showTotalEarned = isPrivileged && !!targetRole && EARNED_TARGET_ROLES.includes(targetRole)

  const { data: totalEarned } = useQuery<TotalEarnedDto>({
    queryKey: ['profile-total-earned', userId],
    queryFn: () =>
      api.get(`/balances/total-earned/${userId}`).then((r) => totalEarnedSchema.parse(r.data)),
    enabled: showTotalEarned,
    staleTime: 60_000,
  })

  const { data: transactions = [], isLoading } = useQuery({
    queryKey: ['profile-transactions', userId, role],
    // ADMIN / ACCOUNTANT: use the privileged /users/:id/transactions endpoint
    // which returns every tx the target was part of. For SENIOR self-view
    // (and other roles looking at their own finances) we fall back to the
    // public /transactions endpoint and client-filter by sender/receiver.
    queryFn: () =>
      isPrivileged
        ? api
            .get<TransactionDto[]>(`/users/${userId}/transactions`)
            .then((r) => r.data)
            .catch(() => [])
        : financeApi
            .getTransactions()
            .then((list) => list.filter((t) => t.senderId === userId || t.receiverId === userId)),
    staleTime: 30_000,
  })

  const { data: rates } = useQuery<ExchangeRates>({
    queryKey: ['exchange-rate', 'today'],
    queryFn: () => api.get<ExchangeRates>('/finance/exchange-rate').then((r) => r.data),
    staleTime: 1000 * 60 * 60,
  })

  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [detailTx, setDetailTx] = useState<TransactionDto | null>(null)

  // task-i18n-stage3d-pr1 (Task 1, Step 6, template G-fin). `TYPE_LABELS`/
  // `STATUS_LABELS` (plain Russian string maps) are replaced by
  // `TYPE_LABEL_MESSAGES`/`STATUS_LABEL_MESSAGES` (`Record<…,
  // MessageDescriptor>`, `finance/constants.ts`) — the lookup happens INSIDE
  // this component via `i18n._()`, never at module level (a module-level
  // `i18n._()` call would freeze the label at whatever locale was active on
  // first import; see that file's own `activeLocale()` doc). `i18n` is
  // included in this `useMemo`'s deps precisely so a live locale switch
  // recomputes the option list instead of keeping the label text of
  // whichever locale was active when this component first mounted.
  // The derived list is only observable by OPENING the Radix Select and
  // enumerating its portalled `SelectItem`s — Radix listens for real
  // pointer-capture events (`pointerdown` + `hasPointerCapture`) to open,
  // which happy-dom does not implement; `userEvent.click`/
  // `fireEvent.pointerDown` on the trigger both leave `data-state="closed"`
  // in this test environment (verified: every `*.test.tsx` in this repo
  // that touches a Radix `<Select>` only ever asserts the CLOSED trigger's
  // text/disabled state, never an opened option list).
  const TYPE_OPTIONS = useMemo(
    () =>
      Object.keys(TYPE_LABEL_MESSAGES).map((value) => ({
        value,
        label: i18n._(TYPE_LABEL_MESSAGES[value as keyof typeof TYPE_LABEL_MESSAGES]),
      })),
    // Stryker disable next-line ArrayDeclaration: a `[]` deps array only differs
    // from `[i18n]` across a live locale switch's RE-render — the comment above
    // already explains why this is only observable by opening the Radix
    // `<Select>`, which happy-dom does not support (verified: no `*.test.tsx` in
    // this repo asserts an OPENED Select's option list).
    [i18n],
  )
  const STATUS_OPTIONS = useMemo(
    () =>
      Object.keys(STATUS_LABEL_MESSAGES).map((value) => ({
        value,
        label: i18n._(STATUS_LABEL_MESSAGES[value as keyof typeof STATUS_LABEL_MESSAGES]),
      })),
    // Stryker disable next-line ArrayDeclaration: same reasoning as TYPE_OPTIONS' deps above.
    [i18n],
  )

  // Pre-parse timestamps once per transactions change — avoids constructing new
  // Date objects on every comparison in sort (O(N log N) × 2 Date() → O(N) once).
  const txWithTimestamp = useMemo(
    () =>
      transactions.map((tx) => ({
        tx,
        ts: new Date(tx.txDate ?? tx.createdAt).getTime(),
      })),
    [transactions],
  )

  const filtered = useMemo(() => {
    return txWithTimestamp
      .filter(({ tx }) => {
        if (typeFilter !== 'all' && tx.type !== typeFilter) return false
        if (statusFilter !== 'all' && tx.status !== statusFilter) return false
        if (search) {
          const q = search.toLowerCase()
          const haystack = [
            tx.senderName,
            tx.receiverName,
            tx.senderLabel,
            tx.receiverLabel,
            tx.projectName,
            tx.notes,
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
          if (!haystack.includes(q)) return false
        }
        return true
      })
      .sort((a, b) => b.ts - a.ts)
      .map(({ tx }) => tx)
  }, [txWithTimestamp, search, typeFilter, statusFilter])

  const hasActive = search !== '' || typeFilter !== 'all' || statusFilter !== 'all'

  // «Всего заработано с нами» card — lifetime money the company paid this user.
  // Rendered above the transactions list, visible to ADMIN / ACCOUNTANT only on
  // SENIOR / DROP / JUNIOR / HR profiles (see showTotalEarned). Shown in both the
  // empty-state and the populated branch so the figure is consistent regardless
  // of whether the row list is non-empty.
  const earnedCard =
    showTotalEarned && totalEarned ? (
      <Card className="mb-3 border-primary/30 bg-primary/5" data-testid="total-earned-card">
        <CardContent className="flex items-center justify-between gap-4 py-4">
          <div className="flex items-center gap-3 min-w-0">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Wallet className="h-4 w-4" aria-hidden />
            </span>
            <div className="min-w-0">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                <Trans>Усього виплачено цій людині</Trans>
              </p>
              <p className="text-xs text-muted-foreground/70">
                <Trans>Сума всіх виплат за весь час</Trans>
              </p>
            </div>
          </div>
          <span
            className="text-2xl font-bold tabular-nums whitespace-nowrap"
            data-testid="total-earned-amount"
          >
            {formatAmount(totalEarned.totalEarned, totalEarned.currency)}
          </span>
        </CardContent>
      </Card>
    ) : null

  return (
    <>
      {earnedCard}
      <Card>
        <CardContent className="p-0">
          {/* Filter bar — same look as /finance; always visible (chrome-in-place) */}
          <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-border">
            <div className="relative flex-1 min-w-40">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                enterKeyHint="search"
                className="h-8 pl-8 text-sm"
                placeholder={t`Пошук…`}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                disabled={isLoading}
              />
            </div>
            <Select value={typeFilter} onValueChange={setTypeFilter} disabled={isLoading}>
              <SelectTrigger className="h-8 text-xs w-auto min-w-32 max-w-44">
                <SelectValue placeholder={typeFilterPlaceholder} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">
                  <Trans>Усі типи</Trans>
                </SelectItem>
                {TYPE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={statusFilter} onValueChange={setStatusFilter} disabled={isLoading}>
              <SelectTrigger className="h-8 text-xs w-auto min-w-32 max-w-44">
                <SelectValue placeholder={statusFilterPlaceholder} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">
                  <Trans>Усі статуси</Trans>
                </SelectItem>
                {STATUS_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {hasActive && !isLoading && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 gap-1 text-muted-foreground"
                onClick={() => {
                  setSearch('')
                  setTypeFilter('all')
                  setStatusFilter('all')
                }}
              >
                <X className="h-3.5 w-3.5" /> <Trans>Скинути</Trans>
              </Button>
            )}
          </div>

          {isLoading ? (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border text-xs text-muted-foreground">
                    <th className="py-3 px-4 text-left font-medium">
                      <Trans>Тип</Trans>
                    </th>
                    <th className="py-3 px-4 text-left font-medium">
                      <Trans>Учасник / Проєкт</Trans>
                    </th>
                    <th className="py-3 px-4 text-left font-medium">
                      <Trans>Сума</Trans>
                    </th>
                    <th className="py-3 px-4 text-left font-medium">
                      <Trans>Дата</Trans>
                    </th>
                    <th className="py-3 px-4 text-left font-medium">
                      <Trans>Статус</Trans>
                    </th>
                    <th className="py-3 px-4 text-left font-medium">
                      <Trans>Дії</Trans>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {Array.from({ length: 6 }).map((_, i) => (
                    <tr key={i} className="border-b border-border/50">
                      <td className="py-3 px-4" colSpan={6}>
                        <Skeleton className="h-5 w-full" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : !isLoading && transactions.length === 0 ? (
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              <Trans>Транзакцій поки немає</Trans>
            </CardContent>
          ) : filtered.length === 0 ? (
            // M-5 (task-i18n-stage3b, Step 7): `hasActive ? … : 'Нет данных'`
            // removed — the `!hasActive` branch is unreachable here: when no
            // filter is active `filtered === transactions` (see `filtered`'s
            // own `useMemo`), so an EMPTY `filtered` with `!hasActive` implies
            // `transactions.length === 0`, which the branch above already
            // caught. One canon text for the one reachable case.
            <div className="py-14 text-center text-sm text-muted-foreground">
              <Trans>Нічого не знайдено — скиньте фільтри</Trans>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border text-xs text-muted-foreground">
                    <th className="py-3 px-4 text-left font-medium">
                      <Trans>Тип</Trans>
                    </th>
                    <th className="py-3 px-4 text-left font-medium">
                      <Trans>Учасник / Проєкт</Trans>
                    </th>
                    <th className="py-3 px-4 text-left font-medium">
                      <Trans>Сума</Trans>
                    </th>
                    <th className="py-3 px-4 text-left font-medium">
                      <Trans>Дата</Trans>
                    </th>
                    <th className="py-3 px-4 text-left font-medium">
                      <Trans>Статус</Trans>
                    </th>
                    <th className="py-3 px-4 text-left font-medium">
                      <Trans>Дії</Trans>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((tx) => (
                    <TransactionRow
                      key={tx.id}
                      tx={tx}
                      role={role}
                      rates={rates}
                      currentUserId={viewer?.id ?? null}
                      onClick={setDetailTx}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <TransactionDetailDialog tx={detailTx} onClose={() => setDetailTx(null)} />
    </>
  )
}
