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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import type { AnyField, AnyForm } from './VacancyFormFields'

export interface VacancySeoFieldsProps {
  form: AnyForm
}

export function VacancySeoFields({ form }: VacancySeoFieldsProps) {
  return (
    <div className="space-y-3">
      <Label>Google for Jobs (необязательно)</Label>
      <p className="text-xs text-muted-foreground">
        Дополнительные поля для более полной разметки вакансии в поиске Google.
      </p>

      <form.Field name="skills">
        {(field: AnyField) => (
          <div className="space-y-1.5">
            <Label className="text-xs">Навыки (через запятую)</Label>
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
            <Label className="text-xs">Требуемый опыт (месяцев)</Label>
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
            <Label className="text-xs">Квалификация</Label>
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
            <Label className="text-xs">Обязанности</Label>
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
            <Label className="text-xs">Бенефиты</Label>
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
            <Label className="text-xs">Рабочие часы</Label>
            <Input
              value={field.state.value ?? ''}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                field.handleChange(e.target.value)
              }
              onBlur={field.handleBlur}
              placeholder="40 часов в неделю"
              data-testid="vacancy-form-work-hours"
            />
          </div>
        )}
      </form.Field>
    </div>
  )
}
