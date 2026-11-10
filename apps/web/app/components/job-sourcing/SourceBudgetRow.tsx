import type { JobSourceDto } from '@crm/shared'

/**
 * Remaining request budget of one source — task-vacancy-matching AC7 (moved out of
 * `SourceBudgetPanel.tsx` in task 7.5 so the panel and `SourceSwitchCard` do not import each other).
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

/** Sits inside a `SourceSwitchCard`, which already names the source and draws the box. */
export function SourceBudgetRow({ source }: { source: JobSourceDto }) {
  const { state, limit, window, used, remaining, resetsAt } = source.budget
  const root =
    'flex flex-col gap-0.5 text-xs sm:flex-row sm:items-center sm:justify-between sm:gap-3'
  const name = (
    <span className="font-medium text-foreground">
      <span className="font-normal text-muted-foreground">
        ({TRIGGER_LABEL[source.triggerMode]})
      </span>
    </span>
  )

  // Code review MED-4: this used to be inferred here as
  // `limit === null || window === null`, which read a MISCONFIGURED source — a
  // cap the collector cannot use, so it refuses every request — as "без лимита
  // запросов", i.e. showed a hard stop as no restriction at all. The server now
  // states which case this is; the UI only renders it.
  if (state === 'MISCONFIGURED') {
    return (
      <div data-testid="job-source-budget-row" data-source-type={source.type} className={root}>
        {name}
        <span className="font-medium text-destructive" data-testid="job-source-budget-broken">
          Лимит настроен неверно — сбор остановлен. Проверьте настройки источника.
        </span>
      </div>
    )
  }

  const unlimited = state === 'UNLIMITED'
  const exhausted = state === 'EXHAUSTED'

  return (
    <div data-testid="job-source-budget-row" data-source-type={source.type} className={root}>
      {name}

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
          {/* `window` is non-null whenever the server says ACTIVE/EXHAUSTED —
              a cap without a window is MISCONFIGURED and returned above. The
              fallback keeps that a rendering detail rather than a crash. */}
          {window ? WINDOW_LABEL[window] : ''}
          {/* The reset instant is the actionable half — without it "исчерпан"
              tells an operator nothing they can plan around. */}
          {resetsAt && <span> · обновится {formatResetAt(resetsAt)}</span>}
          {!exhausted && used > 0 && <span className="sr-only"> (израсходовано {used})</span>}
        </span>
      )}
    </div>
  )
}
