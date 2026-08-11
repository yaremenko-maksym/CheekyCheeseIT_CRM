import type { JobSourceDto } from '@crm/shared'
import { useJobSources } from '@/hooks/use-job-sourcing'

/**
 * Remaining request budget per source — task-vacancy-matching AC7.
 *
 * WHY IT IS ON SCREEN AT ALL. External job APIs meter us hard (JSearch: 200 a
 * MONTH). When an allowance runs out the collector refuses to fetch, and from
 * the outside that is byte-for-byte identical to a quiet day: no new vacancies,
 * no error. The same "breakage disguised as silence" problem the collector
 * already solved for broken feeds, one level further out — so the remainder is
 * shown before it matters, not explained after it does.
 *
 * The copy follows ResumeStatusPanel's quota case, which is the pattern this
 * codebase already settled on: name the number, name WHEN it comes back, and
 * never say only "лимит исчерпан".
 */

/** Human window name — the unit the remainder is measured in. */
const WINDOW_LABEL: Record<'DAY' | 'MONTH', string> = {
  DAY: 'в сутки',
  MONTH: 'в месяц',
}

const TRIGGER_LABEL: Record<JobSourceDto['triggerMode'], string> = {
  SCHEDULED: 'по расписанию',
  MANUAL: 'по кнопке',
  BOTH: 'по расписанию и по кнопке',
}

export function formatResetAt(iso: string | null): string {
  if (!iso) return ''
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  return at.toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function SourceBudgetRow({ source }: { source: JobSourceDto }) {
  const { limit, window, used, remaining, resetsAt } = source.budget
  const unlimited = limit === null || window === null
  const exhausted = !unlimited && (remaining ?? 0) <= 0

  return (
    <li
      data-testid="job-source-budget-row"
      data-source-type={source.type}
      className="flex flex-col gap-0.5 rounded-md border border-border/60 px-3 py-2 text-xs sm:flex-row sm:items-center sm:justify-between sm:gap-3"
    >
      <span className="font-medium text-foreground">
        {source.type}
        <span className="ml-1.5 font-normal text-muted-foreground">
          ({TRIGGER_LABEL[source.triggerMode]})
        </span>
      </span>

      {unlimited ? (
        <span className="text-muted-foreground" data-testid="job-source-budget-unlimited">
          Без лимита запросов
        </span>
      ) : (
        <span
          data-testid="job-source-budget-remaining"
          className={exhausted ? 'font-medium text-destructive' : 'text-muted-foreground'}
        >
          {exhausted ? 'Лимит исчерпан' : `Осталось ${remaining} из ${limit}`}{' '}
          {WINDOW_LABEL[window]}
          {/* The reset instant is the actionable half — without it "исчерпан"
              tells an operator nothing they can plan around. */}
          {resetsAt && <span> · обновится {formatResetAt(resetsAt)}</span>}
          {!exhausted && used > 0 && <span className="sr-only"> (израсходовано {used})</span>}
        </span>
      )}
    </li>
  )
}

/**
 * ADMIN-only budget list. Renders nothing at all for other roles (the query is
 * disabled), rather than an empty box that invites "why is this empty?".
 */
export function SourceBudgetPanel({ canView }: { canView: boolean }) {
  const { data, isLoading, isError } = useJobSources(canView)

  if (!canView) return null

  return (
    <section className="mt-6 border-t border-border/50 pt-4" data-testid="job-source-budgets">
      <h3 className="text-sm font-medium text-foreground">Бюджет источников</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Сбор останавливается, когда запросы источника закончились — и ручной запуск тратит тот же
        лимит.
      </p>

      {isLoading && <p className="mt-3 text-xs text-muted-foreground">Загрузка…</p>}

      {isError && !isLoading && (
        <p className="mt-3 text-xs text-destructive" data-testid="job-source-budgets-error">
          Не удалось загрузить состояние источников.
        </p>
      )}

      {!isLoading && !isError && (
        <ul className="mt-3 flex flex-col gap-2">
          {data?.items.map((source) => (
            <SourceBudgetRow key={source.id} source={source} />
          ))}
          {(data?.items.length ?? 0) === 0 && (
            <li className="text-xs text-muted-foreground">Источники не настроены.</li>
          )}
        </ul>
      )}
    </section>
  )
}
