/**
 * ResumeHeaderPanel — the name, email, phone and Telegram printed at the top of the PDF.
 *
 * Each field shows the senior's CRM profile value until HR overrides it. A field left equal to
 * the profile value, or emptied, is saved as `null` and keeps following the profile, so a later
 * profile edit still reaches it. The checks are the shared schemas the API applies.
 *
 * The parent remounts the panel (`key`) when the saved header or the profile changes, so the
 * inputs always start from the server state.
 */
import { useId, useState } from 'react'
import { RotateCcw, TriangleAlert } from 'lucide-react'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import type { MessageDescriptor } from '@lingui/core'
import {
  resumeHeaderEmailSchema,
  resumeHeaderNameSchema,
  resumeHeaderPhoneSchema,
  resumeHeaderTelegramSchema,
  type ResumeHeaderOverrides,
  type ResumeHeaderValues,
} from '@crm/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { translateZodMessage } from '@/lib/axios-utils'

type Field = keyof ResumeHeaderOverrides
type Values = Record<Field, string>

const FIELDS: Array<{
  key: Field
  label: MessageDescriptor
  type: 'text' | 'email' | 'tel'
  schema: { safeParse: (v: unknown) => { error?: { issues: Array<{ message: string }> } } }
  placeholder: string
}> = [
  {
    key: 'displayName',
    label: msg`Ім’я та прізвище`,
    type: 'text',
    schema: resumeHeaderNameSchema,
    placeholder: 'Ivan Petrenko',
  },
  {
    key: 'email',
    label: msg`Email`,
    type: 'email',
    schema: resumeHeaderEmailSchema,
    placeholder: 'name@example.com',
  },
  {
    key: 'phone',
    label: msg`Телефон`,
    type: 'tel',
    schema: resumeHeaderPhoneSchema,
    placeholder: '+380 67 123 45 67',
  },
  {
    key: 'telegram',
    label: msg`Telegram`,
    type: 'text',
    schema: resumeHeaderTelegramSchema,
    placeholder: '@username',
  },
]

/** The profile stores the handle with or without `@`; the header always prints it with one. */
function shownDefault(key: Field, defaults: ResumeHeaderValues): string {
  const value = (defaults[key] ?? '').trim()
  if (key === 'telegram' && value !== '' && !value.startsWith('@')) return `@${value}`
  return value
}

/** What a field saves: `null` (follow the profile) when empty or equal to the profile value. */
function toOverride(key: Field, value: string, defaults: ResumeHeaderValues): string | null {
  const trimmed = value.trim()
  return trimmed === '' || trimmed === shownDefault(key, defaults) ? null : trimmed
}

export function ResumeHeaderPanel({
  header,
  defaults,
  disabled,
  isSaving,
  staged,
  onSave,
}: {
  header: ResumeHeaderOverrides
  defaults: ResumeHeaderValues
  /** A check run is busy: the API answers a write with 409. */
  disabled: boolean
  isSaving: boolean
  /** A staged result awaits confirmation; a header write discards it. */
  staged: boolean
  onSave: (header: ResumeHeaderOverrides) => void
}) {
  const { i18n } = useLingui()
  const idPrefix = useId()
  const [values, setValues] = useState<Values>(() => ({
    displayName: header.displayName ?? shownDefault('displayName', defaults),
    email: header.email ?? shownDefault('email', defaults),
    phone: header.phone ?? shownDefault('phone', defaults),
    telegram: header.telegram ?? shownDefault('telegram', defaults),
  }))

  const next = Object.fromEntries(
    FIELDS.map(({ key }) => [key, toOverride(key, values[key], defaults)]),
  ) as ResumeHeaderOverrides
  const errors = Object.fromEntries(
    FIELDS.map(({ key, schema }) => {
      const value = next[key]
      return [key, value === null ? undefined : schema.safeParse(value).error?.issues[0]?.message]
    }),
  ) as Record<Field, string | undefined>
  const dirty = FIELDS.some(({ key }) => next[key] !== header[key])
  const valid = FIELDS.every(({ key }) => errors[key] === undefined)
  const locked = disabled || isSaving

  return (
    <section
      data-testid="resume-header-panel"
      className="rounded-xl border border-border/60 bg-card/50 p-4 sm:p-5"
    >
      <header className="mb-4">
        <h3 className="text-sm font-semibold">
          <Trans>Шапка резюме</Trans>
        </h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          <Trans>
            За замовчуванням — дані з профілю CRM. Порожнє поле повертає значення з профілю.
          </Trans>
        </p>
      </header>

      {staged && !disabled && (
        <p
          data-testid="resume-header-discards-staged"
          className="mb-4 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400"
        >
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" aria-hidden />
          <Trans>Зміна шапки скасує результат цієї перевірки.</Trans>
        </p>
      )}

      <form
        className="grid gap-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (dirty && valid && !locked) onSave(next)
        }}
      >
        {FIELDS.map(({ key, label, type, placeholder }) => {
          const id = `${idPrefix}-${key}`
          const error = translateZodMessage(errors[key])
          const profileValue = shownDefault(key, defaults)
          const overridden = next[key] !== null
          return (
            <div key={key} className="min-w-0 space-y-1.5">
              <Label htmlFor={id}>{i18n._(label)}</Label>
              <div className="flex gap-2">
                <Input
                  id={id}
                  data-testid={`resume-header-${key}`}
                  type={type}
                  value={values[key]}
                  placeholder={placeholder}
                  autoComplete="off"
                  disabled={locked}
                  aria-invalid={error !== undefined}
                  aria-describedby={`${id}-hint`}
                  onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                />
                {overridden && (
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="size-11 shrink-0 sm:size-9"
                    disabled={locked}
                    aria-label={i18n._(msg`Повернути значення з профілю`)}
                    title={i18n._(msg`Повернути значення з профілю`)}
                    data-testid={`resume-header-${key}-reset`}
                    onClick={() => setValues((v) => ({ ...v, [key]: profileValue }))}
                  >
                    <RotateCcw className="size-4" aria-hidden />
                  </Button>
                )}
              </div>
              <p
                id={`${id}-hint`}
                className={error ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}
              >
                {error ??
                  (overridden ? (
                    profileValue === '' ? (
                      <Trans>У профілі не вказано</Trans>
                    ) : (
                      <Trans>У профілі: {profileValue}</Trans>
                    )
                  ) : (
                    <Trans>З профілю CRM</Trans>
                  ))}
              </p>
            </div>
          )
        })}
        <div className="flex justify-end sm:col-span-2">
          <Button
            type="submit"
            className="min-h-11 sm:min-h-9"
            disabled={!dirty || !valid || locked}
            data-testid="resume-header-save"
          >
            {isSaving ? <Trans>Зберігаємо…</Trans> : <Trans>Зберегти шапку</Trans>}
          </Button>
        </div>
      </form>
    </section>
  )
}
