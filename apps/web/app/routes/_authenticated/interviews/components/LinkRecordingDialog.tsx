import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Trans, useLingui } from '@lingui/react/macro'
import { interviewSchema, type InterviewDto } from '@crm/shared'
import { toast } from 'sonner'
import { api } from '@/lib/axios'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'
import { useLinkInterviewRecording } from '@/lib/meeting-recorder-api'
import { STAGE_LABEL_MESSAGES } from '../constants'
import { useBoardSeniors } from '../use-board-seniors'

type LinkRecordingDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  recordingId: string
  recordingTitle: string
  previousInterviewId?: string | null
  onLinked?: (interviewId: string) => void
}

export function LinkRecordingDialog({
  open,
  onOpenChange,
  recordingId,
  recordingTitle,
  previousInterviewId = null,
  onLinked,
}: LinkRecordingDialogProps) {
  const { t, i18n } = useLingui()
  const [seniorId, setSeniorId] = useState('')
  const [search, setSearch] = useState('')
  const [selectedInterviewId, setSelectedInterviewId] = useState('')
  const [mutationError, setMutationError] = useState<string | null>(null)
  const linkedSuccessfullyRef = useRef(false)
  const { data: seniors = [], isLoading: seniorsLoading } = useBoardSeniors(open)
  const linkMutation = useLinkInterviewRecording()

  const interviewsQuery = useQuery({
    queryKey: ['interviews', seniorId],
    queryFn: async () => {
      const response = await api.get(`/interviews?seniorId=${seniorId}`)
      return interviewSchema.array().parse(response.data)
    },
    enabled: open && !!seniorId,
  })

  useEffect(() => {
    if (!open) {
      setSeniorId('')
      setSearch('')
      setSelectedInterviewId('')
      setMutationError(null)
      linkedSuccessfullyRef.current = false
    }
  }, [open])

  const filteredInterviews = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    if (!query) return interviewsQuery.data ?? []

    return (interviewsQuery.data ?? []).filter((interview) => {
      const stage = i18n._(STAGE_LABEL_MESSAGES[interview.stage])
      return `${interview.companyName} ${stage}`.toLocaleLowerCase().includes(query)
    })
  }, [interviewsQuery.data, search, i18n])

  const selectedInterview: InterviewDto | undefined = interviewsQuery.data?.find(
    (interview) => interview.id === selectedInterviewId,
  )

  function submit() {
    if (!selectedInterviewId) return
    setMutationError(null)
    linkMutation.mutate(
      {
        recordingId,
        interviewId: selectedInterviewId,
        previousInterviewId,
      },
      {
        onSuccess: () => {
          linkedSuccessfullyRef.current = true
          toast.success(t`Запис прив'язано`)
          onLinked?.(selectedInterviewId)
          onOpenChange(false)
        },
        onError: (error) => {
          setMutationError(error instanceof Error ? error.message : t`Не вдалося прив'язати запис`)
        },
      },
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <CrmDialogContent
        maxWidth="sm:max-w-2xl"
        onCloseAutoFocus={(event) => {
          if (linkedSuccessfullyRef.current) event.preventDefault()
        }}
      >
        <CrmDialogHeader>
          <DialogTitle>
            <Trans>Прив'язати запис до співбесіди</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              Оберіть сеньйора, знайдіть потрібну співбесіду та підтвердьте прив'язування запису «
              {recordingTitle}».
            </Trans>
          </DialogDescription>
        </CrmDialogHeader>

        <CrmDialogBody className="space-y-4 pb-4">
          {mutationError && (
            <Alert variant="destructive">
              <AlertDescription>{mutationError}</AlertDescription>
            </Alert>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="recording-link-senior">
              <Trans>Сеньйор</Trans>
            </Label>
            {seniorsLoading ? (
              <Skeleton className="h-9 w-full" />
            ) : (
              <select
                id="recording-link-senior"
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={seniorId}
                onChange={(event) => {
                  setSeniorId(event.target.value)
                  setSearch('')
                  setSelectedInterviewId('')
                  setMutationError(null)
                }}
              >
                <option value="">{t`Оберіть сеньйора`}</option>
                {seniors.map((senior) => (
                  <option key={senior.id} value={senior.id}>
                    {senior.displayName}
                  </option>
                ))}
              </select>
            )}
          </div>

          {seniorId && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="recording-link-search">
                  <Trans>Пошук співбесіди</Trans>
                </Label>
                <Input
                  id="recording-link-search"
                  type="search"
                  enterKeyHint="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={t`Компанія або стадія`}
                />
              </div>

              {interviewsQuery.isLoading ? (
                <div className="space-y-2">
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-12 w-full" />
                </div>
              ) : interviewsQuery.isError ? (
                <Alert variant="destructive">
                  <AlertDescription className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <span>
                      <Trans>Не вдалося завантажити співбесіди.</Trans>
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void interviewsQuery.refetch()}
                    >
                      <Trans>Повторити</Trans>
                    </Button>
                  </AlertDescription>
                </Alert>
              ) : filteredInterviews.length === 0 ? (
                <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
                  <Trans>Співбесід не знайдено</Trans>
                </div>
              ) : (
                <div className="space-y-2" role="radiogroup" aria-label={t`Співбесіди`}>
                  {filteredInterviews.map((interview) => {
                    const selected = interview.id === selectedInterviewId
                    return (
                      <button
                        key={interview.id}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        className={`flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                          selected
                            ? 'border-primary bg-primary/10'
                            : 'border-border bg-background hover:bg-muted/20'
                        }`}
                        onClick={() => {
                          setSelectedInterviewId(interview.id)
                          setMutationError(null)
                        }}
                        disabled={linkMutation.isPending && selected}
                      >
                        <span className="min-w-0 font-medium break-words">
                          {interview.companyName}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {i18n._(STAGE_LABEL_MESSAGES[interview.stage])}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {selectedInterview && (
            <div className="rounded-md border border-border bg-muted/20 px-3 py-2 text-sm">
              <p className="text-xs text-muted-foreground">
                <Trans>Буде прив'язано до</Trans>
              </p>
              <p className="mt-1 font-medium break-words">
                {selectedInterview.companyName} ·{' '}
                {i18n._(STAGE_LABEL_MESSAGES[selectedInterview.stage])}
              </p>
            </div>
          )}
        </CrmDialogBody>

        <CrmDialogFooter>
          <Button variant="outline" data-testid="cancel-button" onClick={() => onOpenChange(false)}>
            <Trans>Скасувати</Trans>
          </Button>
          <Button onClick={submit} disabled={!selectedInterviewId || linkMutation.isPending}>
            {linkMutation.isPending ? t`Прив'язування…` : t`Прив'язати`}
          </Button>
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}
