import { Loader2 } from 'lucide-react'
import { useAuth } from '@/context/auth'
import { Badge } from '@/components/ui/badge'
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
import { usePayoutPaymentForm } from '../../hooks/usePayoutPaymentForm'
import { PayoutPaymentForm } from './PayoutPaymentForm'

/**
 * Step 2 of the SENIOR/DROP payout flow — settles a previously-created Выплата
 * by transferring `payableAmount` USDT to the COMPANY wallet and submitting the
 * on-chain tx hash for Etherscan verification (Phase 8 v2).
 *
 * Opened from the inline «Оплатить» badge on a PENDING_PAYMENT transaction row.
 * The destination wallet is `payout.contractAddress` (the company USDT wallet);
 * the SENIOR copies it, sends the USDT, then pastes the hash. The submit hits
 * /payout-requests/:id/pay where the backend verifies on-chain (stub
 * auto-confirms in dev) and flips the payout to PAID.
 *
 * ADMIN/ACCOUNTANT additionally get a secondary «Ручное подтверждение» section
 * (escape hatch) that calls the NEW /payout-requests/:id/manual-confirm
 * endpoint — for payouts settled off the on-chain happy path.
 *
 * Read-only when the payout is already PAID — preserves the audit trail.
 *
 * task-company-share-cta: the body (instruction card / tx list / hash input /
 * dev-simulate / on-chain status / manual-confirm) and all mutation logic now
 * live in `usePayoutPaymentForm` + `PayoutPaymentForm` — shared, unchanged,
 * with `CompanySharePayoutModal` step 2. This component is now a thin wrapper
 * that owns the `<Dialog>` + header + footer for the standalone entry point
 * («Оплатить» on an already-created payout). Behaviour is unchanged.
 */
export function PayoutDetailDialog({
  open,
  onClose,
  payoutId,
}: {
  open: boolean
  onClose: () => void
  payoutId: string | null
}) {
  const { user } = useAuth()
  const canManualConfirm = user?.role === 'ADMIN' || user?.role === 'ACCOUNTANT'

  function handleClose() {
    state.resetLocal()
    onClose()
  }

  const state = usePayoutPaymentForm(payoutId, open, { onAutoClose: handleClose })
  const { payout, onChainStatus, submitDisabled, payMutation } = state

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) handleClose()
      }}
    >
      <CrmDialogContent maxWidth="sm:max-w-xl" data-testid="payout-detail-dialog">
        <CrmDialogHeader>
          <DialogTitle className="flex items-center gap-2" data-testid="payout-detail-title">
            {state.isPaid ? 'Выплата (оплачена)' : 'Подтвердить выплату'}
            {state.isPaid && (
              <Badge variant="secondary" className="text-[10px]">
                PAID
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription className="sr-only">Детали выплаты</DialogDescription>
        </CrmDialogHeader>

        <CrmDialogBody className="pb-4">
          <PayoutPaymentForm state={state} canManualConfirm={canManualConfirm} />
        </CrmDialogBody>

        <CrmDialogFooter>
          <Button variant="outline" onClick={handleClose}>
            {state.isPaid || onChainStatus === 'confirmed' ? 'Закрыть' : 'Отмена'}
          </Button>
          {!state.isPaid && payout && onChainStatus !== 'confirmed' && (
            <Button
              data-testid="payout-detail-submit"
              onClick={() => payMutation.mutate()}
              disabled={submitDisabled}
              className={submitDisabled ? 'opacity-50 cursor-not-allowed' : undefined}
            >
              {payMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Проверка…
                </>
              ) : (
                'Подтвердить оплату'
              )}
            </Button>
          )}
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}
