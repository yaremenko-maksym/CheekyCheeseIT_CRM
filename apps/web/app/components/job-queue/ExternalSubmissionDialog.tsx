import { useId, useState, type ReactNode } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { AlertTriangle, Loader2 } from 'lucide-react'
import {
  externalHttpsUrlSchema,
  jobQueueManualDuplicateConflictSchema,
  type ExternalFieldStatus,
  type ExternalVacancyPrefill,
  type TeamDto,
} from '@crm/shared'
import { Button } from '@/components/ui/button'
import {
  CrmDialogBody,
  CrmDialogContent,
  CrmDialogFooter,
  CrmDialogHeader,
} from '@/components/ui/crm-dialog'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import {
  getJobQueuePossibleDuplicateConflict,
  useCreateManualJobQueueCard,
  type QueueScopeSignature,
} from '@/hooks/use-job-queue'
import { useSeniorResume } from '@/hooks/use-senior-resume'
import { getUserFacingErrorMessage } from '@/lib/axios-utils'
import { PossibleDuplicates } from './PossibleDuplicates'

type Field = 'url' | 'title' | 'company' | 'description'

/** The 409 `JOB_QUEUE_MANUAL_DUPLICATE` body (with the card id when the actor may open it), else `null`. */
function manualDuplicate(error: unknown) {
  const data = (error as { response?: { data?: unknown } } | null)?.response?.data
  const parsed = jobQueueManualDuplicateConflictSchema.safeParse(data)
  return parsed.success ? parsed.data : null
}

const activeSeniors = (team: TeamDto | undefined) =>
  (team?.members ?? []).filter((m) => m.role === 'SENIOR' && !m.leftAt)

/**
 * «Записати зовнішню подачу»: a vacancy found outside the sources (another site, the bookmarklet,
 * a pasted text) becomes a card together with its first submission. Text is plain text only —
 * nothing here is rendered as HTML. The resume is not picked: a senior has at most one, and only a
 * `READY` one can be submitted, so the dialog reads it and blocks Submit with the reason otherwise.
 */
export function ExternalSubmissionDialog({
  open,
  onOpenChange,
  scope,
  teams,
  seniorId: initialSeniorId,
  prefill,
  onSubmitted,
  onOpenCard,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  scope: QueueScopeSignature & { role: 'ADMIN' | 'HR' }
  teams: readonly TeamDto[]
  seniorId?: string | undefined
  prefill?: ExternalVacancyPrefill | null
  onSubmitted: (opportunityId: string) => void
  onOpenCard: (opportunityId: string) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* remounted per opening, so a new prefill starts from a clean form */}
      {open && (
        <ExternalSubmissionForm
          scope={scope}
          teams={teams}
          initialSeniorId={initialSeniorId}
          prefill={prefill ?? null}
          onClose={() => onOpenChange(false)}
          onSubmitted={onSubmitted}
          onOpenCard={onOpenCard}
        />
      )}
    </Dialog>
  )
}

function ExternalSubmissionForm({
  scope,
  teams,
  initialSeniorId,
  prefill,
  onClose,
  onSubmitted,
  onOpenCard,
}: {
  scope: QueueScopeSignature & { role: 'ADMIN' | 'HR' }
  teams: readonly TeamDto[]
  initialSeniorId: string | undefined
  prefill: ExternalVacancyPrefill | null
  onClose: () => void
  onSubmitted: (opportunityId: string) => void
  onOpenCard: (opportunityId: string) => void
}) {
  const { t } = useLingui()
  const id = useId()
  const noVacancy = prefill?.recognition === 'none'
  const [values, setValues] = useState<Record<Field, string>>({
    url: prefill?.url ?? '',
    // «nothing recognized» keeps only the link: whatever else was read is not a vacancy
    title: noVacancy ? '' : (prefill?.title ?? ''),
    company: noVacancy ? '' : (prefill?.company ?? ''),
    description: noVacancy ? '' : (prefill?.description ?? ''),
  })
  const [teamId, setTeamId] = useState<string | undefined>(
    () =>
      teams.find((team) => team.id === scope.teamId)?.id ??
      teams.find((team) => activeSeniors(team).some((m) => m.userId === initialSeniorId))?.id ??
      teams[0]?.id,
  )
  const seniors = activeSeniors(teams.find((team) => team.id === teamId))
  const [seniorId, setSeniorId] = useState<string | undefined>(() =>
    seniors.some((m) => m.userId === initialSeniorId) ? initialSeniorId : seniors[0]?.userId,
  )
  const [confirming, setConfirming] = useState(false)
  const create = useCreateManualJobQueueCard(scope)
  const resume = useSeniorResume(seniorId)

  const hint = (field: Field): ExternalFieldStatus | undefined => {
    if (!prefill) return undefined
    if (noVacancy) return field === 'url' && values.url ? 'guessed' : 'missing'
    return prefill.status[field]
  }

  const urlInvalid =
    values.url.trim() !== '' && !externalHttpsUrlSchema.safeParse(values.url.trim()).success
  const resumeData = resume.data?.resume
  const resumeId = resumeData?.status === 'READY' ? resumeData.id : undefined
  const missingText = (['title', 'company', 'description'] as const).some(
    (f) => values[f].trim() === '',
  )
  const blocked = create.isPending || urlInvalid || missingText || !teamId || !seniorId || !resumeId

  const conflict = create.error ? manualDuplicate(create.error) : null
  const possible = create.error ? getJobQueuePossibleDuplicateConflict(create.error) : null

  const send = (confirmPossibleDuplicate: boolean) => {
    if (blocked || !teamId || !seniorId || !resumeId) return
    create.mutate(
      {
        title: values.title.trim(),
        companyName: values.company.trim(),
        descriptionMd: values.description.trim(),
        ...(values.url.trim() ? { applicationUrl: values.url.trim() } : {}),
        submission: { teamId, seniorId, resumeId },
        ...(confirmPossibleDuplicate ? { confirmPossibleDuplicate: true } : {}),
      },
      {
        onSuccess: (res) => {
          setConfirming(false)
          onSubmitted(res.submission.opportunityId)
        },
        onError: (error) => setConfirming(getJobQueuePossibleDuplicateConflict(error) !== null),
      },
    )
  }

  const set = (field: Field) => (value: string) => setValues((v) => ({ ...v, [field]: value }))

  return (
    <CrmDialogContent maxWidth="sm:max-w-2xl" data-testid="external-submission-dialog">
      <CrmDialogHeader>
        <DialogTitle>
          <Trans>Записати зовнішню подачу</Trans>
        </DialogTitle>
        <DialogDescription>
          <Trans>
            Вакансія з іншого сайту стане карткою в черзі разом із першою подачею сеньйора.
          </Trans>
        </DialogDescription>
      </CrmDialogHeader>
      <CrmDialogBody className="flex flex-col gap-4 pb-4">
        {noVacancy && (
          <p
            role="alert"
            data-testid="external-no-vacancy"
            className="flex items-start gap-2 rounded-lg border border-destructive/40 p-3 text-sm text-destructive"
          >
            <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <Trans>
              На цій сторінці не розпізнано вакансію. Виділіть текст вакансії на сторінці і
              натисніть закладку ще раз, або заповніть поля вручну.
            </Trans>
          </p>
        )}
        <TextField id={`${id}-url`} label={t`Посилання на вакансію`} hint={hint('url')}>
          <Input
            id={`${id}-url`}
            type="url"
            inputMode="url"
            autoComplete="off"
            placeholder="https://"
            value={values.url}
            aria-invalid={urlInvalid || undefined}
            aria-describedby={urlInvalid ? `${id}-url-error` : undefined}
            onChange={(e) => set('url')(e.target.value)}
          />
          {urlInvalid && (
            <span id={`${id}-url-error`} className="text-xs text-destructive">
              <Trans>Потрібне посилання https:// без логіна й пароля.</Trans>
            </span>
          )}
        </TextField>
        <TextField id={`${id}-title`} label={t`Назва вакансії`} hint={hint('title')}>
          <Input
            id={`${id}-title`}
            maxLength={500}
            value={values.title}
            onChange={(e) => set('title')(e.target.value)}
          />
        </TextField>
        <TextField id={`${id}-company`} label={t`Компанія`} hint={hint('company')}>
          <Input
            id={`${id}-company`}
            maxLength={255}
            value={values.company}
            onChange={(e) => set('company')(e.target.value)}
          />
        </TextField>
        <TextField id={`${id}-description`} label={t`Опис`} hint={hint('description')}>
          <Textarea
            id={`${id}-description`}
            rows={8}
            value={values.description}
            onChange={(e) => set('description')(e.target.value)}
          />
        </TextField>
        <div className="flex flex-col gap-4 sm:flex-row">
          {teams.length > 1 && (
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Label htmlFor={`${id}-team`}>
                <Trans>Команда</Trans>
              </Label>
              <Select
                value={teamId}
                onValueChange={(next) => {
                  setTeamId(next)
                  setSeniorId(activeSeniors(teams.find((team) => team.id === next))[0]?.userId)
                }}
              >
                <SelectTrigger id={`${id}-team`} className="min-h-11 sm:min-h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {teams.map((team) => (
                    <SelectItem key={team.id} value={team.id}>
                      {team.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Label htmlFor={`${id}-senior`}>
              <Trans>Сеньйор</Trans>
            </Label>
            <Select value={seniorId} onValueChange={setSeniorId} disabled={seniors.length === 0}>
              <SelectTrigger
                id={`${id}-senior`}
                data-testid="external-senior"
                className="min-h-11 sm:min-h-9"
              >
                <SelectValue placeholder={t`У команді немає сеньйорів`} />
              </SelectTrigger>
              <SelectContent>
                {seniors.map((m) => (
                  <SelectItem key={m.userId} value={m.userId}>
                    {m.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <ResumeState
              loading={seniorId !== undefined && resume.isPending}
              failed={resume.isError}
              status={seniorId === undefined ? undefined : (resumeData?.status ?? null)}
            />
          </div>
        </div>
        {conflict && (
          <p role="alert" data-testid="external-duplicate" className="text-sm text-destructive">
            {conflict.opportunityId ? (
              <>
                <Trans>Ця вакансія вже є в черзі.</Trans>{' '}
                <button
                  type="button"
                  className="font-medium underline underline-offset-4"
                  onClick={() => onOpenCard(conflict.opportunityId!)}
                >
                  <Trans>Відкрити й подати там</Trans>
                </button>
              </>
            ) : (
              <Trans>Це посилання вже зареєстровано в черзі.</Trans>
            )}
          </p>
        )}
        {possible && confirming && (
          <div className="flex flex-col gap-2">
            <p role="alert" className="text-sm font-medium">
              <Trans>Цього сеньйора вже подано на схожу вакансію</Trans>
            </p>
            {/* the 409 names this senior's own submissions, so no per-item senior line */}
            <PossibleDuplicates
              preview={{
                ...possible.possibleDuplicates,
                items: possible.possibleDuplicates.items.map((item) => ({
                  ...item,
                  submittedSeniorNames: [],
                })),
              }}
            />
          </div>
        )}
        {create.error != null && !conflict && !possible && (
          <p role="alert" className="text-sm text-destructive">
            {getUserFacingErrorMessage(create.error)}
          </p>
        )}
      </CrmDialogBody>
      <CrmDialogFooter>
        <Button type="button" variant="outline" className="min-h-11 sm:min-h-9" onClick={onClose}>
          <Trans>Скасувати</Trans>
        </Button>
        <Button
          type="button"
          data-testid="external-submit"
          className="min-h-11 sm:min-h-9"
          disabled={blocked}
          aria-busy={create.isPending || undefined}
          onClick={() => send(confirming)}
        >
          {create.isPending && (
            <Loader2 aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
          )}
          {confirming ? <Trans>Усе одно записати</Trans> : <Trans>Записати подачу</Trans>}
        </Button>
      </CrmDialogFooter>
    </CrmDialogContent>
  )
}

function TextField({
  id,
  label,
  hint,
  children,
}: {
  id: string
  label: string
  hint: ExternalFieldStatus | undefined
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint === 'missing' && (
        <span data-testid={`${id}-hint`} className="text-xs text-destructive">
          <Trans>Не розпізнано — заповніть вручну</Trans>
        </span>
      )}
      {hint === 'guessed' && (
        <span data-testid={`${id}-hint`} className="text-xs text-muted-foreground">
          <Trans>Перевірте це значення</Trans>
        </span>
      )}
    </div>
  )
}

/** Why Submit is off for the chosen senior, or nothing when the resume can be submitted. */
function ResumeState({
  loading,
  failed,
  status,
}: {
  loading: boolean
  failed: boolean
  status: string | null | undefined
}) {
  if (status === undefined || status === 'READY') return null
  let text: ReactNode
  if (loading) text = <Trans>Перевіряємо резюме…</Trans>
  else if (failed) text = <Trans>Не вдалося завантажити резюме сеньйора.</Trans>
  else if (status === null) text = <Trans>У сеньйора немає резюме — подати не можна.</Trans>
  else text = <Trans>Резюме сеньйора ще не готове — подати не можна.</Trans>
  return (
    <span data-testid="external-resume-state" className="text-xs text-destructive">
      {text}
    </span>
  )
}
