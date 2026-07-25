/**
 * VacancyTranslationFields — task-vacancy-i18n-jobposting C1. Optional
 * per-locale (uk/ru/es/pt) title + description overrides for a vacancy,
 * shown as tabs (owner scope-change 2026-07-25: "пять языковых секций
 * подряд сделают форму нечитаемой — используй табы/аккордеон по локали с
 * индикатором «переведено/нет»"). Shared by `VacancySheet` (create/edit) and
 * `$vacancyId.tsx` (inline edit) — same pattern as `VacancyFormFields`.
 *
 * A locale counts as "переведено" (dot indicator) only when BOTH title AND
 * description are non-empty — matches `vacancyTranslationSchema`'s
 * requirement that a locale entry is all-or-nothing; a half-filled tab is
 * simply not sent as a translation (see `../constants` `buildTranslationsDto`
 * — filters on this exact condition).
 *
 * design-review round 1 (PR #422, HIGH-1) — the tab ROW itself is compact by
 * design now: 2-letter locale code (`locale.toUpperCase()`, data-driven off
 * `VACANCY_TRANSLATION_LOCALES` — a 6th locale needs zero layout changes)
 * + a small status glyph instead of a full text badge, with the full status
 * carried in `aria-label` for screen readers. 4 tabs at this size total
 * ≈220px, comfortably inside the narrowest context that was failing (Sheet
 * `max-w-md` = 448px, and the 375px viewport where the Sheet itself goes
 * full-width). `overflow-x-auto` on the list is a defensive fallback ONLY (a
 * future 6th/7th locale, unusual browser zoom) — the fix itself is the
 * compact width, not scrolling. Verified in all 3 contexts the design review
 * flagged (list→Sheet @1440, list→Sheet @375, inline form @375) plus the
 * already-working wide detail column @1440 — see PR body for the concrete
 * measurements/screenshots. Solved locally in this component, NOT in the
 * shared `ui/tabs.tsx` primitive (other screens use TabsList too — see that
 * file's other call sites).
 *
 * design-review round 2 (PR #422, LOW-1) — "переведено"/"ошибка" used to
 * differ ONLY by dot colour (green/red), unreadable for colour-blind users
 * or in grayscale. Replaced the dot with 3 SHAPE-distinct glyphs
 * (`lucide-react`, `size-3`): plain outline circle = не переведено,
 * check-in-circle = переведено, triangle with "!" = ошибка — each shape is
 * distinguishable on its own, colour is now reinforcement, not the only
 * signal.
 *
 * design-review round 1 (PR #422, HIGH-2) — "ошибка валидации абсолютно
 * беззвучна", made worse by tabs (an invalid field can hide in a closed
 * tab). Each title/description field keeps an `onBlur` Zod-backed validator
 * (empty = valid — a locale is simply not being translated; non-empty must
 * satisfy `vacancyTranslationSchema`) for live feedback while typing.
 *
 * Submit-time errors are DELIBERATELY not routed through TanStack Form's own
 * `field.state.meta` at all (two earlier approaches — a plain `{ fields }`
 * validator return, and imperative `formApi.setFieldMeta` — were both tried
 * and empirically disproven against a live scratch stack; see
 * `computeVacancySubmitErrors`'s doc in `../constants` for the full story,
 * including a React-StrictMode-specific footgun). Instead, the PARENT
 * (`VacancySheet.tsx` / `$vacancyId.tsx`) keeps its own plain
 * `submitFieldErrors` state and passes it down as a prop; each field falls
 * back to `submitFieldErrors[path]` whenever TanStack's own (mount-
 * dependent) error is empty. `onFieldEdited` lets a field tell the parent to
 * drop its now-stale entry the moment the user types in it again. The
 * `focusRequest` prop still force-switches the active tab to wherever the
 * first reported error lives, so it's never left invisible behind a closed
 * tab — Tabs are CONTROLLED (not `defaultValue`) for exactly this reason.
 *
 * design-review round 2 (PR #422, MED) — the error text was only linked to
 * its field VISUALLY (red border/text). Each error `<p>` now has a stable
 * `id` (`${path}-error`) and the input/textarea carries `aria-invalid` +
 * `aria-describedby` pointing at it — a screen reader now announces both
 * "invalid" and the message text when the field receives focus.
 *
 * design-review round 2 — tab-trigger height (28px) stays as-is: above the
 * WCAG 2.2 AA target-size minimum (24px), below the CRM's usual 44px touch
 * target — an intentional density trade-off for a 4-tab row inside an
 * already-narrow Sheet, not an oversight (see PR body).
 */
import { useEffect, useState } from 'react'
import { Circle, CircleCheck, TriangleAlert } from 'lucide-react'
import type { VacancyTranslationLocale } from '@crm/shared'
import { VACANCY_TRANSLATION_LOCALES, vacancyTranslationSchema } from '@crm/shared'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import {
  VACANCY_TRANSLATION_LOCALE_LABELS,
  zodIssueRu,
  type VacancyTranslationFocusRequest,
} from '../constants'
import type { AnyField, AnyForm } from './VacancyFormFields'

export type { VacancyTranslationFocusRequest }

export interface VacancyTranslationFieldsProps {
  form: AnyForm
  focusRequest?: VacancyTranslationFocusRequest | null | undefined
  /** Dot-path → Russian message, from the last failed submit (HIGH-2). Not TanStack field state — see module doc. */
  submitFieldErrors?: Record<string, string> | null | undefined
  /** Called with a field's dot-path the moment the user edits it, so the parent can drop its now-stale `submitFieldErrors` entry. */
  onFieldEdited?: ((path: string) => void) | undefined
}

/** Empty value is always valid (locale simply isn't being translated) — only non-empty values are checked against the schema's length constraints. */
function validateNonEmpty(
  value: string,
  shape: { safeParse: (v: string) => { success: boolean; error?: { issues: unknown[] } } },
): string | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const result = shape.safeParse(trimmed)
  if (result.success) return undefined
  const issues = result.error?.issues as (Parameters<typeof zodIssueRu>[0] | undefined)[]
  return zodIssueRu(issues?.[0])
}

export function VacancyTranslationFields({
  form,
  focusRequest,
  submitFieldErrors,
  onFieldEdited,
}: VacancyTranslationFieldsProps) {
  const [activeLocale, setActiveLocale] = useState<VacancyTranslationLocale>(
    VACANCY_TRANSLATION_LOCALES[0],
  )

  // Force-switch on an incoming focus request (HIGH-2) — keyed on `nonce` so
  // repeated requests for the SAME locale (e.g. two failed submits in a row
  // both pointing at `uk`) still re-trigger the switch even though `locale`
  // itself didn't change.
  useEffect(() => {
    if (focusRequest) setActiveLocale(focusRequest.locale)
    // Intentionally keyed on `nonce` only (not the whole `focusRequest`
    // object or `.locale`), see comment above.
  }, [focusRequest?.nonce])

  return (
    <div className="space-y-1.5">
      <Label>Переводы (необязательно)</Label>
      <p className="text-xs text-muted-foreground">
        Название и описание вакансии для лендинга на других языках. Без перевода на языке
        показывается оригинал (английский).
      </p>
      <Tabs
        value={activeLocale}
        onValueChange={(v) => setActiveLocale(v as VacancyTranslationLocale)}
      >
        <TabsList
          data-testid="vacancy-translations-tabs"
          className="w-full justify-start overflow-x-auto"
        >
          {VACANCY_TRANSLATION_LOCALES.map((locale) => {
            const hasSubmitError = Boolean(
              submitFieldErrors?.[`translations.${locale}.title`] ??
              submitFieldErrors?.[`translations.${locale}.description`],
            )
            return (
              <form.Subscribe
                key={locale}
                selector={(state: {
                  values: {
                    translations?: Record<string, { title?: string; description?: string }>
                  }
                  fieldMeta?: Partial<Record<string, { errors?: unknown[] }>>
                }) => {
                  const translation = state.values.translations?.[locale]
                  const translated = Boolean(
                    translation?.title?.trim() && translation?.description?.trim(),
                  )
                  const titleErrors =
                    state.fieldMeta?.[`translations.${locale}.title`]?.errors ?? []
                  const descriptionErrors =
                    state.fieldMeta?.[`translations.${locale}.description`]?.errors ?? []
                  const hasLiveError = titleErrors.length > 0 || descriptionErrors.length > 0
                  return { translated, hasLiveError }
                }}
              >
                {(status: { translated: boolean; hasLiveError: boolean }) => {
                  const hasError = status.hasLiveError || hasSubmitError
                  const statusLabel = hasError
                    ? 'ошибка'
                    : status.translated
                      ? 'переведено'
                      : 'не переведено'
                  // design-review round 2 (LOW-1) — shape, not just colour,
                  // carries the status: outline circle / check-circle /
                  // triangle-alert are distinguishable in grayscale.
                  const StatusIcon = hasError
                    ? TriangleAlert
                    : status.translated
                      ? CircleCheck
                      : Circle
                  return (
                    <TabsTrigger
                      value={locale}
                      data-testid={`vacancy-translation-tab-${locale}`}
                      data-has-error={hasError || undefined}
                      className="shrink-0 gap-1.5"
                      aria-label={`${VACANCY_TRANSLATION_LOCALE_LABELS[locale]} — ${statusLabel}`}
                    >
                      <StatusIcon
                        aria-hidden="true"
                        className={cn(
                          'size-3 shrink-0',
                          hasError
                            ? 'text-destructive'
                            : status.translated
                              ? 'text-green-500'
                              : 'text-muted-foreground/40',
                        )}
                      />
                      {locale.toUpperCase()}
                    </TabsTrigger>
                  )
                }}
              </form.Subscribe>
            )
          })}
        </TabsList>

        {VACANCY_TRANSLATION_LOCALES.map((locale: VacancyTranslationLocale) => {
          const titlePath = `translations.${locale}.title`
          const descriptionPath = `translations.${locale}.description`
          return (
            <TabsContent key={locale} value={locale} className="space-y-3">
              <form.Field
                name={titlePath}
                validators={{
                  onBlur: ({ value }: { value: string }) =>
                    validateNonEmpty(value, vacancyTranslationSchema.shape.title),
                }}
              >
                {(field: AnyField) => {
                  const err =
                    (field.state.meta.errors[0] as string | undefined) ??
                    submitFieldErrors?.[titlePath]
                  const errorId = `vacancy-translation-${locale}-title-error`
                  return (
                    <div className="space-y-1.5">
                      <Label className={cn('text-xs', err && 'text-destructive')}>Название</Label>
                      <Input
                        value={field.state.value ?? ''}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                          field.handleChange(e.target.value)
                          onFieldEdited?.(titlePath)
                        }}
                        onBlur={field.handleBlur}
                        placeholder="Senior React Developer"
                        data-testid={`vacancy-translation-${locale}-title`}
                        aria-invalid={err ? true : undefined}
                        aria-describedby={err ? errorId : undefined}
                        className={cn(
                          err && 'border-destructive focus-visible:ring-destructive/30',
                        )}
                      />
                      {err && (
                        <p id={errorId} className="text-xs text-destructive">
                          {err}
                        </p>
                      )}
                    </div>
                  )
                }}
              </form.Field>
              <form.Field
                name={descriptionPath}
                validators={{
                  onBlur: ({ value }: { value: string }) =>
                    validateNonEmpty(value, vacancyTranslationSchema.shape.description),
                }}
              >
                {(field: AnyField) => {
                  const err =
                    (field.state.meta.errors[0] as string | undefined) ??
                    submitFieldErrors?.[descriptionPath]
                  const errorId = `vacancy-translation-${locale}-description-error`
                  return (
                    <div className="space-y-1.5">
                      <Label className={cn('text-xs', err && 'text-destructive')}>
                        Описание (Markdown)
                      </Label>
                      <Textarea
                        value={field.state.value ?? ''}
                        onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => {
                          field.handleChange(e.target.value)
                          onFieldEdited?.(descriptionPath)
                        }}
                        onBlur={field.handleBlur}
                        rows={6}
                        data-testid={`vacancy-translation-${locale}-description`}
                        aria-invalid={err ? true : undefined}
                        aria-describedby={err ? errorId : undefined}
                        className={cn(
                          err && 'border-destructive focus-visible:ring-destructive/30',
                        )}
                      />
                      {err && (
                        <p id={errorId} className="text-xs text-destructive">
                          {err}
                        </p>
                      )}
                    </div>
                  )
                }}
              </form.Field>
            </TabsContent>
          )
        })}
      </Tabs>
    </div>
  )
}
