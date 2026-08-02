/**
 * VacancyFormFields — the create/update field set (spec §4.2), shared by
 * both the list-page Sheet (`VacancySheet`, create AND edit-from-list) and
 * the detail-page inline edit form (`$vacancyId.tsx` — spec §4.3 explicitly
 * wants an INLINE form there, not a Sheet, but with the SAME fields). A
 * single presentational component avoids re-implementing the same 5
 * TanStack Form fields twice (golden rule #8 — no duplicated logic).
 *
 * task-vacancies-form-simplify: «Уровень» (seniority) and «Локация»
 * (location) controls were REMOVED — every position is a full-remote SENIOR
 * role. Both fields still exist on `Vacancy`/`createVacancySchema` (now
 * `.default('SENIOR'/'Remote')`) so existing non-default rows (e.g. a LEAD
 * vacancy created before this change) keep displaying correctly everywhere
 * else (VacancyCard badges, detail-page header) — this component just no
 * longer lets a user set them.
 *
 * `form`/`field` are typed `AnyForm`/`AnyField` (all-`any` generics) —
 * follows the exact pattern already used in this codebase to pass a
 * `useForm()` instance across a component boundary, see
 * `apps/web/app/routes/_authenticated/projects/$projectId.tsx`
 * (`ProjectEditFields`, exported `AnyForm`/`AnyField`).
 */
import type { FieldApi, ReactFormExtendedApi } from '@tanstack/react-form'
import { createVacancySchema } from '@crm/shared'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ContractEditor } from '@/components/user-profile/contract/ContractEditor'
import { DOMAIN_LABELS, EMPLOYMENT_TYPE_LABELS, slugifyTitle, zodIssueRu } from '../constants'
import { VacancySalaryFields } from './VacancySalaryFields'
import { VacancySeoFields } from './VacancySeoFields'
import {
  VacancyTranslationFields,
  type VacancyTranslationFocusRequest,
} from './VacancyTranslationFields'

// TanStack Form field/form render props require many generics — same
// suppress-locally convention as ProjectEditFields.
/* eslint-disable @typescript-eslint/no-explicit-any */
export type AnyField = FieldApi<
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any
>
export type AnyForm = ReactFormExtendedApi<
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any
>
/* eslint-enable @typescript-eslint/no-explicit-any */

const DOMAIN_OPTIONS = ['AI', 'EDTECH', 'ECOMMERCE', 'OTHER'] as const
const EMPLOYMENT_TYPE_OPTIONS = ['FULL_TIME', 'PART_TIME', 'CONTRACT'] as const

export interface VacancyFormFieldsProps {
  form: AnyForm
  /** Slug regenerates from title while true; user editing the slug directly flips it off. */
  slugAutoLinked: boolean
  onSlugAutoLinkedChange: (linked: boolean) => void
  /** Bumped by the parent when submit validation found an error inside a translation tab, to force that tab open. */
  focusRequest?: VacancyTranslationFocusRequest | null
  /** Dot-path → Russian message, from the last failed submit (HIGH-2) — forwarded to `VacancyTranslationFields`. */
  submitFieldErrors?: Record<string, string> | null
  /** Forwarded to `VacancyTranslationFields` — see that component's doc. */
  onFieldEdited?: (path: string) => void
}

export function VacancyFormFields({
  form,
  slugAutoLinked,
  onSlugAutoLinkedChange,
  focusRequest,
  submitFieldErrors,
  onFieldEdited,
}: VacancyFormFieldsProps) {
  return (
    <div className="space-y-4">
      <form.Field
        name="title"
        validators={{
          onBlur: ({ value }: { value: string }) => {
            const r = createVacancySchema.shape.title.safeParse(value.trim())
            return r.success ? undefined : zodIssueRu(r.error.issues[0])
          },
        }}
      >
        {(field: AnyField) => {
          const err = field.state.meta.isTouched ? field.state.meta.errors[0] : undefined
          return (
            <div className="space-y-1.5">
              <Label className={cn(err && 'text-destructive')}>Название вакансии</Label>
              <Input
                value={field.state.value}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                  const next = e.target.value
                  field.handleChange(next)
                  if (slugAutoLinked) {
                    form.setFieldValue('slug', slugifyTitle(next))
                  }
                }}
                onBlur={field.handleBlur}
                placeholder="Senior React Developer"
                data-testid="vacancy-form-title"
                className={cn(err && 'border-destructive focus-visible:ring-destructive/30')}
              />
              {err && <p className="text-xs text-destructive">{err}</p>}
            </div>
          )
        }}
      </form.Field>

      <form.Field
        name="slug"
        validators={{
          onBlur: ({ value }: { value: string }) => {
            const r = createVacancySchema.shape.slug.safeParse(value.trim())
            return r.success
              ? undefined
              : zodIssueRu(r.error.issues[0], 'Строчные латинские буквы, цифры и дефис')
          },
        }}
      >
        {(field: AnyField) => {
          const err = field.state.meta.isTouched ? field.state.meta.errors[0] : undefined
          const canAutoSlug = slugifyTitle(String(form.state.values.title ?? '')) !== ''
          return (
            <div className="space-y-1.5">
              <Label className={cn(err && 'text-destructive')}>URL-слаг</Label>
              <div
                className={cn(
                  'flex items-center rounded-md border border-input bg-transparent text-sm shadow-sm ring-offset-background focus-within:ring-1 focus-within:ring-ring',
                  err && 'border-destructive',
                )}
              >
                <span className="pl-3 font-mono text-muted-foreground select-none">/careers/</span>
                <input
                  value={field.state.value}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                    onSlugAutoLinkedChange(false)
                    field.handleChange(e.target.value)
                  }}
                  onBlur={field.handleBlur}
                  placeholder="senior-react-developer"
                  data-testid="vacancy-form-slug"
                  className="h-9 w-full bg-transparent px-1 py-2 font-mono outline-none placeholder:text-muted-foreground"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {canAutoSlug
                  ? 'Генерируется автоматически из названия. Можно редактировать.'
                  : 'Придумайте короткий URL-адрес (латиница, цифры, дефис).'}
              </p>
              {err && <p className="text-xs text-destructive">{err}</p>}
            </div>
          )
        }}
      </form.Field>

      <div className="grid grid-cols-2 gap-[14px]">
        <form.Field name="domain">
          {(field: AnyField) => (
            <div className="space-y-1.5">
              <Label>Домен</Label>
              <Select value={field.state.value} onValueChange={(v) => field.handleChange(v)}>
                <SelectTrigger data-testid="vacancy-form-domain">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DOMAIN_OPTIONS.map((d) => (
                    <SelectItem key={d} value={d}>
                      {DOMAIN_LABELS[d]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </form.Field>

        <form.Field name="employmentType">
          {(field: AnyField) => (
            <div className="space-y-1.5">
              <Label>Тип занятости</Label>
              <Select value={field.state.value} onValueChange={(v) => field.handleChange(v)}>
                <SelectTrigger data-testid="vacancy-form-employment-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EMPLOYMENT_TYPE_OPTIONS.map((t) => (
                    <SelectItem key={t} value={t}>
                      {EMPLOYMENT_TYPE_LABELS[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </form.Field>
      </div>

      <VacancySalaryFields form={form} />

      <form.Field
        name="descriptionMd"
        validators={{
          onBlur: ({ value }: { value: string }) => {
            const r = createVacancySchema.shape.descriptionMd.safeParse(value)
            return r.success ? undefined : zodIssueRu(r.error.issues[0])
          },
        }}
      >
        {(field: AnyField) => {
          const err = field.state.meta.isTouched ? field.state.meta.errors[0] : undefined
          return (
            <div className="space-y-1.5">
              <Label className={cn(err && 'text-destructive')}>Описание (Markdown)</Label>
              {/* §4.2: default 480px height is fine both narrow (Sheet) and wide
                  (detail-page inline) — spec explicitly says not to fight it. */}
              <ContractEditor
                value={field.state.value}
                onChange={(v) => field.handleChange(v)}
                readOnly={false}
              />
              {err && <p className="text-xs text-destructive">{err}</p>}
            </div>
          )
        }}
      </form.Field>

      <VacancyTranslationFields
        form={form}
        focusRequest={focusRequest}
        submitFieldErrors={submitFieldErrors}
        onFieldEdited={onFieldEdited}
      />
      <VacancySeoFields form={form} />
    </div>
  )
}
