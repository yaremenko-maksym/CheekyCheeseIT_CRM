/**
 * ResumeTemplatePicker — four catalog templates as thumbnail tiles (verified
 * base resume design §5.6). Picking a tile is a write (`PUT template`) with no
 * Apply button. The thumbnails are static PNGs of one synthetic resume
 * (`apps/api/scripts/render-resume-thumbnails.ts`), so the tiles differ only by look.
 */
import * as RadioGroupPrimitive from '@radix-ui/react-radio-group'
import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import {
  RESUME_TEMPLATE_NAMES,
  resumeTemplateNameSchema,
  type ResumeTemplateName,
} from '@crm/shared'
import { Badge } from '@/components/ui/badge'
import { RadioGroup } from '@/components/ui/radio-group'
import { translateApiError } from '@/lib/axios-utils'
import { cn } from '@/lib/utils'

const TEMPLATE_MESSAGES: Record<
  ResumeTemplateName,
  { name: MessageDescriptor; desc: MessageDescriptor }
> = {
  classic: { name: msg`Класичний`, desc: msg`Шрифт із засічками, ім’я по центру` },
  modern: { name: msg`Сучасний`, desc: msg`Без засічок, акцентна лінія під заголовками` },
  compact: { name: msg`Стислий`, desc: msg`Дати праворуч, менше відступів` },
  technical: { name: msg`Технічний`, desc: msg`Навички за категоріями` },
}

/** The tile name, for the staged-PDF meta line as well. */
export function useTemplateLabel(): (name: ResumeTemplateName) => string {
  const { i18n } = useLingui()
  return (name) => i18n._(TEMPLATE_MESSAGES[name].name)
}

/** A tile's DOM id: the failure panel's "Choose a template" focuses one. */
export function templateTileId(name: ResumeTemplateName): string {
  return `resume-template-tile-${name}`
}

export interface ResumeTemplatePickerProps {
  /** The stored catalog template; `null` while a personal template is stored. */
  value: ResumeTemplateName | null
  disabled: boolean
  /** A check run is in flight (`verificationBusy`): the picker says when it opens again. */
  busy: boolean
  /** The resume is VERIFIED: a pick starts a template run, and the note says so. */
  verified: boolean
  onChange: (name: ResumeTemplateName) => void
}

export function ResumeTemplatePicker({
  value,
  disabled,
  busy,
  verified,
  onChange,
}: ResumeTemplatePickerProps) {
  const { i18n } = useLingui()
  return (
    <div data-testid="resume-template-picker" className="space-y-3">
      <div>
        <h3 id="resume-template-picker-title" className="text-sm font-semibold">
          <Trans>Шаблон</Trans>
        </h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          <Trans>
            Усі шаблони каталогу підтримують перевірку. Мініатюри — на прикладі одного резюме.
          </Trans>
        </p>
      </div>
      {value === null && (
        <p className="text-xs text-muted-foreground" data-testid="resume-template-custom-note">
          {translateApiError('RESUME_CUSTOM_TEMPLATE', undefined)}
        </p>
      )}
      <RadioGroup
        aria-labelledby="resume-template-picker-title"
        aria-disabled={disabled}
        disabled={disabled}
        value={value ?? ''}
        onValueChange={(next) => onChange(resumeTemplateNameSchema.parse(next))}
        className="grid grid-cols-2 gap-3 md:grid-cols-4"
      >
        {RESUME_TEMPLATE_NAMES.map((name) => {
          const current = name === value
          return (
            <RadioGroupPrimitive.Item
              key={name}
              value={name}
              id={templateTileId(name)}
              data-testid={`resume-template-${name}`}
              className={cn(
                'flex flex-col gap-2 rounded-lg border border-border/60 p-2 text-left transition-colors xl:max-w-[200px]',
                'hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent',
                current && 'border-primary ring-1 ring-primary',
              )}
            >
              <img
                src={`/resume-templates/${name}.png`}
                alt=""
                loading="lazy"
                className="aspect-[1/1.414] w-full rounded-sm object-cover object-top"
              />
              <span className="text-sm font-medium">{i18n._(TEMPLATE_MESSAGES[name].name)}</span>
              <span className="text-xs text-muted-foreground">
                {i18n._(TEMPLATE_MESSAGES[name].desc)}
              </span>
              {current && (
                <Badge className="w-fit border-transparent bg-yellow-subtle text-primary hover:bg-yellow-subtle">
                  <Trans>Поточний</Trans>
                </Badge>
              )}
            </RadioGroupPrimitive.Item>
          )
        })}
      </RadioGroup>
      {verified && !busy && (
        <p className="text-xs text-muted-foreground">
          <Trans>
            Зміна шаблону запустить перевірку макета. Резюме лишиться перевіреним, а якщо перевірка
            не пройде — збереже попередній шаблон.
          </Trans>
        </p>
      )}
      {busy && (
        <p className="text-xs text-muted-foreground">
          <Trans>Шаблон можна змінити після перевірки.</Trans>
        </p>
      )}
    </div>
  )
}
