import { useEffect, useMemo, useRef, useState } from 'react'
import type { MeetingRecorderMediaArtifactDto } from '@crm/shared'
import { Trans, useLingui } from '@lingui/react/macro'
import { toast } from 'sonner'
import { useAuth } from '@/context/auth'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import {
  CrmDialogBody,
  CrmDialogContent,
  CrmDialogFooter,
  CrmDialogHeader,
  Dialog,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/crm-dialog'
import { Skeleton } from '@/components/ui/skeleton'
import {
  meetingRecorderApi,
  useInterviewRecording,
  useLinkInterviewRecording,
} from '@/lib/meeting-recorder-api'
import { LinkRecordingDialog } from './LinkRecordingDialog'

type RecordingDetailDialogProps = {
  recordingId: string | null
  open: boolean
  currentInterviewId: string
  onOpenChange: (open: boolean) => void
  onNestedDialogStateChange?: (open: boolean) => void
  onRemovedFromInterview?: () => void
}

function formatOffset(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

function mediaPriority(artifact: MeetingRecorderMediaArtifactDto) {
  const video = artifact.mimeType.startsWith('video/')
  if (video && artifact.role === 'tab-recording') return 0
  if (video && artifact.role === 'self-video') return 1
  if (video) return 2
  return 3
}

function RecordingMediaSection({ recordingId }: { recordingId: string }) {
  const { t } = useLingui()
  const [artifacts, setArtifacts] = useState<MeetingRecorderMediaArtifactDto[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(false)
    void meetingRecorderApi
      .listRecordingMedia(recordingId)
      .then((items) => {
        if (!active) return
        setArtifacts([...items].sort((a, b) => mediaPriority(a) - mediaPriority(b)))
      })
      .catch(() => {
        if (active) setError(true)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [recordingId, reload])

  return (
    <section aria-labelledby="recording-media-heading" className="space-y-3">
      <h3 id="recording-media-heading" className="text-sm font-semibold">
        <Trans>Медіа</Trans>
      </h3>
      {loading ? (
        <Skeleton className="h-20 w-full" />
      ) : error ? (
        <Alert variant="destructive">
          <AlertDescription className="flex items-center justify-between gap-3">
            <span>
              <Trans>Не вдалося завантажити медіа.</Trans>
            </span>
            <Button size="sm" variant="outline" onClick={() => setReload((value) => value + 1)}>
              <Trans>Повторити</Trans>
            </Button>
          </AlertDescription>
        </Alert>
      ) : artifacts.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          <Trans>Готових медіафайлів ще немає.</Trans>
        </p>
      ) : (
        <div className="space-y-3">
          {artifacts.map((artifact) => (
            <RecordingMediaArtifactPlayer
              key={artifact.artifactId}
              recordingId={recordingId}
              artifact={artifact}
              playbackErrorLabel={t`Не вдалося відтворити медіа. Спробуйте оновити доступ.`}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function RecordingMediaArtifactPlayer({
  recordingId,
  artifact,
  playbackErrorLabel,
}: {
  recordingId: string
  artifact: MeetingRecorderMediaArtifactDto
  playbackErrorLabel: string
}) {
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null)
  const mountedRef = useRef(true)
  const refreshInFlightRef = useRef(false)
  const restoringSourceRef = useRef(false)
  const intendedPlayingRef = useRef(false)
  const consecutiveRefreshesRef = useRef(0)
  const restoreRef = useRef<{ currentTime: number; shouldPlay: boolean } | null>(null)
  const [sourceUrl, setSourceUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  async function requestSource(countAsRefresh: boolean) {
    if (refreshInFlightRef.current) return
    if (countAsRefresh && consecutiveRefreshesRef.current >= 2) {
      setError(playbackErrorLabel)
      return
    }
    if (countAsRefresh) consecutiveRefreshesRef.current += 1
    refreshInFlightRef.current = true
    setLoading(true)
    setError(null)
    try {
      const capability = await meetingRecorderApi.prepareRecordingMediaPlayback(
        recordingId,
        artifact.artifactId,
      )
      if (!mountedRef.current) return
      setSourceUrl(capability.url)
    } catch {
      if (mountedRef.current) {
        restoringSourceRef.current = false
        setError(playbackErrorLabel)
      }
    } finally {
      refreshInFlightRef.current = false
      if (mountedRef.current) setLoading(false)
    }
  }

  function handleMediaError() {
    const media = mediaRef.current
    restoringSourceRef.current = true
    if (media) {
      restoreRef.current = {
        currentTime: Number.isFinite(media.currentTime) ? media.currentTime : 0,
        shouldPlay: intendedPlayingRef.current,
      }
    }
    void requestSource(true)
  }

  function handleLoadedMetadata() {
    consecutiveRefreshesRef.current = 0
    const media = mediaRef.current
    const restore = restoreRef.current
    restoreRef.current = null
    if (!media || !restore) {
      restoringSourceRef.current = false
      return
    }
    try {
      media.currentTime = restore.currentTime
    } catch {
      // Some browsers reject seeks until enough metadata is available; playback still remains usable.
    }
    restoringSourceRef.current = false
    if (restore.shouldPlay) void media.play().catch(() => undefined)
  }

  function retry() {
    consecutiveRefreshesRef.current = 0
    const media = mediaRef.current
    restoringSourceRef.current = true
    if (media) {
      restoreRef.current = {
        currentTime: Number.isFinite(media.currentTime) ? media.currentTime : 0,
        shouldPlay: intendedPlayingRef.current,
      }
    }
    void requestSource(false)
  }

  const metadata = (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <span className="font-medium text-foreground">{artifact.filename}</span>
      <span>{artifact.role}</span>
      <span>{formatBytes(artifact.bytes)}</span>
    </div>
  )

  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      {metadata}
      {!sourceUrl ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() => void requestSource(false)}
          disabled={loading}
        >
          {loading ? <Trans>Завантаження…</Trans> : <Trans>Відкрити програвач</Trans>}
        </Button>
      ) : artifact.mimeType.startsWith('video/') ? (
        <video
          ref={(element) => {
            mediaRef.current = element
          }}
          className="max-h-[28rem] w-full rounded bg-black"
          controls
          preload="metadata"
          src={sourceUrl}
          onPlay={() => {
            intendedPlayingRef.current = true
          }}
          onPause={(event) => {
            if (!restoringSourceRef.current && !event.currentTarget.error) {
              intendedPlayingRef.current = false
            }
          }}
          onError={handleMediaError}
          onLoadedMetadata={handleLoadedMetadata}
        />
      ) : (
        <audio
          ref={(element) => {
            mediaRef.current = element
          }}
          className="w-full"
          controls
          preload="metadata"
          src={sourceUrl}
          onPlay={() => {
            intendedPlayingRef.current = true
          }}
          onPause={(event) => {
            if (!restoringSourceRef.current && !event.currentTarget.error) {
              intendedPlayingRef.current = false
            }
          }}
          onError={handleMediaError}
          onLoadedMetadata={handleLoadedMetadata}
        />
      )}
      {error && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-destructive">{error}</p>
          <Button size="sm" variant="outline" onClick={retry} disabled={loading}>
            <Trans>Оновити доступ</Trans>
          </Button>
        </div>
      )}
    </div>
  )
}

export function RecordingDetailDialog({
  recordingId,
  open,
  currentInterviewId,
  onOpenChange,
  onNestedDialogStateChange,
  onRemovedFromInterview,
}: RecordingDetailDialogProps) {
  const { t, i18n } = useLingui()
  const { user } = useAuth()
  const detailQuery = useInterviewRecording(recordingId, open)
  const unlinkMutation = useLinkInterviewRecording()
  const [relinkOpen, setRelinkOpen] = useState(false)
  const [unlinkOpen, setUnlinkOpen] = useState(false)

  useEffect(() => {
    onNestedDialogStateChange?.(relinkOpen || unlinkOpen)
    return () => onNestedDialogStateChange?.(false)
  }, [relinkOpen, unlinkOpen, onNestedDialogStateChange])

  useEffect(() => {
    if (!open) {
      setRelinkOpen(false)
      setUnlinkOpen(false)
    }
  }, [open])

  const detail = detailQuery.data
  const recording = detail?.snapshot
  const readiness = detail?.readiness

  const startedAtLabel = useMemo(() => {
    if (!detail) return ''
    return new Intl.DateTimeFormat(i18n.locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(detail.startedAt))
  }, [detail, i18n.locale])

  const transcriptStatus = !detail
    ? ''
    : readiness?.pending.includes('transcript')
      ? t`Транскрипт обробляється`
      : recording?.transcript
        ? t`Транскрипт готовий`
        : t`Транскрипт не передано`

  const analysisStatus = !detail
    ? ''
    : readiness?.pending.includes('analysis') || recording?.analysis?.status === 'analyzing'
      ? t`Аналіз обробляється`
      : !recording?.analysis
        ? t`Аналіз не передано`
        : recording.analysis.status === 'completed'
          ? t`Аналіз готовий`
          : recording.analysis.status === 'failed'
            ? t`Помилка аналізу`
            : recording.analysis.status === 'canceled'
              ? t`Аналіз скасовано`
              : t`Аналіз недоступний`

  function closeDetail() {
    if (relinkOpen || unlinkOpen) return
    onOpenChange(false)
  }

  function unlink() {
    if (!recordingId) return
    unlinkMutation.mutate(
      {
        recordingId,
        interviewId: null,
        previousInterviewId: detail?.interviewId ?? currentInterviewId,
      },
      {
        onSuccess: () => {
          toast.success(t`Запис відв'язано`)
          setUnlinkOpen(false)
          onOpenChange(false)
          onRemovedFromInterview?.()
        },
        onError: () => toast.error(t`Не вдалося відв'язати запис`),
      },
    )
  }

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) closeDetail()
        }}
      >
        <CrmDialogContent maxWidth="max-w-[calc(100vw-1rem)] sm:max-w-3xl">
          <CrmDialogHeader>
            <DialogTitle className="pr-6 break-words">
              {detail?.title ?? t`Запис співбесіди`}
            </DialogTitle>
            <DialogDescription>
              <Trans>Транскрипт, нотатки та аналіз, отримані від Meeting Recorder.</Trans>
            </DialogDescription>

            {detail && (
              <div className="mt-3 space-y-2 text-xs text-muted-foreground">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <time dateTime={detail.startedAt}>{startedAtLabel}</time>
                  {detail.durationMs !== null && (
                    <span className="tabular-nums">
                      <Trans>{Math.max(1, Math.round(detail.durationMs / 60_000))} хв</Trans>
                    </span>
                  )}
                  {detail.provider && <span>{detail.provider}</span>}
                </div>
                {detail.meetingUrl && (
                  <a
                    href={detail.meetingUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="block max-w-full truncate underline underline-offset-2 hover:text-foreground"
                    title={detail.meetingUrl}
                  >
                    {detail.meetingUrl}
                  </a>
                )}
                <div className="flex flex-wrap gap-x-3 gap-y-1" aria-live="polite">
                  <span>{transcriptStatus}</span>
                  <span>{analysisStatus}</span>
                  {readiness?.pending.includes('artifact-delivery') && (
                    <span>
                      <Trans>Доставка матеріалів триває</Trans>
                    </span>
                  )}
                </div>
              </div>
            )}
          </CrmDialogHeader>

          <CrmDialogBody className="space-y-6 pb-5">
            {detailQuery.isLoading ? (
              <div className="space-y-3">
                <Skeleton className="h-5 w-32" />
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
              </div>
            ) : detailQuery.isError ? (
              <Alert variant="destructive">
                <AlertDescription className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <span>
                    <Trans>Не вдалося завантажити запис.</Trans>
                  </span>
                  <Button size="sm" variant="outline" onClick={() => void detailQuery.refetch()}>
                    <Trans>Повторити</Trans>
                  </Button>
                </AlertDescription>
              </Alert>
            ) : recording ? (
              <>
                {recordingId && <RecordingMediaSection recordingId={recordingId} />}

                <section aria-labelledby="recording-transcript-heading" className="space-y-3">
                  <h3 id="recording-transcript-heading" className="text-sm font-semibold">
                    <Trans>Транскрипт</Trans>
                  </h3>
                  {readiness?.pending.includes('transcript') ? (
                    <p className="text-sm text-muted-foreground">
                      <Trans>Транскрипт ще обробляється.</Trans>
                    </p>
                  ) : !recording.transcript ? (
                    <p className="text-sm text-muted-foreground">
                      <Trans>Не передано</Trans>
                    </p>
                  ) : recording.transcript.segments.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      <Trans>Транскрипт порожній</Trans>
                    </p>
                  ) : (
                    <div className="space-y-1.5">
                      {recording.transcript.segments.map((segment, index) => (
                        <div
                          key={`${segment.tStartMs}-${segment.tEndMs}-${index}`}
                          className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-2 rounded-md border border-border/60 px-2.5 py-2 text-sm md:grid-cols-[4rem_8rem_minmax(0,1fr)]"
                          style={{ contentVisibility: 'auto', containIntrinsicSize: '0 56px' }}
                        >
                          <time className="tabular-nums text-xs text-muted-foreground">
                            {formatOffset(segment.tStartMs)}
                          </time>
                          <div className="min-w-0 md:contents">
                            {segment.speaker && (
                              <p className="mb-0.5 break-words text-xs font-medium text-muted-foreground md:mb-0">
                                {segment.speaker}
                              </p>
                            )}
                            <p className="min-w-0 whitespace-pre-wrap break-words">
                              {segment.text}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                {recording.note !== undefined && (
                  <section aria-labelledby="recording-note-heading" className="space-y-2">
                    <h3 id="recording-note-heading" className="text-sm font-semibold">
                      <Trans>Нотатка рекордера</Trans>
                    </h3>
                    <p className="whitespace-pre-wrap break-words text-sm">{recording.note}</p>
                  </section>
                )}

                {recording.notations && recording.notations.length > 0 && (
                  <section aria-labelledby="recording-notations-heading" className="space-y-2">
                    <h3 id="recording-notations-heading" className="text-sm font-semibold">
                      <Trans>Нотатки за часом</Trans>
                    </h3>
                    <div className="space-y-1.5">
                      {recording.notations.map((notation, index) => (
                        <div
                          key={`${notation.tStartMs}-${index}`}
                          className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-2 rounded-md border border-border/60 px-2.5 py-2 text-sm"
                        >
                          <span className="tabular-nums text-xs text-muted-foreground">
                            {formatOffset(notation.tStartMs)}
                          </span>
                          <p className="whitespace-pre-wrap break-words">{notation.text}</p>
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                <section aria-labelledby="recording-analysis-heading" className="space-y-3">
                  <h3 id="recording-analysis-heading" className="text-sm font-semibold">
                    <Trans>Аналіз</Trans>
                  </h3>
                  {readiness?.pending.includes('analysis') ||
                  recording.analysis?.status === 'analyzing' ? (
                    <p className="text-sm text-muted-foreground">
                      <Trans>Аналіз ще обробляється.</Trans>
                    </p>
                  ) : !recording.analysis ? (
                    <p className="text-sm text-muted-foreground">
                      <Trans>Не передано</Trans>
                    </p>
                  ) : (
                    <div className="space-y-3">
                      <p className="text-sm text-muted-foreground">{analysisStatus}</p>
                      {recording.analysis.status === 'failed' && recording.analysis.error && (
                        <p className="whitespace-pre-wrap break-words text-sm text-destructive">
                          {recording.analysis.error}
                        </p>
                      )}
                      {recording.analysis.topics && recording.analysis.topics.length > 0 && (
                        <div className="space-y-2">
                          {recording.analysis.topics.map((topic, index) => (
                            <div
                              key={index}
                              className="rounded-md border border-border px-3 py-2 text-sm"
                            >
                              <p className="break-words font-medium">{topic.keywords.join(', ')}</p>
                              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                                <span>
                                  <Trans>Важливість: {topic.importance}</Trans>
                                </span>
                                <span>
                                  <Trans>Фрагментів: {topic.spans.length}</Trans>
                                </span>
                              </div>
                              {topic.spans.length > 0 && (
                                <p className="mt-1 break-words text-xs text-muted-foreground tabular-nums">
                                  {topic.spans
                                    .map(
                                      (span) =>
                                        `${formatOffset(span.tStartMs)}–${formatOffset(span.tEndMs)}`,
                                    )
                                    .join(', ')}
                                </p>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </section>
              </>
            ) : null}
          </CrmDialogBody>

          {user?.role === 'ADMIN' && detail?.interviewId && (
            <CrmDialogFooter>
              <Button variant="outline" onClick={() => setUnlinkOpen(true)}>
                <Trans>Відв'язати</Trans>
              </Button>
              <Button variant="outline" onClick={() => setRelinkOpen(true)}>
                <Trans>Переприв'язати</Trans>
              </Button>
            </CrmDialogFooter>
          )}
        </CrmDialogContent>
      </Dialog>

      {recordingId && detail && (
        <LinkRecordingDialog
          open={relinkOpen}
          onOpenChange={setRelinkOpen}
          recordingId={recordingId}
          recordingTitle={detail.title}
          previousInterviewId={detail.interviewId ?? currentInterviewId}
          onLinked={() => {
            onOpenChange(false)
            onRemovedFromInterview?.()
          }}
        />
      )}

      <AlertDialog open={unlinkOpen} onOpenChange={setUnlinkOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Відв'язати запис?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>
                Запис зникне з цієї співбесіди та повернеться до списку неприв'язаних записів.
              </Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant="outline"
              data-testid="cancel-button"
              onClick={() => setUnlinkOpen(false)}
            >
              <Trans>Скасувати</Trans>
            </Button>
            <Button variant="destructive" onClick={unlink} disabled={unlinkMutation.isPending}>
              {unlinkMutation.isPending ? t`Відв'язування…` : t`Відв'язати`}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
