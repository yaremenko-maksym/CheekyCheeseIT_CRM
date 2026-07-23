/**
 * VacancyFormFields — the create/update field set (spec §4.2), shared by
 * both the list-page Sheet (`VacancySheet`, create AND edit-from-list) and
 * the detail-page inline edit form (`$vacancyId.tsx` — spec §4.3 explicitly
 * wants an INLINE form there, not a Sheet, but with the SAME fields). A
 * single presentational component avoids re-implementing the same 7
 * TanStack Form fields twice (golden rule #8 — no duplicated logic).
 *
 * `form`/`field` are typed `AnyForm`/`AnyField` (all-`any` generics) —
 * follows the exact pattern already used in this codebase to pass a
 * `useForm()` instance across a component boundary, see
 * `apps/web/app/routes/_authenticated/projects/$projectId.tsx`
 * (`ProjectEditFields`, exported `AnyForm`/`AnyField`).
 */
import type { FieldApi, ReactFormExtendedApi } from '@tanstack/react-form'
import type { z } from 'zod'
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
import { DOMAIN_LABELS, EMPLOYMENT_TYPE_LABELS, SENIORITY_LABELS, slugifyTitle } from '../constants'

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

// Zod's default `.message` is raw English ("Invalid string: must match
// pattern /^[a-z0-9]+.../", "Too small: expected string to have >=10
// characters") — leaking that straight into the UI violates the project's
// hard "always Russian UI" rule (rules/common/russian-language.md). Map the
// small set of issue codes these 4 fields can actually produce (regex/min/
// max on plain strings) to Russian text instead of relying on the schema's
// message. `patternMsg` lets the slug field give a field-specific hint
// ("латиница/цифры/дефис") instead of a generic "неверный формат".
function zodIssueRu(issue: z.core.$ZodIssue | undefined, patternMsg?: string): string | undefined {
  if (!issue) return undefined
  if (issue.code === 'too_small' && 'minimum' in issue) return `Минимум ${issue.minimum} символов`
  if (issue.code === 'too_big' && 'maximum' in issue) return `Максимум ${issue.maximum} символов`
  if (issue.code === 'invalid_format') return patternMsg ?? 'Недопустимый формат'
  return 'Недопустимое значение'
}

const DOMAIN_OPTIONS = ['AI', 'EDTECH', 'ECOMMERCE', 'OTHER'] as const
const SENIORITY_OPTIONS = ['SENIOR', 'LEAD'] as const
const EMPLOYMENT_TYPE_OPTIONS = ['FULL_TIME', 'PART_TIME', 'CONTRACT'] as const

export interface VacancyFormFieldsProps {
  form: AnyForm
  /** Slug regenerates from title while true; user editing the slug directly flips it off. */
  slugAutoLinked: boolean
  onSlugAutoLinkedChange: (linked: boolean) => void
}

export function VacancyFormFields({
  form,
  slugAutoLinked,
  onSlugAutoLinkedChange,
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

        <form.Field name="seniority">
          {(field: AnyField) => (
            <div className="space-y-1.5">
              <Label>Уровень</Label>
              <Select value={field.state.value} onValueChange={(v) => field.handleChange(v)}>
                <SelectTrigger data-testid="vacancy-form-seniority">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SENIORITY_OPTIONS.map((s) => (
                    <SelectItem key={s} value={s}>
                      {SENIORITY_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </form.Field>
      </div>

      <div className="grid grid-cols-2 gap-[14px]">
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

        <form.Field
          name="location"
          validators={{
            onBlur: ({ value }: { value: string }) => {
              const r = createVacancySchema.shape.location.safeParse(value.trim())
              return r.success ? undefined : zodIssueRu(r.error.issues[0])
            },
          }}
        >
          {(field: AnyField) => {
            const err = field.state.meta.isTouched ? field.state.meta.errors[0] : undefined
            return (
              <div className="space-y-1.5">
                <Label className={cn(err && 'text-destructive')}>Локация</Label>
                <Input
                  value={field.state.value}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    field.handleChange(e.target.value)
                  }
                  onBlur={field.handleBlur}
                  placeholder="Киев · Удалённо"
                  data-testid="vacancy-form-location"
                  className={cn(err && 'border-destructive focus-visible:ring-destructive/30')}
                />
                {err && <p className="text-xs text-destructive">{err}</p>}
              </div>
            )
          }}
        </form.Field>
      </div>

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
    </div>
  )
}
