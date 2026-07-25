/**
 * VacancyTranslationFields — task-vacancy-i18n-jobposting C1. Optional
 * per-locale (uk/ru/es/pt) title + description overrides for a vacancy,
 * shown as tabs (owner scope-change 2026-07-25: "пять языковых секций
 * подряд сделают форму нечитаемой — используй табы/аккордеон по локали с
 * индикатором «переведено/нет»"). Shared by `VacancySheet` (create/edit) and
 * `$vacancyId.tsx` (inline edit) — same pattern as `VacancyFormFields`.
 *
 * A locale counts as "переведено" (badge) only when BOTH title AND
 * description are non-empty — matches `vacancyTranslationSchema`'s
 * requirement that a locale entry is all-or-nothing; a half-filled tab is
 * simply not sent as a translation (see `VacancySheet`/`$vacancyId.tsx`
 * `buildTranslationsDto` — filters on this exact condition).
 *
 * design-gate: Tier 2 candidate (new UI structure — tabs + per-locale
 * fields) built with EXISTING shadcn/ui primitives (Tabs/Input/Textarea/
 * Badge, no new visual language) — flagging for PM/ui-ux-designer Mode B
 * fidelity pass per plan §5 "Дизайн-гейт: переключатель языка + любые
 * UI-изменения → ui-ux-designer Mode B".
 */
import type { VacancyTranslationLocale } from '@crm/shared'
import { VACANCY_TRANSLATION_LOCALES } from '@crm/shared'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { VACANCY_TRANSLATION_LOCALE_LABELS } from '../constants'
import type { AnyField, AnyForm } from './VacancyFormFields'

export interface VacancyTranslationFieldsProps {
  form: AnyForm
}

export function VacancyTranslationFields({ form }: VacancyTranslationFieldsProps) {
  return (
    <div className="space-y-1.5">
      <Label>Переводы (необязательно)</Label>
      <p className="text-xs text-muted-foreground">
        Название и описание вакансии для лендинга на других языках. Без перевода на языке
        показывается оригинал (английский).
      </p>
      <Tabs defaultValue={VACANCY_TRANSLATION_LOCALES[0]}>
        <TabsList data-testid="vacancy-translations-tabs">
          {VACANCY_TRANSLATION_LOCALES.map((locale) => (
            <form.Subscribe
              key={locale}
              selector={(state: {
                values: { translations?: Record<string, { title?: string; description?: string }> }
              }) => state.values.translations?.[locale]}
            >
              {(translation: { title?: string; description?: string } | undefined) => {
                const translated = Boolean(
                  translation?.title?.trim() && translation?.description?.trim(),
                )
                return (
                  <TabsTrigger
                    value={locale}
                    data-testid={`vacancy-translation-tab-${locale}`}
                    className="gap-1.5"
                  >
                    {VACANCY_TRANSLATION_LOCALE_LABELS[locale]}
                    <Badge
                      variant={translated ? 'status-active' : 'secondary'}
                      className="px-1.5 py-0 text-[10px]"
                    >
                      {translated ? 'переведено' : 'нет'}
                    </Badge>
                  </TabsTrigger>
                )
              }}
            </form.Subscribe>
          ))}
        </TabsList>

        {VACANCY_TRANSLATION_LOCALES.map((locale: VacancyTranslationLocale) => (
          <TabsContent key={locale} value={locale} className="space-y-3">
            <form.Field name={`translations.${locale}.title`}>
              {(field: AnyField) => (
                <div className="space-y-1.5">
                  <Label className="text-xs">Название</Label>
                  <Input
                    value={field.state.value ?? ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      field.handleChange(e.target.value)
                    }
                    onBlur={field.handleBlur}
                    placeholder="Senior React Developer"
                    data-testid={`vacancy-translation-${locale}-title`}
                  />
                </div>
              )}
            </form.Field>
            <form.Field name={`translations.${locale}.description`}>
              {(field: AnyField) => (
                <div className="space-y-1.5">
                  <Label className="text-xs">Описание (Markdown)</Label>
                  <Textarea
                    value={field.state.value ?? ''}
                    onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                      field.handleChange(e.target.value)
                    }
                    onBlur={field.handleBlur}
                    rows={6}
                    data-testid={`vacancy-translation-${locale}-description`}
                  />
                </div>
              )}
            </form.Field>
          </TabsContent>
        ))}
      </Tabs>
    </div>
  )
}
