import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { AlertTriangle, Info, Loader2, Sparkles } from 'lucide-react'
import {
  DESCRIPTION_MD_MAX,
  externalHttpsUrlSchema,
  jobQueueManualDuplicateConflictSchema,
  MANUAL_COMPANY_MAX,
  MANUAL_PARSE_TEXT_MAX,
  MANUAL_TITLE_MAX,
  type ExternalFieldStatus,
  type ExternalVacancyPrefill,
  type JobQueueBlockPickResponse,
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
  useParseExternalVacancy,
  usePickExternalBlocks,
  type QueueScopeSignature,
} from '@/hooks/use-job-queue'
import { useSeniorResume } from '@/hooks/use-senior-resume'
import { getAxiosStatus, getUserFacingErrorMessage } from '@/lib/axios-utils'
import { decodeBlockMap } from './decode-block-map'
import { PossibleDuplicates } from './PossibleDuplicates'

type Field = 'url' | 'title' | 'company' | 'description'

// Stryker disable next-line MethodExpression: both sides of every comparison go through norm, so upper- and lower-case folding compare alike
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

/** A picked value worth a «check this»: the title or company differs, or the description's opening does. */
const pickDiffers = (field: Exclude<Field, 'url'>, picked: string, shown: string) =>
  field === 'description'
    ? norm(picked).slice(0, 80) !== norm(shown).slice(0, 80)
    : norm(picked) !== norm(shown)

/** One look for every error banner in the dialog, so two at once read as one kind. */
const ALERT_BOX =
  // Stryker disable next-line StringLiteral: style classes only — no unit test can observe a look; manual-qa checks it
  'flex items-start gap-2 rounded-lg border border-destructive/40 p-3 text-sm text-destructive'

/** The page text to read on opening (`''` = none): only when the bookmarklet's own reading fell short. */
const autoParseText = (prefill: ExternalVacancyPrefill | null) =>
  prefill?.pageText && prefill.recognition !== 'recognized' ? prefill.pageText : ''

/** The 409 `JOB_QUEUE_MANUAL_DUPLICATE` body (with the card id when the actor may open it), else `null`. */
function manualDuplicate(error: unknown) {
  // only ever called with a set `create.error`, so the error itself is never nullish
  const data = (error as { response?: { data?: unknown } }).response?.data
  const parsed = jobQueueManualDuplicateConflictSchema.safeParse(data)
  return parsed.success ? parsed.data : null
}

const activeSeniors = (team: TeamDto | undefined) =>
  // Stryker disable next-line ArrayDeclaration: a non-member stand-in has no SENIOR role, so the filter drops it and the result is [] either way
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
  // any page can open the CRM with a payload, so HR must see the form was filled by a page, not by them
  const prefillHost = hostOf(prefill?.url)
  const [values, setValues] = useState<Record<Field, string>>({
    url: prefill?.url ?? '',
    // «nothing recognized» keeps only the link: whatever else was read is not a vacancy
    title: noVacancy ? '' : (prefill?.title ?? ''),
    company: noVacancy ? '' : (prefill?.company ?? ''),
    description: noVacancy ? '' : (prefill?.description ?? ''),
  })
  // only the user's picks are state; the defaults are derived per render, so a team list that
  // loads after the dialog opened (cold load of a hand-off) still preselects a team and a senior
  const [pickedTeamId, setPickedTeamId] = useState<string>()
  const [pickedSeniorId, setPickedSeniorId] = useState<string>()
  const teamId =
    teams.find((team) => team.id === pickedTeamId)?.id ??
    teams.find((team) => team.id === scope.teamId)?.id ??
    teams.find((team) => activeSeniors(team).some((m) => m.userId === initialSeniorId))?.id ??
    teams[0]?.id
  const seniors = activeSeniors(teams.find((team) => team.id === teamId))
  const seniorId =
    seniors.find((m) => m.userId === pickedSeniorId)?.userId ??
    (seniors.some((m) => m.userId === initialSeniorId) ? initialSeniorId : seniors[0]?.userId)
  const [confirming, setConfirming] = useState(false)
  const autoText = autoParseText(prefill)
  const [pasted, setPasted] = useState(autoText)
  // the fields «Заповнити з тексту» filled, marked «check this value» until the user edits them
  const [guessed, setGuessed] = useState<ReadonlySet<Field>>(new Set())
  // a reading filled at least one field: only then is a «nothing recognized» hand-off answered
  const [readSome, setReadSome] = useState(false)
  const parse = useParseExternalVacancy()
  // the answer is applied to the fields as they are when it arrives, not when it was asked
  const valuesRef = useRef(values)
  useEffect(() => {
    valuesRef.current = values
  }, [values])
  const create = useCreateManualJobQueueCard(scope)
  const resume = useSeniorResume(seniorId)
  // any edit makes the last answer stale: a «submit anyway» must follow a preview of this request
  const edited = () => {
    setConfirming(false)
    create.reset()
  }

  const fill = (text: string) => {
    parse.mutate(text, {
      onSuccess: (res) => {
        if (!res.isVacancy) return
        const current = valuesRef.current
        const read: Record<Exclude<Field, 'url'>, string | undefined> = {
          title: res.title,
          company: res.companyName,
          description: res.descriptionMd,
        }
        // only a field still empty is filled: what the user typed is never overwritten
        const filled = (Object.keys(read) as (keyof typeof read)[]).filter(
          (f) => read[f] && current[f].trim() === '',
        )
        if (filled.length === 0) return
        edited()
        setReadSome(true)
        setValues((v) => ({ ...v, ...Object.fromEntries(filled.map((f) => [f, read[f]])) }))
        setGuessed((g) => new Set([...g, ...filled]))
      },
    })
  }

  // a hand-off whose reading fell short is read on the server once per payload: the form is
  // remounted per opening, and the ref keeps a re-render (or a strict-mode rerun) from asking again
  const autoParsed = useRef<string | null>(null)
  const readPageText = () => {
    if (!autoText || autoParsed.current === autoText) return
    autoParsed.current = autoText
    fill(autoText)
  }
  const blockMap = prefill?.b ?? ''
  useEffect(() => {
    // with a block map the pick goes first, and the page text is read only if the pick fails
    if (!blockMap) readPageText()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the text alone, see above
  }, [autoText])

  const pick = usePickExternalBlocks()
  // fields the HR typed into: a pick that answers later never overwrites them
  const typed = useRef(new Set<Field>())
  // a submit in flight: a pick that answers now must not change the fields already sent, nor reset
  // the submit (that would drop its success or error)
  const sending = useRef(false)
  const applyPick = (res: JobQueueBlockPickResponse) => {
    // Stryker disable next-line ConditionalExpression: a «not a vacancy» reply has no field (its schema is strict), so it changes nothing either way; the return narrows the type
    if (!res.isVacancy) return
    if (sending.current) return
    const current = valuesRef.current
    const read: Record<Exclude<Field, 'url'>, string | undefined> = {
      title: res.title,
      company: res.companyName,
      description: res.descriptionMd,
    }
    // a vacancy with no field picked is read from the page text instead, as a failed pick is
    if (!Object.values(read).some((v) => v?.trim())) return readPageText()
    // an absent (or blank) pick field keeps what the page reader filled
    const changed = (Object.keys(read) as (keyof typeof read)[]).filter(
      (f) => read[f]?.trim() && !typed.current.has(f) && read[f] !== current[f],
    )
    if (changed.length === 0) return
    edited()
    setReadSome(true)
    setValues((v) => ({ ...v, ...Object.fromEntries(changed.map((f) => [f, read[f]])) }))
    const differ = changed.filter((f) => pickDiffers(f, read[f]!, current[f]))
    setGuessed((g) => new Set([...g, ...differ]))
  }
  // the map is picked once per payload, for the same reasons as the page text above
  const picked = useRef<string | null>(null)
  useEffect(() => {
    if (!blockMap || picked.current === blockMap) return
    picked.current = blockMap
    void decodeBlockMap(blockMap).then((blocks) => {
      // a map that does not decode is no map: the dialog goes on as without one
      if (!blocks) return readPageText()
      pick.mutate(
        // Stryker disable next-line OptionalChaining: a map comes only inside a prefill (blockMap is prefill?.b), so prefill is set here
        { ...(prefill?.url ? { url: prefill.url } : {}), tabTitle: '', blocks },
        { onSuccess: applyPick, onError: readPageText },
      )
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the map alone, see above
  }, [blockMap])

  const hint = (field: Field): ExternalFieldStatus | undefined => {
    if (guessed.has(field)) return 'guessed'
    if (!prefill) return undefined
    const status = noVacancy
      ? field === 'url' && values.url
        ? 'guessed'
        : 'missing'
      : prefill.status[field]
    // «not recognized» is a prompt to fill the field, so it goes once the field is filled
    return status === 'missing' && values[field].trim() !== '' ? undefined : status
  }

  const url = values.url.trim()
  const urlInvalid = url !== '' && !externalHttpsUrlSchema.safeParse(url).success
  const resumeData = resume.data?.resume
  const resumeId = resumeData?.status === 'READY' ? resumeData.id : undefined
  const missingText = (['title', 'company', 'description'] as const).some(
    (f) => values[f].trim() === '',
  )
  const blocked = create.isPending || urlInvalid || missingText || !teamId || !seniorId || !resumeId

  const conflict = create.error ? manualDuplicate(create.error) : null
  const possible = create.error ? getJobQueuePossibleDuplicateConflict(create.error) : null

  const send = (confirmPossibleDuplicate: boolean) => {
    // the checks after `blocked` only narrow the types: send() is wired to Submit alone, which is
    // disabled exactly while `blocked` is true, so this return is never taken at runtime
    // Stryker disable next-line ConditionalExpression,LogicalOperator: the `false` / operator variants are unreachable, see above; the `if (true)` variant is killed by every submit test but cannot be split from them by mutator name
    if (blocked || !teamId || !seniorId || !resumeId) return
    sending.current = true
    create.mutate(
      {
        title: values.title.trim(),
        companyName: values.company.trim(),
        descriptionMd: values.description.trim(),
        ...(url ? { applicationUrl: url } : {}),
        submission: { teamId, seniorId, resumeId },
        ...(confirmPossibleDuplicate ? { confirmPossibleDuplicate: true } : {}),
      },
      {
        onSuccess: (res) => {
          setConfirming(false)
          onSubmitted(res.submission.opportunityId)
        },
        onError: (error) => setConfirming(getJobQueuePossibleDuplicateConflict(error) !== null),
        onSettled: () => {
          sending.current = false
        },
      },
    )
  }

  const set = (field: Field) => (value: string) => {
    edited()
    typed.current.add(field)
    setValues((v) => ({ ...v, [field]: value }))
    setGuessed((g) => (g.has(field) ? new Set([...g].filter((f) => f !== field)) : g))
  }

  const parseStatus = parse.error ? getAxiosStatus(parse.error) : undefined

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
        {noVacancy && !readSome && (
          <p role="alert" data-testid="external-no-vacancy" className={ALERT_BOX}>
            <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <Trans>
              На цій сторінці вакансію не розпізнано. Виділіть її текст і натисніть закладку ще раз
              або заповніть поля вручну.
            </Trans>
          </p>
        )}
        {prefill && (!noVacancy || readSome) && (
          <p
            data-testid="external-prefilled-note"
            className="flex items-start gap-2 rounded-lg border p-3 text-sm text-muted-foreground"
          >
            <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {prefillHost ? (
              <Trans>
                Поля заповнено зі сторінки {prefillHost}. Перевірте їх, перш ніж записувати подачу.
              </Trans>
            ) : (
              <Trans>
                Поля заповнено з відкритої сторінки. Перевірте їх, перш ніж записувати подачу.
              </Trans>
            )}
          </p>
        )}
        {pick.isError && (
          <span data-testid="external-pick-unavailable" className="text-xs text-muted-foreground">
            <Trans>
              ШІ не розпізнав вакансію — решту полів взято з тексту сторінки, перевірте їх
            </Trans>
          </span>
        )}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-paste`}>
            <Trans>Текст вакансії</Trans>
          </Label>
          <Textarea
            id={`${id}-paste`}
            data-testid="external-paste"
            rows={4}
            maxLength={MANUAL_PARSE_TEXT_MAX}
            placeholder={t`Вставте текст вакансії, щоб заповнити поля нижче`}
            value={pasted}
            onChange={(e) => {
              setPasted(e.target.value)
              // a new text makes the last answer's banner stale; a reading under way still lands
              if (!parse.isPending) parse.reset()
            }}
          />
          <Button
            type="button"
            variant="outline"
            data-testid="external-fill"
            className="min-h-11 self-start sm:min-h-9"
            disabled={parse.isPending || pasted.trim() === ''}
            aria-busy={parse.isPending || undefined}
            onClick={() => fill(pasted)}
          >
            {parse.isPending ? (
              <Loader2 aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
            ) : (
              <Sparkles aria-hidden="true" />
            )}
            <Trans>Заповнити з тексту</Trans>
          </Button>
          {parse.data?.isVacancy === false && (
            <p role="alert" data-testid="external-parse-not-vacancy" className={ALERT_BOX}>
              <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <Trans>У цьому тексті не знайдено вакансії. Заповніть поля вручну.</Trans>
            </p>
          )}
          {parse.error != null && (
            <p role="alert" data-testid="external-parse-error" className={ALERT_BOX}>
              <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              {parseStatus === 429 ? (
                <Trans>Забагато запитів. Спробуйте трохи пізніше або заповніть поля вручну.</Trans>
              ) : (
                getUserFacingErrorMessage(parse.error)
              )}
            </p>
          )}
        </div>
        <TextField id={`${id}-url`} label={t`Посилання на вакансію`} hint={hint('url')}>
          <Input
            id={`${id}-url`}
            className="min-h-11 sm:min-h-9"
            data-testid="external-url"
            type="url"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
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
            className="min-h-11 sm:min-h-9"
            maxLength={MANUAL_TITLE_MAX}
            value={values.title}
            onChange={(e) => set('title')(e.target.value)}
          />
        </TextField>
        <TextField id={`${id}-company`} label={t`Компанія`} hint={hint('company')}>
          <Input
            id={`${id}-company`}
            className="min-h-11 sm:min-h-9"
            maxLength={MANUAL_COMPANY_MAX}
            value={values.company}
            onChange={(e) => set('company')(e.target.value)}
          />
        </TextField>
        <TextField id={`${id}-description`} label={t`Опис`} hint={hint('description')}>
          <Textarea
            id={`${id}-description`}
            rows={8}
            maxLength={DESCRIPTION_MD_MAX}
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
                // Stryker disable next-line StringLiteral: the team picker renders only for 2+ teams, and then teamId falls back to teams[0], so it is never undefined here
                value={teamId ?? ''}
                onValueChange={(next) => {
                  edited()
                  setPickedTeamId(next)
                  setPickedSeniorId(
                    activeSeniors(teams.find((team) => team.id === next))[0]?.userId,
                  )
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
            <Select
              value={seniorId ?? ''}
              onValueChange={(next) => {
                edited()
                setPickedSeniorId(next)
              }}
              disabled={seniors.length === 0}
            >
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
              loading={resume.isPending}
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
                  className="inline-flex min-h-11 items-center rounded-sm font-medium underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0"
                  onClick={() => onOpenCard(conflict.opportunityId!)}
                >
                  <Trans>Відкрити й подати там</Trans>
                </button>
              </>
            ) : (
              <Trans>Це посилання вже є в черзі.</Trans>
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

/** The host of a prefilled link; a pasted link may not be a URL at all. */
function hostOf(url: string | undefined): string {
  let host = ''
  try {
    // `new URL('undefined')` throws too, so a missing link needs no branch of its own
    host = new URL(String(url)).hostname
  } catch {
    // not a URL: the note names no host
  }
  return host
}
