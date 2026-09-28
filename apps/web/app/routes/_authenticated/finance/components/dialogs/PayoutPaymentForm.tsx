import {
  Banknote,
  Check,
  CheckCircle2,
  Coins,
  Copy,
  ExternalLink,
  Link2,
  Loader2,
  Settings2,
  Wallet,
  XCircle,
} from 'lucide-react'
import { Trans, useLingui } from '@lingui/react/macro'
import { i18n } from '@lingui/core'
import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import type { ManualPayoutMethod } from '@crm/shared'
import { formatDate } from '@crm/shared'
import { useLocale } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { fmtAmount, STATUS_COLORS, STATUS_LABEL_MESSAGES } from '../../constants'
import {
  isBundledIncomeTransaction,
  isPayoutObligationTransaction,
} from '../../utils/company-share'
import { SHOW_DEV_SIMULATE, type PayoutPaymentFormState } from '../../hooks/usePayoutPaymentForm'

/**
 * task-i18n-stage3d-pr4 (template G-fin, COPY-M-fin-10). Manual-confirm
 * payment methods — `satisfies` WITHOUT `as const` (урок #707: `as const
 * satisfies` disables Stryker for the whole block).
 */
const MANUAL_METHOD_MESSAGES = {
  CASH: msg`Готівка`, // en: Cash
  ADMIN_USDT: msg`USDT партнера`, // en: Partner's USDT
  COMPANY_ACCOUNT: msg`Рахунок компанії`, // en: Company account
} satisfies Record<ManualPayoutMethod, MessageDescriptor>

const MANUAL_METHOD_ICONS: Record<ManualPayoutMethod, React.ReactNode> = {
  CASH: <Banknote className="h-3.5 w-3.5" />,
  ADMIN_USDT: <Wallet className="h-3.5 w-3.5" />,
  COMPANY_ACCOUNT: <Coins className="h-3.5 w-3.5" />,
}

const MANUAL_METHODS: ManualPayoutMethod[] = ['CASH', 'ADMIN_USDT', 'COMPANY_ACCOUNT']

/**
 * PayoutPaymentForm — the BODY of "step 2" of the payout flow, extracted
 * unchanged from `PayoutDetailDialog.tsx` (task-company-share-cta §7.3 of the
 * design spec). Instruction card / transactions-in-payout list / tx-hash
 * input / dev-simulate radiogroup / on-chain status block / manual-confirm
 * section (ADMIN/ACCOUNTANT) — same JSX, same logic, now reading from the
 * shared `usePayoutPaymentForm` hook state instead of local closures.
 *
 * Purely presentational — does NOT own a `<Dialog>`/`<CrmDialogContent>` or a
 * footer. Callers:
 *   - `PayoutDetailDialog` wraps this in its own `<Dialog>` + header + footer
 *     (existing behaviour, unchanged).
 *   - `CompanySharePayoutModal` step 2 renders this directly inside its
 *     already-open dialog shell, with its own header/footer.
 */
export function PayoutPaymentForm({
  state,
  canManualConfirm,
}: {
  state: PayoutPaymentFormState
  canManualConfirm: boolean
}) {
  const { t } = useLingui()
  const locale = useLocale()
  const {
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
    payMutation,
    payError,
    manualMutation,
    isPaid,
  } = state

  return (
    <div className="space-y-4">
      {payoutQuery.isLoading && (
        <div className="space-y-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-20 w-full" />
        </div>
      )}

      {payoutQuery.isError && (
        <p className="text-sm text-destructive">
          <Trans>Не вдалося завантажити дані виплати. Спробуйте пізніше.</Trans>
        </p>
      )}

      {payout && (
        <>
          {/* Instruction card — PRIMARY. Combines «сколько» (amount) and
              «куда» (company wallet address) so the SENIOR reads it top-down
              as a single transfer instruction (design spec §3.2). */}
          <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
            {/* Amount row */}
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground shrink-0">
                <Trans>До сплати</Trans>
              </span>
              <span
                className="text-xl font-bold tabular-nums text-primary"
                data-testid="payout-detail-payable"
              >
                {fmtAmount(payout.payableAmount, 'USDT')}
              </span>
            </div>

            {/* Divider */}
            <div className="border-t border-border/40" />

            {/* Address row */}
            <div className="space-y-1">
              <p
                className="text-xs text-muted-foreground"
                data-testid="payout-detail-contract-address-label"
              >
                <Trans>Адреса гаманця компанії (USDT ERC-20):</Trans>
              </p>
              {payout.contractAddress ? (
                <div className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2">
                  <code
                    className="flex-1 text-xs font-mono break-all min-w-0 text-foreground/90"
                    data-testid="payout-detail-contract-address"
                  >
                    {payout.contractAddress}
                  </code>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 px-0 shrink-0"
                    onClick={() => copyAddress(payout.contractAddress)}
                    aria-label={t`Копіювати адресу`}
                    data-testid="payout-detail-copy-address"
                  >
                    {copied ? (
                      <Check className="h-3.5 w-3.5 text-emerald-500" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </div>
              ) : (
                <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2">
                  <p className="text-xs text-destructive/80">
                    <Trans>Адресу не налаштовано</Trans>
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    <Trans>Зверніться до адміністратора.</Trans>
                  </p>
                </div>
              )}
              <p className="text-[11px] text-muted-foreground">
                <Trans>
                  Переведіть {fmtAmount(payout.payableAmount, 'USDT')} на адресу гаманця компанії
                  (ERC-20), потім вставте хеш транзакції.
                </Trans>
              </p>
            </div>
          </div>

          {/* Transactions in this payout. Originally SENIOR_INCOME-only (PR
              #56) — fixed to the generic isIncomeTransaction filter
              (fidelity-review re-audit) because this SAME dialog is also the
              DROP payment entry point (InProgressPanel's «Оплатить» pill,
              design spec §9): the SENIOR_INCOME-only filter silently showed
              an empty list for a DROP's own payout, same root cause as the
              step-2 summary line's project-count bug.
              task-split-payouts-and-obligations (backlog 174): further
              narrowed to isBundledIncomeTransaction — isIncomeTransaction
              alone also matched a settled COMPANY→recipient obligation
              recovered onto this payout (see the obligations block below),
              which flows the OPPOSITE direction and must not join this
              count. */}
          {(() => {
            const incomeTxs =
              payout.transactions?.filter((tx) => isBundledIncomeTransaction(tx, payout.id)) ?? []
            if (incomeTxs.length === 0) return null
            return (
              <div className="space-y-1.5">
                <Label className="text-xs" data-testid="payout-detail-transactions-count">
                  <Trans>Транзакції у виплаті ({incomeTxs.length})</Trans>
                </Label>
                <div className="rounded-md border border-border divide-y divide-border max-h-40 overflow-y-auto">
                  {incomeTxs.map((tx) => (
                    <div
                      key={tx.id}
                      className="flex items-center justify-between px-3 py-2 text-xs"
                      data-testid={`payout-detail-tx-${tx.id}`}
                    >
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">{tx.projectName ?? '—'}</p>
                        <p className="text-muted-foreground">
                          <Trans>
                            #{tx.id.slice(0, 6)} від{' '}
                            {formatDate(tx.txDate ?? tx.createdAt, locale, 'shortYY')}
                          </Trans>
                        </p>
                      </div>
                      <span className="tabular-nums font-medium shrink-0">
                        {fmtAmount(tx.amount, tx.currency)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )
          })()}

          {/* task-split-payouts-and-obligations (backlog 174) — obligations
              the COMPANY owes this payout's recipient, the OPPOSITE money
              direction from the incomes above. `findPayoutRequest` recovers
              these via `pending_obligations.payoutRequestId` (settleByCompany
              resets the transaction's OWN payoutRequestId to null on settle
              — task-settle-in-place ADR), so `isPayoutObligationTransaction`
              (payoutRequestId !== payout.id) is what marks a row as
              "recovered", regardless of its type or settle status. Kept in
              its own section — never folded into "Транзакції у виплаті" —
              so that counter stays strictly about incoming money. */}
          {(() => {
            const obligationTxs =
              payout.transactions?.filter((tx) => isPayoutObligationTransaction(tx, payout.id)) ??
              []
            if (obligationTxs.length === 0) return null
            return (
              <div className="space-y-1.5">
                <Label className="text-xs" data-testid="payout-detail-obligations-count">
                  <Trans>Зобов’язання компанії ({obligationTxs.length})</Trans>
                </Label>
                {/* design-audit PR #592 (LOW): "Компанія винна" already lives
                    in the section title above AND used to open every row
                    below (see the HIGH note on the name line) — the OLD copy
                    here duplicated it AND broke mid-sentence before the em
                    dash ("винна —" with no direct object). This phrasing
                    gives "винна" an object ("ці суми") so the first clause
                    is complete, and an explicit subject ("вони") for the
                    second — no implicit-subject fragment. */}
                <p
                  className="text-[11px] text-muted-foreground"
                  data-testid="payout-detail-obligations-caption"
                >
                  <Trans>Компанія винна ці суми — вони не входять до виплати вище</Trans>
                </p>
                <div className="rounded-md border border-amber-500/30 divide-y divide-amber-500/20 max-h-40 overflow-y-auto">
                  {obligationTxs.map((tx) => (
                    <div
                      key={tx.id}
                      className="flex items-center justify-between px-3 py-2 text-xs"
                      data-testid={`payout-detail-obligation-${tx.id}`}
                    >
                      <div className="flex-1 min-w-0">
                        {/* design-audit PR #592 (HIGH): the row used to read
                            "Компанія винна {Ім'я}" — measured on a real 320px
                            DOM (getBoundingClientRect): the "Компанія винна "
                            prefix alone ate ~118px of the ~118-203px this
                            column has, so the name — the one thing this row
                            exists to show — was cut before printing a single
                            letter. The direction is already said once, in the
                            section title AND the caption above; repeating it
                            per row was also pure duplication. Name-only here,
                            AND `line-clamp-2` (not `truncate`) so a long name
                            wraps instead of losing the surname to an
                            ellipsis — the list already scrolls
                            (`max-h-40 overflow-y-auto`), vertical space is
                            cheaper than a silently-hidden name. */}
                        <p
                          className="font-medium line-clamp-2 break-words"
                          data-testid={`payout-detail-obligation-name-${tx.id}`}
                        >
                          {tx.receiverName ?? '—'}
                        </p>
                        <p className="text-muted-foreground">
                          <Trans>
                            {tx.projectName ?? '—'} · #{tx.id.slice(0, 6)} від{' '}
                            {formatDate(tx.txDate ?? tx.createdAt, locale, 'shortYY')}
                          </Trans>
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-0.5">
                        <span className="tabular-nums font-medium">
                          {fmtAmount(tx.amount, tx.currency)}
                        </span>
                        <span
                          className={cn(
                            // Stryker disable next-line StringLiteral: cosmetic Tailwind
                            // badge styling — testing-library discourages asserting
                            // implementation-detail CSS classes; the badge's TEXT
                            // (i18n._(STATUS_LABEL_MESSAGES[tx.status])) and its
                            // data-testid are both asserted directly (see the
                            // obligations-split tests).
                            'rounded-full border px-1.5 py-0 text-[9px] font-medium leading-4',
                            STATUS_COLORS[tx.status],
                          )}
                          data-testid={`payout-detail-obligation-status-${tx.id}`}
                        >
                          {i18n._(STATUS_LABEL_MESSAGES[tx.status])}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )
          })()}

          {/* TX hash — input (PENDING) or read-only display (PAID) */}
          {isPaid ? (
            <div className="space-y-1.5">
              <Label className="text-xs">
                <Trans>Хеш транзакції</Trans>
              </Label>
              <div className="flex items-center gap-2 rounded-md border border-border bg-muted/20 p-2">
                <code className="flex-1 text-xs font-mono break-all">{payout.txHash ?? '—'}</code>
                {payout.txHash && (
                  <a
                    href={`https://etherscan.io/tx/${payout.txHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-muted-foreground hover:text-foreground shrink-0"
                    aria-label={t`Відкрити в Etherscan`}
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor="payout-tx-hash-input">
                <Trans>Хеш транзакції</Trans>
                {SHOW_DEV_SIMULATE && (simulateMode === 'success' || simulateMode === 'error') ? (
                  <span className="text-muted-foreground">
                    {' '}
                    <Trans>(необов’язково в dev-режимі)</Trans>
                  </span>
                ) : (
                  <span className="text-muted-foreground">
                    {' '}
                    <Trans>(після оплати)</Trans>
                  </span>
                )}
              </Label>
              <Input
                id="payout-tx-hash-input"
                data-testid="payout-detail-tx-hash-input"
                value={txHash}
                onChange={(e) => setTxHash(e.target.value)}
                placeholder="0x..."
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                autoComplete="off"
                className="h-9 text-sm font-mono"
                disabled={payMutation.isPending || onChainStatus === 'confirmed'}
              />
              {txHash.trim().length >= 10 && (
                <a
                  href={`https://etherscan.io/tx/${txHash.trim()}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] text-primary hover:underline inline-flex items-center gap-1"
                >
                  <Trans>Відкрити в Etherscan</Trans> <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
          )}

          {SHOW_DEV_SIMULATE && !isPaid && (
            <div
              className="space-y-1.5 rounded-md border border-dashed border-amber-500/40 bg-amber-500/5 p-2.5"
              data-testid="payout-detail-dev-simulate"
              role="radiogroup"
              aria-label={t`Dev-режим: результат валідації`}
            >
              <Label className="text-xs flex items-center gap-1.5">
                <Settings2 className="h-3 w-3 shrink-0" aria-hidden="true" />
                <Trans>Dev-режим: результат валідації</Trans>
              </Label>
              <div className="flex flex-col gap-1.5">
                {(
                  [
                    {
                      value: 'success' as const,
                      icon: <CheckCircle2 className="h-3 w-3 shrink-0" aria-hidden="true" />,
                      label: <Trans>Симулювати успіх</Trans>,
                    },
                    {
                      value: 'error' as const,
                      icon: <XCircle className="h-3 w-3 shrink-0" aria-hidden="true" />,
                      label: <Trans>Симулювати помилку</Trans>,
                    },
                    {
                      value: 'real' as const,
                      icon: <Link2 className="h-3 w-3 shrink-0" aria-hidden="true" />,
                      // COPY-M-fin-10: «Реальна перевірка (недоступно в dev)» read
                      // as internal jargon leaking to the operator — the honest
                      // sentence says WHAT is unavailable and WHERE.
                      label: (
                        <Trans>Перевірка в блокчейні (недоступна в тестовому середовищі)</Trans>
                      ),
                    },
                  ] as const
                ).map((opt) => {
                  const selected = simulateMode === opt.value
                  return (
                    <label
                      key={opt.value}
                      className={cn(
                        'flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs cursor-pointer transition-colors',
                        selected
                          ? 'border-primary bg-primary/10 text-foreground'
                          : 'border-border bg-background hover:bg-muted/40 text-muted-foreground',
                      )}
                      data-testid={`payout-detail-dev-simulate-${opt.value}`}
                    >
                      <input
                        type="radio"
                        name="payout-simulate-mode"
                        value={opt.value}
                        checked={selected}
                        onChange={() => setSimulateMode(opt.value)}
                        disabled={payMutation.isPending}
                        className="h-3 w-3 accent-primary shrink-0"
                      />
                      {opt.icon}
                      <span>{opt.label}</span>
                    </label>
                  )
                })}
              </div>
              <p className="text-[11px] text-muted-foreground">
                <Trans>
                  Доступно лише в dev-збірці. Оберіть «успіх» або «помилку», щоб розблокувати
                  «Підтвердити оплату».
                </Trans>
              </p>
            </div>
          )}

          {/* On-chain validation status block (design spec §3.5). */}
          {!isPaid && onChainStatus !== 'idle' && (
            <div
              data-testid="payout-detail-on-chain-status"
              data-status={onChainStatus}
              className="animate-in fade-in-0 slide-in-from-bottom-1 duration-200"
            >
              {onChainStatus === 'validating' && (
                <div
                  role="status"
                  aria-live="polite"
                  className="flex items-center gap-2.5 rounded-md border border-border bg-muted/30 px-3 py-2.5"
                >
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground shrink-0" />
                  <div>
                    <p className="text-xs font-medium">
                      <Trans>Перевірка on-chain…</Trans>
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      <Trans>Запит до Etherscan, займе кілька секунд</Trans>
                    </p>
                  </div>
                </div>
              )}
              {onChainStatus === 'confirmed' && (
                <div
                  role="status"
                  aria-live="polite"
                  className="flex items-center gap-2.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5"
                >
                  <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
                  <div>
                    <p className="text-xs font-medium text-emerald-400">
                      <Trans>Транзакцію підтверджено</Trans>
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      <Trans>Виплату переведено у статус ОПЛАЧЕНО</Trans>
                    </p>
                  </div>
                </div>
              )}
              {onChainStatus === 'rejected' && (
                <div
                  role="alert"
                  className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2.5 space-y-1"
                >
                  <div className="flex items-center gap-2">
                    <XCircle className="h-4 w-4 text-destructive shrink-0" />
                    <p className="text-xs font-medium text-destructive">
                      <Trans>Транзакцію не прийнято</Trans>
                    </p>
                  </div>
                  <p className="text-[11px] text-muted-foreground pl-6">
                    {payError ?? t`Не вдалося підтвердити оплату.`}
                  </p>
                  <p className="text-[11px] text-muted-foreground/60 pl-6">
                    <Trans>
                      Перевірте хеш і спробуйте знову, або скористайтеся ручним підтвердженням.
                    </Trans>
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Manual override section — ADMIN/ACCOUNTANT only, hidden once the
              payout is PAID (design spec §3.7). */}
          {canManualConfirm && !isPaid && (
            <div className="space-y-3" data-testid="payout-detail-manual-section">
              <div className="relative my-1">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-border/50" />
                </div>
                <div className="relative flex justify-center">
                  <span className="bg-card px-2 text-[10px] text-muted-foreground uppercase tracking-wider">
                    <Trans>Ручне підтвердження</Trans>
                  </span>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">
                  <Trans>Метод оплати</Trans>
                </Label>
                <div
                  role="radiogroup"
                  aria-label={t`Метод ручного підтвердження`}
                  className="grid grid-cols-3 gap-2 max-sm:grid-cols-1"
                >
                  {MANUAL_METHODS.map((m) => {
                    const active = manualMethod === m
                    return (
                      <button
                        key={m}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        onClick={() => setManualMethod(m)}
                        data-testid={`payout-detail-manual-method-${m.toLowerCase()}`}
                        className={cn(
                          'flex flex-col items-center gap-1 rounded-lg border px-2 py-2 text-[11px] font-medium transition-colors cursor-pointer',
                          active
                            ? 'border-primary bg-primary/10 text-foreground'
                            : 'border-border bg-muted/20 text-muted-foreground hover:bg-muted/40',
                        )}
                      >
                        {MANUAL_METHOD_ICONS[m]}
                        <span>{i18n._(MANUAL_METHOD_MESSAGES[m])}</span>
                      </button>
                    )
                  })}
                </div>
                {manualMethod === 'COMPANY_ACCOUNT' && (
                  <p className="text-[11px] text-primary/80 flex items-center gap-1">
                    <Coins className="h-3 w-3 shrink-0" />
                    <Trans>Цей метод поповнює баланс рахунку компанії</Trans>
                  </p>
                )}
              </div>

              <div className="space-y-1">
                <Label className="text-xs" htmlFor="payout-manual-note">
                  <Trans>
                    Примітка <span className="text-muted-foreground">(необов’язково)</span>
                  </Trans>
                </Label>
                <Textarea
                  id="payout-manual-note"
                  data-testid="payout-detail-manual-note"
                  rows={2}
                  value={manualNote}
                  onChange={(e) => setManualNote(e.target.value)}
                  placeholder={t`Вкажіть деталі ручного підтвердження`}
                  className="text-xs resize-none"
                />
              </div>

              {manualMethod !== 'CASH' && (
                <div className="space-y-1">
                  <Label className="text-xs" htmlFor="payout-manual-tx-hash">
                    <Trans>
                      Хеш транзакції <span className="text-muted-foreground">(необов’язково)</span>
                    </Trans>
                  </Label>
                  <Input
                    id="payout-manual-tx-hash"
                    data-testid="payout-detail-manual-tx-hash"
                    value={manualTxHash}
                    onChange={(e) => setManualTxHash(e.target.value)}
                    placeholder="0x..."
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    autoComplete="off"
                    className="h-8 text-xs font-mono"
                  />
                </div>
              )}

              <Button
                variant="outline"
                size="sm"
                onClick={() => manualMutation.mutate()}
                disabled={manualMutation.isPending}
                className="w-full mt-1"
                data-testid="payout-detail-manual-submit"
              >
                {manualMutation.isPending ? (
                  <Trans>Збереження…</Trans>
                ) : (
                  <Trans>Підтвердити вручну</Trans>
                )}
              </Button>
            </div>
          )}

          {payError && onChainStatus !== 'rejected' && (
            <p className="text-xs text-destructive">{payError}</p>
          )}
        </>
      )}
    </div>
  )
}
