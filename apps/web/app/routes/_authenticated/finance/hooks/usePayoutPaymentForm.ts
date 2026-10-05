import { useCallback, useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useLingui } from '@lingui/react/macro'
import { kyivToday, type ManualPayoutMethod } from '@crm/shared'
import { getApiErrorMessage } from '@/lib/axios-utils'
import { financeApi } from '../api'

/**
 * usePayoutPaymentForm — extracted from `PayoutDetailDialog.tsx`
 * (task-company-share-cta). ALL state/mutation logic for "step 2" of the
 * payout flow (submit the on-chain txHash, or an ADMIN/ACCOUNTANT manual
 * override) lives here so it can be shared, unchanged, between:
 *   - `PayoutDetailDialog` — the existing standalone dialog, opened from the
 *     inline «Оплатить» pill on an already-created payout row.
 *   - `CompanySharePayoutModal` — step 2 (embedded, no own <Dialog>), reached
 *     right after the SENIOR/DROP creates a new payout request.
 *
 * `active` replaces the old dialog's `open` prop — it drives the
 * enabled-state of the payout query AND the reset-on-activate effect. Each
 * caller passes whatever "this sub-screen is currently the visible one"
 * signal makes sense for it (PayoutDetailDialog: `open`; the modal's step 2:
 * `step === 'pay'`).
 */

// Dev-only escape hatch — see PayoutDetailDialog original comment. Tree-shaken
// out of `pnpm build` (import.meta.env.DEV becomes the literal `false`).
export const SHOW_DEV_SIMULATE = import.meta.env.DEV

export type SimulateMode = 'success' | 'error' | 'real'

// On-chain submit state machine (Phase 8 v2 design spec §3.5).
export type OnChainStatus = 'idle' | 'validating' | 'confirmed' | 'rejected'

// Auto-close delay after a confirmed on-chain payout (design spec §3.5).
export const CONFIRMED_AUTOCLOSE_MS = 1500

export function usePayoutPaymentForm(
  payoutId: string | null,
  active: boolean,
  options?: { onAutoClose?: () => void },
) {
  const { t } = useLingui()
  const qc = useQueryClient()

  const [txHash, setTxHash] = useState('')
  const [copied, setCopied] = useState(false)
  const [onChainStatus, setOnChainStatus] = useState<OnChainStatus>('idle')
  // Default to «real» — see original PayoutDetailDialog comment: forces a
  // conscious dev-mode choice instead of accidentally submitting a stub.
  const [simulateMode, setSimulateMode] = useState<SimulateMode>('real')

  // Manual-override (ADMIN/ACCOUNTANT) local state.
  const [manualMethod, setManualMethod] = useState<ManualPayoutMethod>('COMPANY_ACCOUNT')
  const [manualNote, setManualNote] = useState('')
  const [manualTxHash, setManualTxHash] = useState('')
  const [payoutDate, setPayoutDate] = useState(kyivToday)

  const autoCloseRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onAutoCloseRef = useRef(options?.onAutoClose)
  onAutoCloseRef.current = options?.onAutoClose

  const payoutQuery = useQuery({
    queryKey: ['payout-request', payoutId],
    queryFn: () => financeApi.getPayoutRequest(payoutId!),
    enabled: active && !!payoutId,
  })
  const payout = payoutQuery.data
  const payoutTx = payout?.transactions?.find((tx) => tx.type === 'PAYOUT')
  const payoutMinDate = payoutTx
    ? new Date(payoutTx.txDate ?? payoutTx.createdAt).toISOString().slice(0, 10)
    : (payout?.createdAt.slice(0, 10) ?? '')

  // Reset local state whenever this sub-screen becomes active with a
  // (possibly new) payout id — mirrors the original open→open-with-new-id effect.
  useEffect(() => {
    if (active) {
      setTxHash('')
      setCopied(false)
      setOnChainStatus('idle')
      setSimulateMode('real')
      setManualMethod('COMPANY_ACCOUNT')
      setManualNote('')
      setManualTxHash('')
      setPayoutDate(kyivToday())
    }
  }, [active, payoutId])

  useEffect(() => {
    if (!active || !payoutMinDate) return
    const today = kyivToday()
    setPayoutDate(payoutMinDate > today ? payoutMinDate : today)
  }, [active, payoutId, payoutMinDate])

  useEffect(() => {
    return () => {
      if (autoCloseRef.current) clearTimeout(autoCloseRef.current)
    }
  }, [])

  function invalidatePayoutQueries() {
    void qc.invalidateQueries({ queryKey: ['transactions'] })
    void qc.invalidateQueries({ queryKey: ['payout-requests'] })
    void qc.invalidateQueries({ queryKey: ['payout-request', payoutId] })
    void qc.invalidateQueries({ queryKey: ['finance-summary'] })
    void qc.invalidateQueries({ queryKey: ['company-account'] })
    void qc.invalidateQueries({ queryKey: ['notifications'] })
  }

  const payMutation = useMutation({
    mutationFn: () => {
      const simulateResult = SHOW_DEV_SIMULATE && simulateMode !== 'real' ? simulateMode : undefined
      const trimmedHash = txHash.trim()
      const hashField =
        simulateResult !== undefined
          ? trimmedHash.length > 0
            ? { txHash: trimmedHash }
            : {}
          : { txHash: trimmedHash }
      return financeApi.payPayoutRequest(payoutId!, {
        ...hashField,
        ...(simulateResult !== undefined && { simulateResult }),
        txDate: payoutDate,
      })
    },
    onMutate: () => {
      setOnChainStatus('validating')
    },
    onSuccess: () => {
      setOnChainStatus('confirmed')
      invalidatePayoutQueries()
      toast.success(t`Оплату підтверджено`, {
        description: t`Транзакції переведено в статус ОПЛАЧЕНО, рахунки згенеровано.`,
      })
      autoCloseRef.current = setTimeout(() => {
        onAutoCloseRef.current?.()
      }, CONFIRMED_AUTOCLOSE_MS)
    },
    onError: (err) => {
      setOnChainStatus('rejected')
      toast.error(t`Не вдалося підтвердити оплату`, {
        description: getApiErrorMessage(err),
      })
    },
  })

  const manualMutation = useMutation({
    mutationFn: () => {
      const trimmedNote = manualNote.trim()
      const trimmedHash = manualTxHash.trim()
      return financeApi.manualConfirmPayout(payoutId!, {
        method: manualMethod,
        ...(trimmedNote.length > 0 ? { note: trimmedNote } : {}),
        ...(manualMethod !== 'CASH' && trimmedHash.length > 0 ? { txHash: trimmedHash } : {}),
        txDate: payoutDate,
      })
    },
    onSuccess: () => {
      invalidatePayoutQueries()
      toast.success(t`Виплату підтверджено вручну`, {
        description:
          manualMethod === 'COMPANY_ACCOUNT'
            ? t`Баланс рахунку компанії поповнено.`
            : t`Виплату переведено в статус ОПЛАЧЕНО.`,
      })
      onAutoCloseRef.current?.()
    },
    onError: (err) => {
      toast.error(t`Не вдалося підтвердити вручну`, {
        description: getApiErrorMessage(err),
      })
    },
  })

  const resetLocal = useCallback(() => {
    if (autoCloseRef.current) {
      clearTimeout(autoCloseRef.current)
      autoCloseRef.current = null
    }
    setTxHash('')
    setCopied(false)
    setOnChainStatus('idle')
  }, [])

  async function copyAddress(address: string) {
    try {
      await navigator.clipboard.writeText(address)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error(t`Не вдалося скопіювати. Виділіть адресу вручну.`)
    }
  }

  const payError = payMutation.error ? getApiErrorMessage(payMutation.error) : null
  const isPaid = payout?.status === 'PAID'

  // Submit gate (PR #56 logic preserved) — shared so callers' footer buttons
  // never re-derive/duplicate this condition (design spec §7.6).
  const isSimulate = SHOW_DEV_SIMULATE && (simulateMode === 'success' || simulateMode === 'error')
  const realModeBlocked = SHOW_DEV_SIMULATE && simulateMode === 'real'
  const hashTooShort = txHash.trim().length < 10
  const submitDisabled =
    payMutation.isPending || realModeBlocked || (!isSimulate && hashTooShort)

  return {
    payoutQuery,
    payout,
    txHash,
    setTxHash,
    copied,
    copyAddress,
    onChainStatus,
    simulateMode,
    setSimulateMode,
    manualMethod,
    setManualMethod,
    manualNote,
    setManualNote,
    manualTxHash,
    setManualTxHash,
    payoutDate,
    setPayoutDate,
    payoutMinDate,
    payMutation,
    payError,
    manualMutation,
    isPaid,
    submitDisabled,
    resetLocal,
  }
}

export type PayoutPaymentFormState = ReturnType<typeof usePayoutPaymentForm>
