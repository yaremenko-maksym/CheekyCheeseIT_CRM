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
      {/* QA-LOW-1: `space-y-0.5` left only 2px between rows, so at 320px — where
          every row wraps to two lines — a row's second line sat as close to the
          NEXT row's first line as to its own, and you had to pair them by eye.
          On a panel whose job is recognising WHICH part you already recorded,
          that is the row-level form of the same ambiguity the separators fix.
          Vertical spacing cannot create horizontal overflow, so QA's
          no-overflow finding is unaffected by this. */}
      <ul className="space-y-1.5">
        {parts.map((part) => (
          <li
            key={part.id}
            className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-muted-foreground"
            data-testid="create-transaction-existing-salary-part"
          >
            {/* COPY-M-3 — ONE flowing line of fields, each pair divided by a real
                `·`, instead of two groups held apart by `justify-between`.
                Separated by layout alone the row emitted
                "24.10.261 234,50 EURОчікує валідаціївручну": a date fused to an
                amount reads as a single plausible-but-wrong NUMBER, which on a
                panel for recognising a recorded part is the same family of
                defect as everything else this PR fixes — a surface that looks
                right and conveys something false. Dropping `justify-between`
                also removes the structural oddity QA noted, where a dateless row
                stayed on one line with its status right-aligned while its
                wrapped neighbours read left-to-right.
                `aria-hidden` on every separator: it is punctuation, so a screen
                reader gets the four labels and not four stray dots.
                `flex-wrap` is retained, so a separator can only move WHERE the
                row wraps, never whether it fits. */}
            {part.txDate && (
              <>
                {/* QA-LOW-2: the business date — what this whole PR is about — so
                    an operator can RECOGNISE a part they already recorded rather
                    than tell two apart only by the origin label. Same locale-aware
                    `formatDate`/`shortYY` the finance table's own date column uses.
                    Guarded, with its separator inside the guard so a dateless
                    legacy row cannot start with a dangling `·`. */}
                <span className="tabular-nums text-[10px] text-muted-foreground">
                  {formatDate(part.txDate, locale, 'shortYYUtc')}
                </span>
                <span aria-hidden="true">·</span>
              </>
            )}
            {/* COPY-M-2: format in the ACTIVE locale, not a hardcoded 'uk-UA',
                through the same shared `formatMoney` the finance table uses
                (`fmtAmount`) — so the en screen shows en separators. It also
                joins amount and currency, so the code cannot orphan onto its own
                line at 320px. */}
            <span className="tabular-nums font-medium text-foreground">
              {formatMoney(part.amount, part.currency, locale)}
            </span>
            <span aria-hidden="true">·</span>
            {/* The same localized status wording the finance table uses — reused
                rather than restated so the two cannot drift. */}
            <span>{i18n._(STATUS_LABEL_MESSAGES[part.status])}</span>
            <span aria-hidden="true">·</span>
            <span className="text-[10px]">
              {/* COPY-M-4: a FINITE VERB, not a bare adverb. "вручну" alone in
                  the final slot has no subject of its own, so it attaches to the
                  preceding verb phrase and the row reads "Очікує валідації ·
                  вручну" as "awaiting validation, done by hand" — a claim about
                  the VALIDATION. The field means how the PART was entered.
                  "Внесено" gives it its own subject, and borrows the heading's
                  own verb ("Вже внесено за цей місяць") so the row echoes the
                  panel's framing instead of fighting it. Same defect class as
                  the run-together text this follows: a readable surface saying
                  the wrong thing.
                  A NULL origin is a row written before the column existed; every
                  predicate on the server reads it as automatic. */}
              {part.salaryOrigin === 'MANUAL' ? (
                <Trans>Внесено вручну</Trans>
              ) : (
                <Trans>Внесено автоматично</Trans>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
