import type { RefObject } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useInterviewRecordings } from '@/lib/meeting-recorder-api'

type RecordingSummarySectionProps = {
  interviewId: string
  enabled: boolean
  headingRef: RefObject<HTMLHeadingElement>
  onOpenRecording: (recordingId: string) => void
}

export function RecordingSummarySection({
  interviewId,
  enabled,
  headingRef,
  onOpenRecording,
}: RecordingSummarySectionProps) {
  const { t, i18n } = useLingui()
  const recordingsQuery = useInterviewRecordings(interviewId, enabled)

  return (
    <section className="space-y-3" aria-labelledby="interview-recordings-heading">
      <h3
        ref={headingRef}
        id="interview-recordings-heading"
        tabIndex={-1}
        className="text-xs font-semibold uppercase tracking-wider text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Trans>Записи</Trans>
      </h3>

      {recordingsQuery.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : recordingsQuery.isError ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <span>
              <Trans>Не вдалося завантажити записи.</Trans>
            </span>
            <Button size="sm" variant="outline" onClick={() => void recordingsQuery.refetch()}>
              <Trans>Повторити</Trans>
            </Button>
          </AlertDescription>
        </Alert>
      ) : !recordingsQuery.data?.length ? (
        <div className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
          <Trans>Для цієї співбесіди записів немає</Trans>
        </div>
      ) : (
        <div className="space-y-2">
          {recordingsQuery.data.map((recording) => {
            const transcriptPending = recording.readiness.pending.includes('transcript')
            const analysisPending = recording.readiness.pending.includes('analysis')
            const startedAt = new Intl.DateTimeFormat(i18n.locale, {
              dateStyle: 'medium',
              timeStyle: 'short',
            }).format(new Date(recording.startedAt))

            return (
              <div key={recording.id} className="rounded-md border border-border px-3 py-2">
                <div className="flex items-start justify-between gap-3">
                  <p className="min-w-0 break-words text-sm font-medium">{recording.title}</p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="shrink-0"
                    onClick={() => onOpenRecording(recording.id)}
                  >
                    <Trans>Відкрити</Trans>
                  </Button>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                  <time dateTime={recording.startedAt}>{startedAt}</time>
                  {recording.durationMs !== null && (
                    <span className="tabular-nums">
                      <Trans>{Math.max(1, Math.round(recording.durationMs / 60_000))} хв</Trans>
                    </span>
                  )}
                  {recording.provider && <span>{recording.provider}</span>}
                </div>
                <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs" aria-live="polite">
                  <span className="text-muted-foreground">
                    {transcriptPending ? t`Транскрипт обробляється` : t`Транскрипт готовий`}
                  </span>
                  <span className="text-muted-foreground">
                    {analysisPending ? t`Аналіз обробляється` : t`Аналіз готовий`}
                  </span>
                </div>
                {recording.readiness.pending.includes('artifact-delivery') && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    <Trans>Доставка матеріалів триває</Trans>
                  </p>
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
