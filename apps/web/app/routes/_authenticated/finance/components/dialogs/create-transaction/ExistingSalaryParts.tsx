import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { useQuery } from '@tanstack/react-query'
import { formatDate, formatMoney } from '@crm/shared'
import { useLocale } from '@/lib/i18n'
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
  const locale = useLocale()
  const enabled = receiverId !== '' && /^\d{4}-(0[1-9]|1[0-2])$/.test(salaryMonth)
  const { data } = useQuery({
    queryKey: ['finance', 'salary-parts', receiverId, salaryMonth],
    queryFn: () => financeApi.getSalaryParts(receiverId, salaryMonth),
    enabled,
    // The answer is only interesting while the dialog is open, and a part the
    // operator adds has to show up in the list if they come back for a second.
    staleTime: 0,
  })

  // One guard, not three conditions. A disabled query and an in-flight one both
  // leave `data` undefined, so `!enabled` and `isLoading` were each already
  // answered by the empty list below — the mutation gate found both arms
  // unobservable, which is what "redundant" means when it is measured rather
  // than argued. Removed rather than suppressed: a condition no test can break
  // is a condition that is not doing anything.
  const parts = data?.parts ?? []
  if (parts.length === 0) return null

  return (
    <div
      className="mt-2 space-y-1 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2"
      data-testid="create-transaction-existing-salary-parts"
    >
      {/* COPY-M-1: the heading NAMES the state — these are parts already on
          record — rather than only counting rows, because the panel's purpose
          is to warn against re-recording one. COPY-H-1: the count noun uses the
          Lingui `Plural` macro with uk one/few/many forms; the old 1-vs-else
          branch rendered "5 частини" / "21 частини", both ungrammatical. */}
      <p
        className="text-[11px] font-medium text-amber-600 dark:text-amber-400"
        data-testid="create-transaction-existing-salary-parts-heading"
      >
        <Trans>
          Вже внесено за цей місяць:{' '}
          <Plural
            value={parts.length}
            one="# частина зарплати"
            few="# частини зарплати"
            many="# частин зарплати"
            other="# частини зарплати"
          />
        </Trans>
      </p>
      <ul className="space-y-0.5">
        {parts.map((part) => (
          <li
            key={part.id}
            className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground"
            data-testid="create-transaction-existing-salary-part"
          >
            {/* `flex-wrap`: the row now carries a date as well as amount, status
                and origin, so at 320px (verified by QA before the date existed)
                the right group drops to a second line instead of overflowing. */}
            <span className="flex items-center gap-1.5">
              {/* QA-LOW-2: the business date — what this whole PR is about — so an
                  operator can RECOGNISE a part they already recorded rather than
                  tell two apart only by the origin label. Same locale-aware
                  `formatDate`/`shortYY` the finance table's own date column uses.
                  Guarded: a legacy row may carry no date. */}
              {part.txDate && (
                <span className="tabular-nums text-[10px] text-muted-foreground">
                  {formatDate(part.txDate, locale, 'shortYY')}
                </span>
              )}
              {/* COPY-M-2: format in the ACTIVE locale, not a hardcoded 'uk-UA',
                  through the same shared `formatMoney` the finance table uses
                  (`fmtAmount`) — so the en screen shows en separators. It also
                  joins amount and currency, so there is no stray space to orphan
                  the code onto its own line at 320px. */}
              <span className="tabular-nums font-medium text-foreground">
                {formatMoney(part.amount, part.currency, locale)}
              </span>
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
