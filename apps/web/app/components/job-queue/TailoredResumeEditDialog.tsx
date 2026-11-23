import { useId, useState } from 'react'
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

type Editable = NonNullable<TailoredResumeDetailDto['editable']>
type Body = Omit<TailoredEditRequest, 'teamId'>

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

/**
 * Spec §4 step 6: only the generated fields (summary, skills, each experience item's bullets, the
 * cover letter). Limits are the PUT's own schema (`RESUME_LIMITS`), checked before the request.
 */
export function TailoredResumeEditDialog({
  onClose,
  editable,
  coverLetter,
  saving,
  onSave,
}: {
  onClose: () => void
  editable: Editable
  coverLetter: string
  saving: boolean
  onSave: (body: Body) => void
}) {
  const { i18n } = useLingui()
  const id = useId()
  const [summary, setSummary] = useState(editable.summary)
  const [skills, setSkills] = useState(editable.skills.join('\n'))
  const [bullets, setBullets] = useState(editable.experience.map((e) => e.bullets.join('\n')))
  const [letter, setLetter] = useState(coverLetter)
  const [invalid, setInvalid] = useState<keyof Body | null>(null)

  const save = () => {
    const parsed = tailoredEditRequestSchema.safeParse({
      summary,
      skills: lines(skills),
      bullets: bullets.map(lines),
      coverLetter: letter,
    })
    if (!parsed.success) {
      setInvalid(parsed.error.issues[0]!.path[0] as keyof Body)
      return
    }
    setInvalid(null)
    onSave(parsed.data)
  }

  const field = invalid && i18n._(FIELDS[invalid])

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
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-summary`}>
              <Trans>Підсумок</Trans>
            </Label>
            <Textarea
              id={`${id}-summary`}
              rows={4}
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
            />
            <span className="text-xs text-muted-foreground tabular-nums">
              {summary.length}/{RESUME_LIMITS.summary}
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-skills`}>
              <Trans>Навички (по одній у рядку)</Trans>
            </Label>
            <Textarea
              id={`${id}-skills`}
              rows={4}
              value={skills}
              onChange={(e) => setSkills(e.target.value)}
            />
          </div>
          {editable.experience.map((item, i) => (
            <div key={i} className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-bullets-${i}`} className="[overflow-wrap:anywhere]">
                {item.company} — {item.role}
              </Label>
              <span className="text-xs text-muted-foreground">
                {item.period} · <Trans>по одному пункту в рядку</Trans>
              </span>
              <Textarea
                id={`${id}-bullets-${i}`}
                rows={3}
                value={bullets[i]}
                onChange={(e) =>
                  setBullets((all) => all.map((b, j) => (j === i ? e.target.value : b)))
                }
              />
            </div>
          ))}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-letter`}>
              <Trans>Супровідний лист</Trans>
            </Label>
            <Textarea
              id={`${id}-letter`}
              rows={8}
              value={letter}
              onChange={(e) => setLetter(e.target.value)}
            />
          </div>
          {field && (
            <p role="alert" className="text-sm text-destructive">
              <Trans>Поле «{field}» порожнє або перевищує ліміт.</Trans>
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
          <Button type="button" className="min-h-11 sm:min-h-9" disabled={saving} onClick={save}>
            <Trans>Зберегти</Trans>
          </Button>
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}
