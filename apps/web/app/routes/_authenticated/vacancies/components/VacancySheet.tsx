/**
 * VacancySheet — task-crm-vacancies-ui §4.2. Right-side Sheet for BOTH
 * creating a new vacancy and editing an existing one from the LIST page's
 * card «Редактировать» button (the DETAIL page's own edit form is a
 * separate INLINE form — spec §4.3 — reusing the same `VacancyFormFields`).
 *
 * ≈448px width — `w-full sm:max-w-md`, the closest existing Tailwind
 * breakpoint to the macet's 452px; same convention as `AttachReceiptSheet`.
 */
import { useEffect, useState } from 'react'
import { useForm, useStore } from '@tanstack/react-form'
import { toast } from 'sonner'
import type { Vacancy, VacancyDomain, VacancyEmploymentType } from '@crm/shared'
import { createVacancySchema, updateVacancySchema } from '@crm/shared'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { useCreateVacancy, useUpdateVacancy } from '@/hooks/use-vacancies'
import { useFormAbandonTracking } from '@/lib/telemetry'
import {
  buildVacancyDto,
  computeVacancySubmitErrors,
  emptySeoFormValues,
  emptyTranslationsFormValues,
  seoFormValuesFromVacancy,
  translationsFormValuesFromVacancy,
  type VacancySeoFormValues,
  type VacancyTranslationFocusRequest,
  type VacancyTranslationsFormValues,
} from '../constants'
import { VacancyFormFields } from './VacancyFormFields'

interface VacancySheetProps {
  /** `null` → create mode. Non-null → edit mode, prefilled from this vacancy. */
  vacancy: Vacancy | null
  open: boolean
  onClose: () => void
}

/**
 * task-vacancies-form-simplify: `seniority`/`location` are deliberately NOT
 * part of this form's values anymore — every position is full-remote SENIOR.
 * Create sends this shape through `createVacancySchema` (`.default()` fills
 * both fields); edit sends it through `updateVacancySchema` (both stay
 * `undefined` → no-op, the existing vacancy's values are left untouched —
 * see that schema's file-header comment for why a naive `.partial()` would
 * be unsafe here).
 *
 * task-vacancy-i18n-jobposting: `translations`/SEO-enrichment fields (C1/C3)
 * ADDED to this form's values — `undefined -> null`-on-omit semantics are
 * NOT relevant here (unlike seniority/location) since `buildTranslationsDto`/
 * `buildSeoFieldsDto` (`../constants`) always resolve to an explicit
 * value-or-null from whatever is currently typed into the fields.
 */
interface VacancyFormValues {
  title: string
  slug: string
  descriptionMd: string
  domain: VacancyDomain
  employmentType: VacancyEmploymentType
  translations: VacancyTranslationsFormValues
  skills: VacancySeoFormValues['skills']
  experienceMonths: VacancySeoFormValues['experienceMonths']
  qualifications: VacancySeoFormValues['qualifications']
  responsibilities: VacancySeoFormValues['responsibilities']
  jobBenefits: VacancySeoFormValues['jobBenefits']
  workHours: VacancySeoFormValues['workHours']
}

function emptyValues(): VacancyFormValues {
  return {
    title: '',
    slug: '',
    descriptionMd: '',
    domain: 'AI',
    employmentType: 'FULL_TIME',
    translations: emptyTranslationsFormValues(),
    ...emptySeoFormValues(),
  }
}

function valuesFromVacancy(vacancy: Vacancy): VacancyFormValues {
  return {
    title: vacancy.title,
    slug: vacancy.slug,
    descriptionMd: vacancy.descriptionMd,
    domain: vacancy.domain,
    employmentType: vacancy.employmentType,
    translations: translationsFormValuesFromVacancy(vacancy),
    ...seoFormValuesFromVacancy(vacancy),
  }
}

export function VacancySheet({ vacancy, open, onClose }: VacancySheetProps) {
  const isEdit = vacancy !== null
  const createMutation = useCreateVacancy()
  const updateMutation = useUpdateVacancy()
  const isPending = createMutation.isPending || updateMutation.isPending
  // Auto-slug only makes sense for a brand-new title; editing an existing
  // vacancy's already-published slug should never silently rewrite it.
  const [slugAutoLinked, setSlugAutoLinked] = useState(!isEdit)
  // design-review round 1 (PR #422, HIGH-2) — see VacancyTranslationFields'
  // module doc: forces the translation Tabs to the locale of the first
  // reported error on a failed submit, so a field error hiding behind a
  // closed tab is never invisible.
  const [translationFocusRequest, setTranslationFocusRequest] =
    useState<VacancyTranslationFocusRequest | null>(null)
  // design-review round 1 (PR #422, HIGH-2) — dot-path → Russian message
  // from the last failed submit. Deliberately NOT stored in TanStack Form's
  // own field state — see `VacancyTranslationFields`'s module doc for why.
  const [submitFieldErrors, setSubmitFieldErrors] = useState<Record<string, string> | null>(null)

  const form = useForm({
    defaultValues: vacancy ? valuesFromVacancy(vacancy) : emptyValues(),
    // design-review round 1 (PR #422, HIGH-2) — blocks `onSubmit` below from
    // running when the dto fails schema validation (replaces the old silent
    // `if (!parsed.success) return`). The ACTUAL error display/toast/tab-
    // switch happens in `onSubmitInvalid` below.
    validators: {
      onSubmit: ({ value }) => {
        const dto = buildVacancyDto(value)
        const schema = isEdit ? updateVacancySchema : createVacancySchema
        return schema.safeParse(dto).success ? null : { form: 'Форма содержит ошибки' }
      },
    },
    // Guaranteed by TanStack Form to run whenever `handleSubmit()` finds the
    // form invalid, regardless of which validator caught it. Sets the plain
    // `submitFieldErrors` state (see `computeVacancySubmitErrors`'s doc in
    // `../constants` for why NOT `formApi.setFieldMeta`), force-switches the
    // tab holding the first error, and fires a fallback toast unconditionally.
    onSubmitInvalid: ({ value }) => {
      const schema = isEdit ? updateVacancySchema : createVacancySchema
      const result = computeVacancySubmitErrors(value, schema)
      setSubmitFieldErrors(result?.fields ?? null)
      if (result?.firstTranslationLocale) {
        setTranslationFocusRequest({ locale: result.firstTranslationLocale, nonce: Date.now() })
      }
      toast.error('Проверьте поля формы — есть ошибки')
    },
    onSubmit: async ({ value }) => {
      const dto = buildVacancyDto(value)

      // isEdit branch validates through `updateVacancySchema` (seniority/
      // location NOT included in `dto` → stay `undefined` → PATCH is a no-op
      // on those two fields, the existing vacancy keeps its own value).
      // create branch validates through `createVacancySchema` (same omission
      // → `.default()` fills seniority: 'SENIOR' / location: 'Remote').
      // `validators.onSubmit` above already gated this call on a successful
      // parse, so `safeParse` here always succeeds — re-run only to get the
      // fully-typed, defaulted `.data` the mutation needs.
      if (isEdit && vacancy) {
        const parsed = updateVacancySchema.safeParse(dto)
        if (!parsed.success) return
        await updateMutation.mutateAsync({ id: vacancy.id, dto: parsed.data })
      } else {
        const parsed = createVacancySchema.safeParse(dto)
        if (!parsed.success) return
        await createMutation.mutateAsync(parsed.data)
      }
      markFormSubmitted()
      onClose()
    },
  })

  // task-telemetry-web: reference wiring for the reusable form_abandon/
  // form_submit hook (spec §3) — opened + dirtied + closed WITHOUT submit →
  // `form_abandon`; opened + dirtied + submitted → `form_submit`. Opening a
  // pristine Sheet and just closing it again fires neither (see
  // `FormAbandonTracker`/PR body table for the full rollout status across
  // other dialogs).
  const isFormDirty = useStore(form.store, (s) => s.isDirty)
  const { markSubmitted: markFormSubmitted } = useFormAbandonTracking('vacancy', {
    open,
    isDirty: isFormDirty,
  })

  // Re-seed the form whenever the target vacancy changes (open a different
  // card's edit Sheet, or switch from edit back to create) — keyed on
  // vacancy?.id only, same convention as AttachReceiptSheet's tx?.id effect.
  useEffect(() => {
    form.reset(vacancy ? valuesFromVacancy(vacancy) : emptyValues())
    setSlugAutoLinked(!vacancy)
    setTranslationFocusRequest(null)
    setSubmitFieldErrors(null)
    // Keyed on vacancy?.id only — re-running on every form/state identity
    // change would clobber in-progress edits (same pattern as AttachReceiptSheet).
  }, [vacancy?.id])

  // design-review round 1 (PR #422, HIGH-2) — drop a field's stale
  // `submitFieldErrors` entry the moment the user edits it again.
  const handleFieldEdited = (path: string) => {
    setSubmitFieldErrors((prev) => {
      if (!prev || !(path in prev)) return prev
      const { [path]: _dropped, ...rest } = prev
      return rest
    })
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose()
      }}
    >
      <SheetContent
        side="right"
        className="w-full sm:max-w-md flex flex-col overflow-hidden"
        data-testid="vacancy-sheet"
        onOpenAutoFocus={(event) => {
          // task-crm-vacancies-ui §9 (focus order): opening the Sheet should
          // move focus to the first field («Название вакансии»). Radix's
          // default autofocus (first tabbable descendant) lands on the [X]
          // close button instead, since it's rendered before the form.
          // Query for the input directly rather than forwarding a ref
          // through `VacancyFormFields` (shared with the detail page's
          // inline edit form, which must NOT steal focus on mount) — keeps
          // the fix scoped to the Sheet (PR #396 fidelity review).
          event.preventDefault()
          const content = event.currentTarget as HTMLElement | null
          content?.querySelector<HTMLInputElement>('input')?.focus()
        }}
      >
        <SheetHeader className="mb-2 shrink-0">
          <SheetTitle>{isEdit ? 'Редактировать вакансию' : 'Создать вакансию'}</SheetTitle>
          <SheetDescription className="sr-only">
            {isEdit ? 'Редактирование вакансии' : 'Создание новой вакансии'}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto">
          <VacancyFormFields
            form={form}
            slugAutoLinked={slugAutoLinked}
            onSlugAutoLinkedChange={setSlugAutoLinked}
            focusRequest={translationFocusRequest}
            submitFieldErrors={submitFieldErrors}
            onFieldEdited={handleFieldEdited}
          />
        </div>

        <SheetFooter className="mt-4 shrink-0">
          <Button
            variant="outline"
            className="h-11 sm:h-9"
            onClick={onClose}
            data-testid="vacancy-sheet-cancel"
          >
            Отмена
          </Button>
          <Button
            className="h-11 sm:h-9 flex-1"
            onClick={() => void form.handleSubmit()}
            disabled={isPending}
            data-testid="vacancy-sheet-submit"
            data-track={isEdit ? undefined : 'vacancy-create'}
          >
            {isEdit ? 'Сохранить изменения' : 'Создать вакансию'}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
