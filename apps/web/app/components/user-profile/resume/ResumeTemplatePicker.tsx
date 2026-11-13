/**
 * ResumeTemplatePicker — four catalog templates as thumbnail tiles (verified
 * base resume design §5.6). Picking a tile is a write (`PUT template`) with no
 * Apply button. The thumbnails are static PNGs of one synthetic resume
 * (`apps/api/scripts/render-resume-thumbnails.ts`), so the tiles differ only by look.
 */
import { useRef } from 'react'
import * as RadioGroupPrimitive from '@radix-ui/react-radio-group'
import { TriangleAlert } from 'lucide-react'
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
  /**
   * A write is pending or a run is busy. Tiles turn `aria-disabled`, not
   * natively disabled, so the focused tile keeps focus (spec §8).
   */
  disabled: boolean
  /** A check run is in flight (`verificationBusy`): the picker says when it opens again. */
  busy: boolean
  /** The resume is VERIFIED: a pick starts a template run, and the note says so. */
  verified: boolean
  /** A staged result awaits confirmation: a pick discards it, and the warning says so. */
  staged: boolean
  onChange: (name: ResumeTemplateName) => void
}

const ARROW_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])

export function ResumeTemplatePicker({
  value,
  disabled,
  busy,
  verified,
  staged,
  onChange,
}: ResumeTemplatePickerProps) {
  const { i18n } = useLingui()
  // Radix checks the tile an arrow key focuses. Here a pick is a write, so an
  // arrow only moves focus (manual activation, R58): click, Space or Enter commits.
  const arrowRef = useRef(false)
  const commit = (name: ResumeTemplateName) => {
    if (!disabled && name !== value) onChange(name)
  }
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
      {staged && !busy && (
        <p
          data-testid="resume-template-discards-staged"
          className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400"
        >
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" aria-hidden />
          <Trans>Зміна шаблону скасує цей результат.</Trans>
        </p>
      )}
      <RadioGroup
        aria-labelledby="resume-template-picker-title"
        aria-disabled={disabled || undefined}
        value={value ?? ''}
        onKeyDownCapture={(e) => {
          arrowRef.current = ARROW_KEYS.has(e.key)
        }}
        onKeyUpCapture={() => {
          arrowRef.current = false
        }}
        // A key released outside the group never reaches it; focus leaving the
        // group clears the flag. Arrow moves between tiles keep focus inside.
        onBlurCapture={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) arrowRef.current = false
        }}
        onValueChange={(next) => {
          // Consume the flag: one arrow press swallows at most one change.
          const fromArrow = arrowRef.current
          arrowRef.current = false
          if (!fromArrow) commit(resumeTemplateNameSchema.parse(next))
        }}
        className="grid grid-cols-2 gap-3 md:grid-cols-4"
      >
        {RESUME_TEMPLATE_NAMES.map((name) => {
          const current = name === value
          const id = templateTileId(name)
          return (
            <RadioGroupPrimitive.Item
              key={name}
              value={name}
              id={id}
              data-testid={`resume-template-${name}`}
              aria-disabled={disabled || undefined}
              aria-labelledby={`${id}-name`}
              aria-describedby={current ? `${id}-desc ${id}-current` : `${id}-desc`}
              // Radix keeps Enter inert on a radio; here Enter commits as Space does.
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit(name)
              }}
              className={cn(
                'flex flex-col gap-2 rounded-lg border border-border/60 p-2 text-left transition-colors xl:max-w-[200px]',
                'hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                'aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:bg-transparent',
                current && 'border-primary ring-1 ring-primary',
              )}
            >
              <img
                src={`/resume-templates/${name}.png`}
                alt=""
                loading="lazy"
                className="aspect-[1/1.414] w-full rounded-sm object-cover object-top"
              />
              <span id={`${id}-name`} className="text-sm font-medium">
                {i18n._(TEMPLATE_MESSAGES[name].name)}
              </span>
              <span id={`${id}-desc`} className="text-xs text-muted-foreground">
                {i18n._(TEMPLATE_MESSAGES[name].desc)}
              </span>
              {current && (
                <Badge
                  id={`${id}-current`}
                  className="w-fit border-transparent bg-yellow-subtle text-primary hover:bg-yellow-subtle"
                >
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
