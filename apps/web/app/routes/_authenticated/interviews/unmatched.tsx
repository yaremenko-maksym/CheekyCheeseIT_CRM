import { useMemo, useRef, useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { Trans, useLingui } from '@lingui/react/macro'
import type { MeetingRecorderUnmatchedRecordingDto } from '@crm/shared'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useRoleGuard } from '@/hooks/use-role-guard'
import { useUnmatchedInterviewRecordings } from '@/lib/meeting-recorder-api'
import { safeHttpUrl } from '@/lib/safe-http-url'
import { LinkRecordingDialog } from './components/LinkRecordingDialog'

export const Route = createFileRoute('/_authenticated/interviews/unmatched')({
  component: UnmatchedInterviewRecordingsPage,
})

function UnmatchedInterviewRecordingsPage() {
  const { t, i18n } = useLingui()
  const { denied, isLoading: roleLoading } = useRoleGuard(['ADMIN'])
  const recordingsQuery = useUnmatchedInterviewRecordings(!denied && !roleLoading)
  const [selectedRecording, setSelectedRecording] =
    useState<MeetingRecorderUnmatchedRecordingDto | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const linkButtonRefs = useRef(new Map<string, HTMLButtonElement>())

  const orderedIds = useMemo(
    () => recordingsQuery.data?.map((recording) => recording.id) ?? [],
    [recordingsQuery.data],
  )

  if (denied) return null

  function recoverFocus(removedRecordingId: string) {
    const removedIndex = orderedIds.indexOf(removedRecordingId)
    const nextId = orderedIds[removedIndex + 1] ?? orderedIds[removedIndex - 1]
    requestAnimationFrame(() => {
      if (nextId && linkButtonRefs.current.get(nextId)) {
        linkButtonRefs.current.get(nextId)?.focus()
      } else {
        headingRef.current?.focus()
      }
    })
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto px-4 py-4 sm:px-6">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <Button variant="ghost" size="sm" asChild className="-ml-2 mb-1">
              <Link to="/interviews">
                <ArrowLeft className="h-4 w-4" />
                <Trans>До співбесід</Trans>
              </Link>
            </Button>
            <h1
              ref={headingRef}
              tabIndex={-1}
              className="text-xl font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Trans>Неприв'язані записи</Trans>
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              <Trans>Записи Meeting Recorder, для яких співбесіду потрібно обрати вручну.</Trans>
            </p>
          </div>
        </div>

        {recordingsQuery.isLoading ? (
          <div className="space-y-2">
            {[0, 1, 2, 3].map((item) => (
              <Skeleton key={item} className="h-28 w-full md:h-20" />
            ))}
          </div>
        ) : recordingsQuery.isError ? (
          <Alert variant="destructive">
            <AlertDescription className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <span>
                <Trans>Не вдалося завантажити неприв'язані записи.</Trans>
              </span>
              <Button size="sm" variant="outline" onClick={() => void recordingsQuery.refetch()}>
                <Trans>Повторити</Trans>
              </Button>
            </AlertDescription>
          </Alert>
        ) : !recordingsQuery.data?.length ? (
          <div className="rounded-md border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
            <Trans>Неприв'язаних записів немає</Trans>
          </div>
        ) : (
          <div className="divide-y divide-border rounded-md border border-border">
            {recordingsQuery.data.map((recording) => {
              const startedAt = new Intl.DateTimeFormat(i18n.locale, {
                dateStyle: 'medium',
                timeStyle: 'short',
              }).format(new Date(recording.startedAt))
              const transcriptPending = recording.readiness.pending.includes('transcript')
              const analysisPending = recording.readiness.pending.includes('analysis')

              return (
                <div
                  key={recording.id}
                  className="grid gap-3 px-3 py-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center lg:grid-cols-[minmax(0,2fr)_minmax(12rem,1fr)_minmax(12rem,1fr)_auto]"
                >
                  <div className="min-w-0 space-y-1">
                    <p className="break-words text-sm font-medium">{recording.title}</p>
                    <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                      <time dateTime={recording.startedAt}>{startedAt}</time>
                      {recording.durationMs !== null && (
                        <span className="tabular-nums">
                          <Trans>{Math.max(1, Math.round(recording.durationMs / 60_000))} хв</Trans>
                        </span>
                      )}
                      {recording.provider && <span>{recording.provider}</span>}
                    </div>
                    {recording.meetingUrl &&
                      (safeHttpUrl(recording.meetingUrl) ? (
                        <a
                          href={safeHttpUrl(recording.meetingUrl) ?? undefined}
                          target="_blank"
                          rel="noreferrer"
                          className="block break-all text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                        >
                          {recording.meetingUrl}
                        </a>
                      ) : (
                        <span className="block break-all text-xs text-muted-foreground">
                          {recording.meetingUrl}
                        </span>
                      ))}
                  </div>

                  <div className="min-w-0 text-xs text-muted-foreground md:col-start-1 lg:col-start-auto">
                    <p className="font-medium text-foreground/80">
                      <Trans>Можливий збіг</Trans>
                    </p>
                    <p className="mt-0.5">
                      <Trans>Збіг не знайдено</Trans>
                    </p>
                  </div>

                  <div className="space-y-0.5 text-xs text-muted-foreground md:col-start-1 lg:col-start-auto">
                    <p>{transcriptPending ? t`Транскрипт обробляється` : t`Транскрипт готовий`}</p>
                    <p>{analysisPending ? t`Аналіз обробляється` : t`Аналіз готовий`}</p>
                    {recording.readiness.pending.includes('artifact-delivery') && (
                      <p>
                        <Trans>Доставка матеріалів триває</Trans>
                      </p>
                    )}
                  </div>

                  <Button
                    ref={(node) => {
                      if (node) linkButtonRefs.current.set(recording.id, node)
                      else linkButtonRefs.current.delete(recording.id)
                    }}
                    size="sm"
                    className="w-full md:col-start-2 md:row-span-2 md:row-start-1 md:w-auto lg:col-start-auto lg:row-auto"
                    onClick={() => setSelectedRecording(recording)}
                  >
                    <Trans>Прив'язати</Trans>
                  </Button>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {selectedRecording && (
        <LinkRecordingDialog
          open
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setSelectedRecording(null)
          }}
          recordingId={selectedRecording.id}
          recordingTitle={selectedRecording.title}
          onLinked={() => recoverFocus(selectedRecording.id)}
        />
      )}
    </div>
  )
}
