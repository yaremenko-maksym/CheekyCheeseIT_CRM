/**
 * Drop role - phase 4-B round 2. ACCOUNTANT / ADMIN dashboard card on
 * /crm/finance listing every PAYOUT that was placed into PENDING_CASH_CONFIRM
 * by a DROP via /payments/initiate-cash. For each pending row the accountant
 * confirms WHICH of the two admins (Maksym / Kostya) actually received the
 * cash physically. Confirmation calls /payments/confirm-cash which inserts
 * ADMIN_INCOME_CASH + SENIOR_PENDING_PAYOUT and flips PAYOUT → PAID.
 *
 * Hidden for any role other than ADMIN / ACCOUNTANT (caller already gates).
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Wallet } from 'lucide-react'
import { toast } from 'sonner'
import type { PendingCashItemDto } from '@crm/shared'
import { MAKSYM_ID, KOSTYA_ID } from '@crm/shared'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  CrmDialogContent,
  CrmDialogHeader,
  CrmDialogBody,
  CrmDialogFooter,
  DialogTitle,
} from '@/components/ui/crm-dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { financeApi } from '../api'
import { formatAmountUsd } from '@/lib/format-amount'

interface AdminLite {
  id: string
  displayName: string
}

// Hardcoded admin partners — the two seed users that can receive cash. We
// don't fetch /users?role=ADMIN here because the list is fixed by spec
// (Maksym + Kostya) and going to the API would add a round-trip + token
// usage with no benefit. If a new admin partner is ever added, this list
// must be updated alongside the seed change.
const ADMIN_PARTNERS: AdminLite[] = [
  { id: MAKSYM_ID, displayName: 'Maksym' },
  { id: KOSTYA_ID, displayName: 'Kostya' },
]

function extractErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'response' in err) {
    const resp = (err as { response?: { data?: { message?: unknown } } }).response
    const msg = resp?.data?.message
    if (typeof msg === 'string') return msg
    if (Array.isArray(msg)) return msg.join(', ')
  }
  if (err instanceof Error) return err.message
  return 'Неизвестная ошибка'
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

export function PendingCashCard() {
  const qc = useQueryClient()
  const [confirmTarget, setConfirmTarget] = useState<PendingCashItemDto | null>(null)
  const [adminId, setAdminId] = useState<string>('')

  const { data: items = [], isLoading } = useQuery({
    queryKey: ['payments-pending-cash'],
    queryFn: () => financeApi.listPendingCash(),
    staleTime: 15_000,
  })

  const confirm = useMutation({
    mutationFn: ({ incomeId, recipientAdminId }: { incomeId: string; recipientAdminId: string }) =>
      financeApi.confirmCashPayment({ incomeId, recipientAdminId }),
    onSuccess: () => {
      toast.success('Получение нала подтверждено')
      void qc.invalidateQueries({ queryKey: ['payments-pending-cash'] })
      void qc.invalidateQueries({ queryKey: ['transactions'] })
      void qc.invalidateQueries({ queryKey: ['finance-summary'] })
      void qc.invalidateQueries({ queryKey: ['profile-transactions'] })
      setConfirmTarget(null)
      setAdminId('')
    },
    onError: (err) => toast.error(extractErrorMessage(err)),
  })

  if (!isLoading && items.length === 0) return null

  return (
    <Card className="border-amber-500/40" data-testid="pending-cash-card">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <Wallet className="h-4 w-4 text-amber-400" />
          Ожидают подтверждения cash
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Drop передал нал админу. Выберите, кому из админов реально пришёл нал, чтобы создать
          транзакции.
        </p>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <div className="px-4 py-6 text-sm text-muted-foreground">Загрузка…</div>
        ) : (
          <ul className="divide-y divide-border">
            {items.map((it) => (
              <li
                key={it.incomeId}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                data-testid={`pending-cash-item-${it.incomeId}`}
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">
                    {it.projectName ?? '— без проекта —'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Дроп: <span data-testid="pending-cash-drop-name">{it.dropName}</span> ·{' '}
                    Инициирован: {fmtDate(it.initiatedAt)}
                  </p>
                </div>
                <div className="text-sm font-bold tabular-nums" data-testid="pending-cash-amount">
                  {formatAmountUsd(it.amount, it.currency)}
                </div>
                <Button
                  size="sm"
                  onClick={() => {
                    setConfirmTarget(it)
                    setAdminId('')
                  }}
                  data-testid={`pending-cash-confirm-button-${it.incomeId}`}
                >
                  Подтвердить получение
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <Dialog
        open={!!confirmTarget}
        onOpenChange={(o) => {
          if (!o) {
            setConfirmTarget(null)
            setAdminId('')
          }
        }}
      >
        <CrmDialogContent maxWidth="sm:max-w-md">
          <CrmDialogHeader>
            <DialogTitle className="text-base">Подтверждение получения нала</DialogTitle>
          </CrmDialogHeader>
          <CrmDialogBody className="space-y-3">
            {confirmTarget && (
              <div className="space-y-2 text-sm">
                <div className="rounded-lg bg-muted/30 px-3 py-2 text-xs space-y-1">
                  <div>
                    <span className="text-muted-foreground">Проект:</span>{' '}
                    <span className="font-medium">{confirmTarget.projectName ?? '—'}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Дроп:</span>{' '}
                    <span className="font-medium">{confirmTarget.dropName}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Сумма:</span>{' '}
                    <span className="font-bold tabular-nums">
                      {formatAmountUsd(confirmTarget.amount, confirmTarget.currency)}
                    </span>
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">
                    Кому из админов реально пришёл нал?
                  </label>
                  <Select value={adminId} onValueChange={setAdminId}>
                    <SelectTrigger className="h-9" data-testid="pending-cash-admin-select">
                      <SelectValue placeholder="Выберите админа" />
                    </SelectTrigger>
                    <SelectContent>
                      {ADMIN_PARTNERS.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.displayName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}
          </CrmDialogBody>
          <CrmDialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setConfirmTarget(null)
                setAdminId('')
              }}
              data-testid="pending-cash-cancel-button"
            >
              Отмена
            </Button>
            <Button
              size="sm"
              disabled={!adminId || !confirmTarget || confirm.isPending}
              onClick={() =>
                confirmTarget &&
                confirm.mutate({
                  incomeId: confirmTarget.incomeId,
                  recipientAdminId: adminId,
                })
              }
              data-testid="pending-cash-submit-button"
            >
              {confirm.isPending && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
              Подтвердить
            </Button>
          </CrmDialogFooter>
        </CrmDialogContent>
      </Dialog>
    </Card>
  )
}
