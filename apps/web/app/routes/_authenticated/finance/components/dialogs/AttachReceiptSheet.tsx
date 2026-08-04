/**
 * AttachReceiptSheet — task-receipts-frontend.
 *
 * Single, generic attach/replace-receipt surface for ANY transaction, opened
 * from two entry points: the compact row icon (`TransactionRow`, ≥768px) and
 * the explicit button in `TransactionDetailDialog` (primary mobile entry).
 * Both entry points render the SAME component — no per-entry-point Sheet
 * duplication.
 *
 * Mutation: `PATCH /transactions/:id/receipt` (financeApi.attachReceipt).
 * Replacing an EXISTING receipt goes through an `AlertDialog` confirm first
 * (destructive — the old file/link is gone for good server-side).
 */
import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { TransactionDto } from '@crm/shared'
import { cn } from '@/lib/utils'
import { getApiErrorMessage } from '@/lib/axios-utils'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from '@/components/ui/sheet'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog'
import { financeApi } from '../../api'
import { fmtAmount, TYPE_COLORS, TYPE_LABELS } from '../../constants'
import {
  ReceiptInput,
  emptyReceiptState,
  receiptStateFromDocument,
  receiptStateFromExternalUrl,
  type ReceiptState,
} from '../ReceiptInput'

interface AttachReceiptSheetProps {
  /** The transaction to attach/replace a receipt on. `null` = closed. */
  tx: TransactionDto | null
  onClose: () => void
}

export function AttachReceiptSheet({ tx, onClose }: AttachReceiptSheetProps) {
  const [receipt, setReceipt] = useState<ReceiptState>(emptyReceiptState())
  const [error, setError] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const qc = useQueryClient()

  // Seed the form from the tx's existing receipt (replace flow) whenever the
  // target transaction changes. Keyed on tx?.id only — re-seeding on every
  // parent re-render would clobber in-progress edits.
  useEffect(() => {
    if (!tx) return
    setReceipt(
      tx.receiptDocumentId
        ? receiptStateFromDocument(tx.receiptDocumentId)
        : receiptStateFromExternalUrl(tx.receiptExternalUrl),
    )
    setError(null)
    setConfirmOpen(false)
    // Keyed on tx?.id only — re-running on every state/callback identity
    // change would clobber in-progress edits (same pattern as ReceiptInput).
  }, [tx?.id])

  const hasExisting = !!(tx?.receiptDocumentId || tx?.receiptExternalUrl)
  const isExplorerOnly = tx?.currency === 'USDT'
  // task-receipts-frontend (interaction AC): submit stays disabled until a
  // valid receipt is present — not just gated post-click by an error banner.
  const hasNewReceipt =
    (receipt.mode === 'file' && !!receipt.documentId) ||
    (receipt.mode === 'url' && !!receipt.externalUrl)

  const nextReceiptDocId = receipt.mode === 'file' ? receipt.documentId : null
  const nextReceiptExternalUrl = receipt.mode === 'url' ? receipt.externalUrl || null : null
  // fix/external-receipt-rendering round 2 (security-review PR #470 MED-2):
  // the replace flow pre-fills the form from the tx's CURRENT receipt (effect
  // above) — confirming without editing it would resubmit the byte-identical
  // value. That has nothing to save, and for a legacy `http://` receipt the
  // now-https-only write schema would 400 it even though nothing changed.
  const receiptChanged =
    nextReceiptDocId !== (tx?.receiptDocumentId ?? null) ||
    nextReceiptExternalUrl !== (tx?.receiptExternalUrl ?? null)

  const mutation = useMutation({
    mutationFn: () =>
      financeApi.attachReceipt(tx!.id, {
        receiptDocumentId: nextReceiptDocId,
        receiptExternalUrl: nextReceiptExternalUrl,
      }),
    onSuccess: () => {
      toast.success(hasExisting ? 'Чек заменён' : 'Чек прикреплён')
      void qc.invalidateQueries({ queryKey: ['transactions'] })
      void qc.invalidateQueries({ queryKey: ['transaction', tx?.id] })
      setConfirmOpen(false)
      onClose()
    },
    onError: (err) => setError(getApiErrorMessage(err)),
  })

  function handleSubmit() {
    if (!hasNewReceipt) {
      setError('Прикрепите чек или укажите ссылку на подтверждение')
      return
    }
    if (hasExisting) {
      setConfirmOpen(true)
      return
    }
    mutation.mutate()
  }

  // Confirm-step action (destructive "Заменить" in the AlertDialog below).
  // If the admin confirmed WITHOUT actually changing the pre-filled value —
  // nothing to replace — close quietly instead of round-tripping an
  // unchanged value through the network (see receiptChanged above).
  function handleConfirmedReplace() {
    if (!receiptChanged) {
      setConfirmOpen(false)
      onClose()
      return
    }
    mutation.mutate()
  }

  return (
    <>
      <Sheet
        open={!!tx}
        onOpenChange={(v) => {
          if (!v) onClose()
        }}
      >
        <SheetContent
          side="right"
          className="w-full sm:max-w-md flex flex-col overflow-hidden"
          data-testid="attach-receipt-sheet"
        >
          <SheetHeader className="mb-2 shrink-0">
            <SheetTitle>{hasExisting ? 'Заменить чек' : 'Прикрепить чек'}</SheetTitle>
            <SheetDescription className="sr-only">
              Прикрепление подтверждающего документа к транзакции
            </SheetDescription>
          </SheetHeader>

          {tx && (
            <div className="flex-1 overflow-y-auto space-y-4">
              <div className="rounded-lg border border-border bg-muted/30 p-3 flex items-center justify-between text-sm">
                <span
                  className={cn(
                    'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
                    TYPE_COLORS[tx.type],
                  )}
                >
                  {TYPE_LABELS[tx.type]}
                </span>
                <span className="font-medium tabular-nums">
                  {fmtAmount(tx.amount, tx.currency)}
                </span>
              </div>

              <ReceiptInput
                state={receipt}
                onChange={(s) => {
                  setReceipt(s)
                  setError(null)
                }}
                explorerOnly={isExplorerOnly}
                error={error ?? undefined}
              />
              {error && (
                <p
                  className="text-[11px] text-destructive"
                  data-testid="attach-receipt-sheet-error"
                >
                  {error}
                </p>
              )}
            </div>
          )}

          <SheetFooter className="mt-4 shrink-0">
            <Button
              variant="outline"
              className="h-11 sm:h-9"
              onClick={onClose}
              data-testid="attach-receipt-sheet-cancel"
            >
              Отмена
            </Button>
            <Button
              className="h-11 sm:h-9"
              onClick={handleSubmit}
              disabled={mutation.isPending || !hasNewReceipt}
              data-testid="attach-receipt-sheet-submit"
            >
              {hasExisting ? 'Заменить' : 'Прикрепить'}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent data-testid="attach-receipt-confirm-replace">
          <AlertDialogHeader>
            <AlertDialogTitle>Заменить существующий чек?</AlertDialogTitle>
            <AlertDialogDescription>
              Старый файл/ссылка будут удалены без возможности восстановления.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="attach-receipt-confirm-cancel">
              Отмена
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmedReplace}
              disabled={mutation.isPending}
              data-testid="attach-receipt-confirm-submit"
            >
              Заменить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
