import { Trans, useLingui } from '@lingui/react/macro'
import { useQuery } from '@tanstack/react-query'
import { financeApi } from '../../../api'
import { STATUS_LABEL_MESSAGES } from '../../../constants'

/**
 * SR-795-M-1 / owner decision D-3, second half. Several salary parts per
 * employee and month are legal by design, so the server cannot refuse the
 * second one — which is exactly why the operator has to see the first. The
 * measured defect: an operator who hit the idempotency conflict and reopened
 * this dialog (which mints a fresh key) produced a second and then a third row,
 * never once being shown that the month already carried a salary.
 *
 * Deliberately NOT a warning or a blocker: on a month that already has a part,
 * adding another is a normal thing to do. This states what is there and leaves
 * the judgement with the operator.
 */
export function ExistingSalaryParts({
  receiverId,
  salaryMonth,
}: {
  receiverId: string
  salaryMonth: string
}) {
  const { i18n } = useLingui()
  const enabled = receiverId !== '' && /^\d{4}-(0[1-9]|1[0-2])$/.test(salaryMonth)
  const { data, isLoading } = useQuery({
    queryKey: ['finance', 'salary-parts', receiverId, salaryMonth],
    queryFn: () => financeApi.getSalaryParts(receiverId, salaryMonth),
    enabled,
    // The answer is only interesting while the dialog is open, and a part the
    // operator adds has to show up in the list if they come back for a second.
    staleTime: 0,
  })

  if (!enabled || isLoading) return null
  const parts = data?.parts ?? []
  if (parts.length === 0) return null

  return (
    <div
      className="mt-2 space-y-1 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2"
      data-testid="create-transaction-existing-salary-parts"
    >
      <p className="text-[11px] font-medium text-amber-600 dark:text-amber-400">
        {parts.length === 1 ? (
          <Trans>Цей місяць уже має 1 частину зарплати</Trans>
        ) : (
          <Trans>Цей місяць уже має {parts.length} частини зарплати</Trans>
        )}
      </p>
      <ul className="space-y-0.5">
        {parts.map((part) => (
          <li
            key={part.id}
            className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground"
            data-testid="create-transaction-existing-salary-part"
          >
            <span className="tabular-nums font-medium text-foreground">
              {part.amount.toLocaleString('uk-UA', { maximumFractionDigits: 2 })} {part.currency}
            </span>
            <span className="flex items-center gap-1.5">
              {/* The same localized status wording the finance table uses —
                  reused rather than restated so the two cannot drift. */}
              <span>{i18n._(STATUS_LABEL_MESSAGES[part.status])}</span>
              <span className="text-[10px]">
                {/* A NULL origin is a row written before the column existed;
                    every predicate on the server reads it as automatic. */}
                {part.salaryOrigin === 'MANUAL' ? (
                  <Trans>вручну</Trans>
                ) : (
                  <Trans>автоматично</Trans>
                )}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
