/**
 * ResumeLayoutPanel — the only typesetting controls a human gets.
 *
 * The resume is stored as a TEMPLATE plus DATA. The template is code, it lives
 * on the server, and nothing in this app can edit it — deliberately, because
 * the whole point of the split is that vacancy tailoring hands a model fields
 * and gets fields back, with the layout out of reach. A free-form template
 * editor here would re-open that door from the other side.
 *
 * So HR gets four switches, each a closed set of values:
 *   - the ORDER of the sections,
 *   - which sections are HIDDEN,
 *   - DENSITY (how tight the vertical rhythm is),
 *   - FONT SCALE.
 *
 * Every change is a save: the server re-renders the PDF as a background job and
 * the preview catches up on its own (the query polls while a render is in
 * flight). Nothing here waits on a typesetter.
 */
import { useState } from 'react'
import { ArrowDown, ArrowUp, Eye, EyeOff, RotateCcw } from 'lucide-react'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import type { MessageDescriptor } from '@lingui/core'
import {
  DEFAULT_RESUME_LAYOUT,
  RESUME_SECTION_ORDER,
  normalizeResumeLayout,
  type ResumeDensity,
  type ResumeFontScale,
  type ResumeLayoutOptions,
  type ResumeSectionKey,
} from '@crm/shared'
import { Button } from '@/components/ui/button'
import { SegmentedToggle } from '@/components/ui/segmented-toggle'
import { cn } from '@/lib/utils'

/**
 * HOVER LABELS ON THE ICON-ONLY BUTTONS — what works, and what does not.
 *
 * All six controls per row (hide / up / down) carry `aria-label` and `title`.
 * `title` gives a hover label WHILE THE BUTTON IS ENABLED, which is the
 * one-line fix `docs/design/senior-resume.md` asks for and the same approach
 * `animated-tabs.tsx` uses.
 *
 * KNOWN GAP, measured: when a button is DISABLED the label is unreachable. Our
 * shared `Button` sets `pointer-events: none` in its disabled styles, so the
 * native tooltip never fires — and a Radix tooltip would not fire on a disabled
 * trigger either. A read-only viewer therefore still infers these icons from
 * their shapes and the section name beside them. An earlier version of this
 * comment claimed the gap was closed; it was not, and the reviewer measured it.
 *
 * Closing it needs a wrapper that keeps pointer events while the button does
 * not, or a change to the shared Button's disabled styling — a change outside
 * this panel, affecting every icon button in the app, which is why it is
 * recorded here rather than done locally. Stated once, above all six controls,
 * instead of on whichever one happened to be first.
 */

/**
 * task-i18n-stage3b-pr3 (Step 4): `msg` (module-level, fixes the SOURCE `uk`
 * text) resolved against the active catalog by `i18n._()` in the component
 * below — matching the headings the template prints (also translated,
 * server-side). Never called at module level with `t` — that would freeze
 * the string at import time (Global Constraints).
 */
const SECTION_LABEL_MESSAGES: Record<ResumeSectionKey, MessageDescriptor> = {
  summary: msg`Про себе`,
  skills: msg`Навички`,
  experience: msg`Досвід роботи`,
  education: msg`Освіта`,
  languages: msg`Мови`,
  links: msg`Посилання`,
} satisfies Record<ResumeSectionKey, MessageDescriptor>

export interface ResumeLayoutPanelProps {
  layout: ResumeLayoutOptions
  canEdit: boolean
  isSaving: boolean
  onSave: (layout: ResumeLayoutOptions) => void
}

/** Move `key` one step in `order`, returning a NEW array. */
export function moveSection(
  order: readonly ResumeSectionKey[],
  key: ResumeSectionKey,
  direction: -1 | 1,
): ResumeSectionKey[] {
  const from = order.indexOf(key)
  const to = from + direction
  if (from < 0 || to < 0 || to >= order.length) return [...order]
  const next = [...order]
  const moved = next[from] as ResumeSectionKey
  next[from] = next[to] as ResumeSectionKey
  next[to] = moved
  return next
}

export function ResumeLayoutPanel({ layout, canEdit, isSaving, onSave }: ResumeLayoutPanelProps) {
  const { t, i18n } = useLingui()
  // Runtime-only (need `t`) — defined inside the component, not at module
  // level, same reasoning as `SECTION_LABEL_MESSAGES` above.
  const DENSITY_OPTIONS = [
    { value: 'compact' as const, label: t`Щільно` },
    { value: 'normal' as const, label: t`Стандартно` },
    { value: 'relaxed' as const, label: t`Вільно` },
  ]
  const FONT_SCALE_OPTIONS = [
    { value: 'small' as const, label: t`Дрібний` },
    { value: 'normal' as const, label: t`Звичайний` },
    { value: 'large' as const, label: t`Великий` },
  ]

  // Normalised locally as well as on the server: a layout saved before a
  // section existed must not render a short list here either.
  const [draft, setDraft] = useState<ResumeLayoutOptions>(() => normalizeResumeLayout(layout))

  const dirty = JSON.stringify(draft) !== JSON.stringify(normalizeResumeLayout(layout))

  const update = (patch: Partial<ResumeLayoutOptions>): void => {
    setDraft((current) => ({ ...current, ...patch }))
  }

  const toggleHidden = (key: ResumeSectionKey): void => {
    update({
      hiddenSections: draft.hiddenSections.includes(key)
        ? draft.hiddenSections.filter((k) => k !== key)
        : RESUME_SECTION_ORDER.filter((k) => k === key || draft.hiddenSections.includes(k)),
    })
  }

  return (
    <section
      data-testid="resume-layout-panel"
      className="rounded-xl border border-border/60 bg-card/50 p-4 sm:p-5"
    >
      <header className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">
            <Trans>Оформлення</Trans>
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            <Trans>Порядок і вигляд розділів. Текст резюме редагується вище.</Trans>
          </p>
        </div>
        {canEdit && (
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="resume-layout-reset"
              disabled={isSaving}
              onClick={() => setDraft(DEFAULT_RESUME_LAYOUT)}
            >
              <RotateCcw className="mr-1.5 size-3.5" />
              <Trans>Скинути</Trans>
            </Button>
            <Button
              type="button"
              size="sm"
              data-testid="resume-layout-save"
              disabled={!dirty || isSaving}
              onClick={() => onSave(draft)}
            >
              {isSaving ? t`Зберігаємо…` : t`Застосувати`}
            </Button>
          </div>
        )}
      </header>

      <div className="space-y-5">
        <div>
          <p className="mb-2 text-xs font-medium text-muted-foreground">
            <Trans>Розділи</Trans>
          </p>
          <ul className="space-y-1.5" data-testid="resume-layout-sections">
            {draft.sectionOrder.map((key, index) => {
              const hidden = draft.hiddenSections.includes(key)
              const label = i18n._(SECTION_LABEL_MESSAGES[key])
              return (
                <li
                  key={key}
                  data-testid={`resume-layout-section-${key}`}
                  className={cn(
                    'flex items-center justify-between gap-2 rounded-lg border border-border/50 px-3 py-2',
                    hidden && 'opacity-55',
                  )}
                >
                  <span className={cn('text-sm', hidden && 'line-through')}>{label}</span>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      // 44px touch target on mobile — a 24px icon button is
                      // reachable with a mouse and not with a thumb.
                      className="size-11 sm:size-8"
                      aria-label={hidden ? t`Показати «${label}»` : t`Приховати «${label}»`}
                      title={hidden ? t`Показати «${label}»` : t`Приховати «${label}»`}
                      data-testid={`resume-layout-toggle-${key}`}
                      disabled={!canEdit || isSaving}
                      onClick={() => toggleHidden(key)}
                    >
                      {hidden ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-11 sm:size-8"
                      aria-label={t`Перемістити «${label}» вгору`}
                      title={t`Перемістити «${label}» вгору`}
                      data-testid={`resume-layout-up-${key}`}
                      disabled={!canEdit || isSaving || index === 0}
                      onClick={() =>
                        update({ sectionOrder: moveSection(draft.sectionOrder, key, -1) })
                      }
                    >
                      <ArrowUp className="size-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-11 sm:size-8"
                      aria-label={t`Перемістити «${label}» вниз`}
                      title={t`Перемістити «${label}» вниз`}
                      data-testid={`resume-layout-down-${key}`}
                      disabled={!canEdit || isSaving || index === draft.sectionOrder.length - 1}
                      onClick={() =>
                        update({ sectionOrder: moveSection(draft.sectionOrder, key, 1) })
                      }
                    >
                      <ArrowDown className="size-4" />
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              <Trans>Щільність</Trans>
            </p>
            <SegmentedToggle
              value={draft.density}
              onChange={(density: ResumeDensity) => update({ density })}
              options={DENSITY_OPTIONS}
              ariaLabel={t`Щільність верстки`}
              layoutId="resume-density"
              size="sm"
              disabled={!canEdit || isSaving}
              testId="resume-layout-density"
            />
          </div>
          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              <Trans>Розмір шрифту</Trans>
            </p>
            <SegmentedToggle
              value={draft.fontScale}
              onChange={(fontScale: ResumeFontScale) => update({ fontScale })}
              options={FONT_SCALE_OPTIONS}
              ariaLabel={t`Розмір шрифту`}
              layoutId="resume-font-scale"
              size="sm"
              disabled={!canEdit || isSaving}
              testId="resume-layout-font-scale"
            />
          </div>
        </div>
      </div>
    </section>
  )
}
