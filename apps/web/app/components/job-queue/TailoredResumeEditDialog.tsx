import { useId, type ChangeEvent } from 'react'
import { useForm, useStore } from '@tanstack/react-form'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import type { MessageDescriptor } from '@lingui/core'
import {
  RESUME_LIMITS,
  tailoredEditRequestSchema,
  type TailoredEditRequest,
  type TailoredResumeDetailDto,
} from '@crm/shared'
import { Button } from '@/components/ui/button'
import {
  CrmDialogBody,
  CrmDialogContent,
  CrmDialogFooter,
  CrmDialogHeader,
} from '@/components/ui/crm-dialog'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { getUserFacingErrorMessage } from '@/lib/axios-utils'

type Editable = NonNullable<TailoredResumeDetailDto['editable']>
type Body = Omit<TailoredEditRequest, 'teamId'>
type Values = { summary: string; skills: string; bullets: string[]; coverLetter: string }

// the PUT's own bound, so the counter cannot drift from what Save refuses
const COVER_LETTER_MAX = tailoredEditRequestSchema.shape.coverLetter.maxLength

const FIELDS: Record<keyof Body, MessageDescriptor> = {
  summary: msg`Підсумок`,
  skills: msg`Навички`,
  bullets: msg`Досвід`,
  coverLetter: msg`Супровідний лист`,
}

/** One entry per non-blank line, trimmed. */
const lines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

const toBody = (v: Values) => ({
  summary: v.summary,
  skills: lines(v.skills),
  bullets: v.bullets.map(lines),
  coverLetter: v.coverLetter,
})

/** The first refused field as an id suffix: `summary`, `skills`, `coverLetter` or `bullets-<i>`. */
function firstInvalid(v: Values): string | undefined {
  const parsed = tailoredEditRequestSchema.safeParse(toBody(v))
  if (parsed.success) return undefined
  const [key, index] = parsed.error.issues[0]!.path
  return key === 'bullets' ? `bullets-${String(index)}` : String(key)
}

/**
 * Spec §4 step 6: only the generated fields (summary, skills, each experience item's bullets, the
 * cover letter). Limits are the PUT's own schema (`RESUME_LIMITS`), checked before the request; a
 * refused Save marks and focuses the first refused field. A refused PUT shows here, edits kept.
 */
export function TailoredResumeEditDialog({
  onClose,
  editable,
  coverLetter,
  saving,
  error,
  onSave,
}: {
  onClose: () => void
  editable: Editable
  coverLetter: string
  saving: boolean
  error: unknown
  onSave: (body: Body) => void
}) {
  const { i18n } = useLingui()
  const id = useId()
  const form = useForm({
    defaultValues: {
      summary: editable.summary,
      skills: editable.skills.join('\n'),
      bullets: editable.experience.map((e) => e.bullets.join('\n')),
      coverLetter,
    } as Values,
    validators: { onSubmit: ({ value }) => firstInvalid(value) },
    // focus scrolls the refused field into view; its counter below it may still sit under the
    // body's lower edge on a small screen, so the field's block is scrolled in whole
    onSubmitInvalid: ({ value }) => {
      const el = document.getElementById(`${id}-${firstInvalid(value)}`)
      // Stryker disable OptionalChaining: only an outer `bullets` max issue has no field, and the dialog draws one field per server-sent item, which the server caps; every field sits in its own block
      el?.focus()
      el?.parentElement?.scrollIntoView({ block: 'nearest' })
      // Stryker restore OptionalChaining
    },
    // runs only once the validator passed, so the parse cannot throw here
    onSubmit: ({ value }) => onSave(tailoredEditRequestSchema.parse(toBody(value))),
  })
  const invalid = useStore(form.store, (st) => st.errorMap.onSubmit)
  const key = invalid?.startsWith('bullets') ? 'bullets' : (invalid as keyof Body | undefined)
  const field = key && i18n._(FIELDS[key])
  /** One textarea's id, value binding and invalid mark. */
  const area = (suffix: string, value: string, onChange: (v: string) => void) => ({
    id: `${id}-${suffix}`,
    value,
    onChange: (e: ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value),
    'aria-invalid': invalid === suffix || undefined,
  })

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <CrmDialogContent maxWidth="sm:max-w-2xl">
        <CrmDialogHeader>
          <DialogTitle>
            <Trans>Редагувати CV і лист</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              Збереження оновить PDF і завантажить його знову. Перевірки не запускаються.
            </Trans>
          </DialogDescription>
        </CrmDialogHeader>
        <CrmDialogBody className="flex flex-col gap-4 pb-4">
          <form.Field name="summary">
            {(f) => (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${id}-summary`}>
                  <Trans>Підсумок</Trans>
                </Label>
                <Textarea rows={4} {...area('summary', f.state.value, f.handleChange)} />
                <span
                  data-invalid={invalid === 'summary' || undefined}
                  className="text-xs tabular-nums text-muted-foreground data-[invalid]:text-destructive"
                >
                  {f.state.value.length}/{RESUME_LIMITS.summary}
                </span>
              </div>
            )}
          </form.Field>
          <form.Field name="skills">
            {(f) => (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${id}-skills`}>
                  <Trans>Навички (по одній у рядку)</Trans>
                </Label>
                <Textarea rows={4} {...area('skills', f.state.value, f.handleChange)} />
              </div>
            )}
          </form.Field>
          {editable.experience.map((item, i) => (
            <form.Field key={i} name={`bullets[${i}]`}>
              {(f) => (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`${id}-bullets-${i}`} className="[overflow-wrap:anywhere]">
                    {item.company} — {item.role}
                  </Label>
                  <span className="text-xs text-muted-foreground">
                    {item.period} · <Trans>по одному пункту в рядку</Trans>
                  </span>
                  <Textarea rows={3} {...area(`bullets-${i}`, f.state.value, f.handleChange)} />
                </div>
              )}
            </form.Field>
          ))}
          <form.Field name="coverLetter">
            {(f) => (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${id}-coverLetter`}>
                  <Trans>Супровідний лист</Trans>
                </Label>
                <Textarea rows={8} {...area('coverLetter', f.state.value, f.handleChange)} />
                <span
                  data-invalid={invalid === 'coverLetter' || undefined}
                  className="text-xs tabular-nums text-muted-foreground data-[invalid]:text-destructive"
                >
                  {f.state.value.length}/{COVER_LETTER_MAX}
                </span>
              </div>
            )}
          </form.Field>
          {field && (
            <p role="alert" className="text-sm text-destructive">
              <Trans>Поле «{field}» порожнє або перевищує ліміт.</Trans>
            </p>
          )}
          {error != null && (
            <p role="alert" className="text-sm text-destructive">
              {getUserFacingErrorMessage(error)}
            </p>
          )}
        </CrmDialogBody>
        <CrmDialogFooter>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 sm:min-h-9"
            data-testid="cancel-button"
            onClick={onClose}
          >
            <Trans>Скасувати</Trans>
          </Button>
          <Button
            type="button"
            className="min-h-11 sm:min-h-9"
            disabled={saving}
            onClick={() => void form.handleSubmit()}
          >
            <Trans>Зберегти</Trans>
          </Button>
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}
