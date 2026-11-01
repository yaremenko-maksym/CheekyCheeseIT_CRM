import { useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useForm } from '@tanstack/react-form'
import { ArrowLeft } from 'lucide-react'
import { Trans, useLingui } from '@lingui/react/macro'
import {
  createJobSourceNoteSchema,
  type JobSourceRunDto,
  type JobSourceTimelineEventDto,
} from '@crm/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { useAddJobSourceNote, useJobSourceDetail } from '@/hooks/use-job-source-admin'
import {
  outcomeBadgeVariant,
  stateBadgeVariant,
  useSourceHealthLabels,
} from '@/components/job-sourcing/use-source-health-labels'

export const Route = createFileRoute('/_authenticated/admin/sources/$sourceId')({
  component: SourceDetailPage,
})

function useDateTime() {
  const { i18n } = useLingui()
  return (iso: string | null): string => {
    if (!iso) return '—'
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return '—'
    return new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
      d,
    )
  }
}

function RunRow({ run, fmt }: { run: JobSourceRunDto; fmt: (iso: string | null) => string }) {
  const { outcomeLabel } = useSourceHealthLabels()
  return (
    <li
      className="flex flex-col gap-1 rounded-md border border-border/50 px-3 py-2 text-xs sm:flex-row sm:items-center sm:justify-between"
      data-testid="job-source-run-row"
    >
      <span className="font-medium text-foreground tabular-nums">{fmt(run.startedAt)}</span>
      <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-muted-foreground">
        <Badge variant={outcomeBadgeVariant(run.outcome)}>{outcomeLabel(run.outcome)}</Badge>
        <span className="tabular-nums">
          <Trans>
            отримано {run.received ?? 0}, нових {run.created ?? 0}, відхилено {run.invalid ?? 0}
          </Trans>
        </span>
        {run.lastHttpStatus !== null && (
          <span className="tabular-nums">HTTP {run.lastHttpStatus}</span>
        )}
        {run.adapterVersion && (
          <span>
            <Trans>адаптер {run.adapterVersion}</Trans>
          </span>
        )}
      </span>
    </li>
  )
}

function EventRow({
  event,
  fmt,
}: {
  event: JobSourceTimelineEventDto
  fmt: (iso: string | null) => string
}) {
  const { stateLabel, reasonLabel, correlationLabel } = useSourceHealthLabels()
  const correlation = correlationLabel(event.correlation, {
    adapterVersion: event.adapterVersion,
    configVersion: event.configVersion,
  })

  return (
    <li
      className="flex flex-col gap-1 rounded-md border border-border/50 px-3 py-2 text-xs"
      data-testid="job-source-event-row"
      data-event-kind={event.kind}
    >
      <span className="text-muted-foreground tabular-nums">{fmt(event.at)}</span>
      {event.kind === 'TRANSITION' ? (
        <div className="flex flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2">
            {event.fromState && (
              <span className="text-muted-foreground">{stateLabel(event.fromState)} →</span>
            )}
            <Badge variant={stateBadgeVariant(event.toState)}>{stateLabel(event.toState)}</Badge>
            {event.reasonCode && (
              <span className="text-muted-foreground">{reasonLabel(event.reasonCode)}</span>
            )}
          </span>
          {correlation && <span className="text-muted-foreground">{correlation}</span>}
          {event.errorSample && (
            <span className="break-words font-mono text-xs text-muted-foreground">
              {event.errorSample}
            </span>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-0.5">
          <span className="font-medium text-foreground">
            <Trans>Нотатка — {event.actorName ?? '—'}</Trans>
          </span>
          <span className="break-words text-foreground">{event.note}</span>
        </div>
      )}
    </li>
  )
}

function NoteForm({ sourceId }: { sourceId: string }) {
  const { t } = useLingui()
  const addNote = useAddJobSourceNote(sourceId)
  // The field value lives in TanStack Form (project rule); only the announced result is local state.
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)

  const form = useForm({
    defaultValues: { note: '' },
    onSubmit: ({ value }) => {
      const parsed = createJobSourceNoteSchema.safeParse({ note: value.note })
      if (!parsed.success) return
      setResult(null)
      addNote.mutate(parsed.data.note, {
        onSuccess: () => {
          form.reset()
          setResult({ ok: true, text: t`Нотатку додано` })
        },
        onError: () => setResult({ ok: false, text: t`Не вдалося додати нотатку` }),
      })
    },
  })

  return (
    <form
      data-testid="job-source-note-form"
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        void form.handleSubmit()
      }}
    >
      <label htmlFor="source-note" className="text-sm font-medium text-foreground">
        <Trans>Додати нотатку</Trans>
      </label>
      <p className="text-xs text-muted-foreground">
        <Trans>
          Нотатку не можна редагувати — вона залишається в історії джерела. Зафіксуйте оголошення
          провайдера або рішення.
        </Trans>
      </p>
      <form.Field
        name="note"
        validators={{
          onChange: ({ value }) =>
            createJobSourceNoteSchema.safeParse({ note: value }).success
              ? undefined
              : t`Введіть нотатку (до 500 символів).`,
        }}
      >
        {(field) => {
          const fieldError =
            field.state.meta.errors.length > 0 ? String(field.state.meta.errors[0]) : null
          return (
            <>
              <Textarea
                id="source-note"
                value={field.state.value}
                maxLength={500}
                rows={3}
                placeholder={t`Напр.: провайдер повідомив про зміну автентифікації`}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                aria-invalid={!!fieldError}
                aria-describedby={fieldError ? 'source-note-error' : undefined}
              />
              {fieldError && (
                <p id="source-note-error" role="alert" className="text-xs text-destructive">
                  {fieldError}
                </p>
              )}
            </>
          )
        }}
      </form.Field>
      <div>
        <Button type="submit" size="sm" disabled={addNote.isPending}>
          {addNote.isPending ? t`Збереження…` : t`Зберегти нотатку`}
        </Button>
      </div>
      {/* The save result is shown AND announced (UX-M-2): a success via role=status, a failure via role=alert. */}
      {result && (
        <p
          role={result.ok ? 'status' : 'alert'}
          className={result.ok ? 'text-xs text-muted-foreground' : 'text-xs text-destructive'}
        >
          {result.text}
        </p>
      )}
    </form>
  )
}

function SourceDetailPage() {
  const { sourceId } = Route.useParams()
  const { data, isLoading, isError } = useJobSourceDetail(sourceId)
  const { stateLabel, reasonLabel, profileSummaryText } = useSourceHealthLabels()
  const fmt = useDateTime()

  return (
    <div className="flex max-w-3xl flex-col gap-5" data-testid="job-source-detail">
      <Link
        to="/admin/sources"
        data-testid="back-button"
        className="inline-flex min-h-6 w-fit items-center gap-1.5 py-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        <Trans>Усі джерела</Trans>
      </Link>

      {isLoading && (
        <div className="space-y-3">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      )}

      {isError && !isLoading && (
        <p role="alert" className="text-sm text-destructive" data-testid="job-source-detail-error">
          <Trans>Не вдалося завантажити джерело.</Trans>
        </p>
      )}

      {!isLoading && !isError && data && (
        <>
          <header className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-mono text-lg font-semibold text-foreground">
                {data.source.type}
              </h2>
              <Badge variant={stateBadgeVariant(data.source.state)}>
                {stateLabel(data.source.state)}
              </Badge>
              {data.source.reasonCode && (
                <span className="text-xs text-muted-foreground">
                  {reasonLabel(data.source.reasonCode)}
                </span>
              )}
            </div>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2">
              <div className="flex gap-1">
                <dt>
                  <Trans>Періодичність:</Trans>
                </dt>
                <dd className="text-foreground">
                  {profileSummaryText(data.source.profileSummary)}
                </dd>
              </div>
              <div className="flex gap-1">
                <dt>
                  <Trans>Останній запуск:</Trans>
                </dt>
                <dd className="text-foreground tabular-nums">{fmt(data.source.lastCollectedAt)}</dd>
              </div>
              <div className="flex gap-1">
                <dt>
                  <Trans>Остання вакансія:</Trans>
                </dt>
                <dd className="text-foreground tabular-nums">
                  {fmt(data.source.newestItemPublishedAt)}
                </dd>
              </div>
            </dl>
          </header>

          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium text-foreground">
              <Trans>Історія подій</Trans>
            </h3>
            {data.events.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                <Trans>Подій ще немає.</Trans>
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {data.events.map((event) => (
                  <EventRow key={event.id} event={event} fmt={fmt} />
                ))}
              </ul>
            )}
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium text-foreground">
              <Trans>Запуски</Trans>
            </h3>
            {data.runs.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                <Trans>Запусків ще не було.</Trans>
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {data.runs.map((run) => (
                  <RunRow key={run.id} run={run} fmt={fmt} />
                ))}
              </ul>
            )}
          </section>

          <section className="border-t border-border/50 pt-4">
            <NoteForm sourceId={sourceId} />
          </section>
        </>
      )}
    </div>
  )
}
