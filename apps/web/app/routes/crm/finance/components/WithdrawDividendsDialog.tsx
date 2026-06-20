import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  CrmDialogContent,
  CrmDialogHeader,
  CrmDialogBody,
  CrmDialogFooter,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/crm-dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from 'sonner'
import { companyAccountApi } from '../api'

function fmtUsdt(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/**
 * task-company-account-frontend — ADMIN dividend withdrawal. Owner decision:
 * free amount, accounted post-hoc (no available-balance gate). Credits the
 * calling admin (backend default). The 50/50 split between admins is an
 * accounting view, not a hard gate here.
 */
export function WithdrawDividendsDialog({
  open,
  onClose,
  balance,
}: {
  open: boolean
  onClose: () => void
  balance: number
}) {
  const qc = useQueryClient()
  const [amount, setAmount] = useState('')

  const mutation = useMutation({
    mutationFn: () => companyAccountApi.createDividend({ amount: parseFloat(amount) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['company-account'] })
      void qc.invalidateQueries({ queryKey: ['transactions'] })
      toast.success('Дивиденды выведены')
      handleClose()
    },
  })

  function handleClose() {
    onClose()
    setAmount('')
  }

  const value = parseFloat(amount)
  const invalid = !amount || Number.isNaN(value) || value <= 0
  const exceeds = !Number.isNaN(value) && value > balance
  const error = mutation.error instanceof Error ? mutation.error.message : null

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) handleClose()
      }}
    >
      <CrmDialogContent maxWidth="sm:max-w-md">
        <CrmDialogHeader>
          <DialogTitle>Вывести дивиденды</DialogTitle>
          <DialogDescription className="sr-only">
            Вывод USDT со счёта компании как дивидендов
          </DialogDescription>
        </CrmDialogHeader>

        <CrmDialogBody className="space-y-4 pb-4" data-testid="withdraw-dividends-dialog">
          <div className="space-y-1 rounded-lg border border-border bg-muted/30 p-3 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Баланс счёта компании</span>
              <span className="font-bold tabular-nums">{fmtUsdt(balance)} USDT</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Доли партнёров</span>
              <span className="text-xs text-muted-foreground">50% / 50%</span>
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Сумма для вывода (USDT)</Label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                $
              </span>
              <Input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                inputMode="decimal"
                className="h-9 pl-7 text-sm tabular-nums"
                aria-label="Сумма дивидендов в USDT"
              />
            </div>
            {exceeds && (
              <p className="text-xs text-amber-400">
                Сумма больше баланса счёта — вывод уведёт счёт в минус.
              </p>
            )}
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </CrmDialogBody>

        <CrmDialogFooter>
          <Button variant="outline" onClick={handleClose}>
            Отмена
          </Button>
          <Button onClick={() => mutation.mutate()} disabled={invalid || mutation.isPending}>
            {mutation.isPending ? 'Вывод…' : 'Вывести дивиденды'}
          </Button>
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}
