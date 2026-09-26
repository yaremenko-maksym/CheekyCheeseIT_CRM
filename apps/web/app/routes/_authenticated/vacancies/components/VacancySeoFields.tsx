/**
 * VacancySeoFields — task-vacancy-i18n-jobposting C3. Optional Google-for-Jobs
 * (JobPosting) enrichment fields: skills, required experience, qualifications,
 * responsibilities, benefits, work hours. All optional/admin-entered — never
 * invented (see `packages/shared` `vacancySeoFieldsSchema` doc); the two
 * remaining JobPosting fields from C3 (`industry`, `occupationalCategory`)
 * are computed at the `apps/landing` seo.ts JSON-LD-builder layer instead
 * (derived from `domain` / a business-wide constant) and are therefore NOT
 * form fields at all.
 *
 * Shared by `VacancySheet` (create/edit) and `$vacancyId.tsx` (inline edit) —
 * same pattern as `VacancyFormFields`.
 */
import { Trans, useLingui } from '@lingui/react/macro'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import type { AnyField, AnyForm } from './VacancyFormFields'

export interface VacancySeoFieldsProps {
  form: AnyForm
}

export function VacancySeoFields({ form }: VacancySeoFieldsProps) {
  const { t } = useLingui()
  return (
    <div className="space-y-3">
      <Label>
        <Trans>Google for Jobs (необов’язково)</Trans>
      </Label>
      <p className="text-xs text-muted-foreground">
        <Trans>Додаткові поля для повнішої розмітки вакансії в пошуку Google.</Trans>
      </p>

      <form.Field name="skills">
        {(field: AnyField) => (
          <div className="space-y-1.5">
            <Label className="text-xs">
              <Trans>Навички (через кому)</Trans>
            </Label>
            <Input
              value={field.state.value ?? ''}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                field.handleChange(e.target.value)
              }
              onBlur={field.handleBlur}
              placeholder="TypeScript, React, Node.js"
              data-testid="vacancy-form-skills"
            />
          </div>
        )}
      </form.Field>

      <form.Field name="experienceMonths">
        {(field: AnyField) => (
          <div className="space-y-1.5">
            <Label className="text-xs">
              <Trans>Необхідний досвід (місяців)</Trans>
            </Label>
            <Input
              type="number"
              inputMode="numeric"
              min={0}
              max={600}
              value={field.state.value ?? ''}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                field.handleChange(e.target.value)
              }
              onBlur={field.handleBlur}
              placeholder="36"
              data-testid="vacancy-form-experience-months"
            />
          </div>
        )}
      </form.Field>

      <form.Field name="qualifications">
        {(field: AnyField) => (
          <div className="space-y-1.5">
            <Label className="text-xs">
              <Trans>Кваліфікація</Trans>
            </Label>
            <Textarea
              value={field.state.value ?? ''}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                field.handleChange(e.target.value)
              }
              onBlur={field.handleBlur}
              rows={3}
              data-testid="vacancy-form-qualifications"
            />
          </div>
        )}
      </form.Field>

      <form.Field name="responsibilities">
        {(field: AnyField) => (
          <div className="space-y-1.5">
            <Label className="text-xs">
              <Trans>Обов’язки</Trans>
            </Label>
            <Textarea
              value={field.state.value ?? ''}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                field.handleChange(e.target.value)
              }
              onBlur={field.handleBlur}
              rows={3}
              data-testid="vacancy-form-responsibilities"
            />
          </div>
        )}
      </form.Field>

      <form.Field name="jobBenefits">
        {(field: AnyField) => (
          <div className="space-y-1.5">
            <Label className="text-xs">
              <Trans>Бенефіти</Trans>
            </Label>
            <Textarea
              value={field.state.value ?? ''}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                field.handleChange(e.target.value)
              }
              onBlur={field.handleBlur}
              rows={2}
              data-testid="vacancy-form-job-benefits"
            />
          </div>
        )}
      </form.Field>

      <form.Field name="workHours">
        {(field: AnyField) => (
          <div className="space-y-1.5">
            <Label className="text-xs">
              <Trans>Робочі години</Trans>
            </Label>
            <Input
              value={field.state.value ?? ''}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                field.handleChange(e.target.value)
              }
              onBlur={field.handleBlur}
              placeholder={t`40 годин на тиждень`}
              data-testid="vacancy-form-work-hours"
            />
          </div>
        )}
      </form.Field>
    </div>
  )
}
