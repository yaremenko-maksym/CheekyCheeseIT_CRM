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
import { useForm } from '@tanstack/react-form'
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
 */
interface VacancyFormValues {
  title: string
  slug: string
  descriptionMd: string
  domain: VacancyDomain
  employmentType: VacancyEmploymentType
}

function emptyValues(): VacancyFormValues {
  return {
    title: '',
    slug: '',
    descriptionMd: '',
    domain: 'AI',
    employmentType: 'FULL_TIME',
  }
}

function valuesFromVacancy(vacancy: Vacancy): VacancyFormValues {
  return {
    title: vacancy.title,
    slug: vacancy.slug,
    descriptionMd: vacancy.descriptionMd,
    domain: vacancy.domain,
    employmentType: vacancy.employmentType,
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

  const form = useForm({
    defaultValues: vacancy ? valuesFromVacancy(vacancy) : emptyValues(),
    onSubmit: async ({ value }) => {
      const dto = {
        title: value.title.trim(),
        slug: value.slug.trim(),
        descriptionMd: value.descriptionMd,
        domain: value.domain,
        employmentType: value.employmentType,
      }

      // isEdit branch validates through `updateVacancySchema` (seniority/
      // location NOT included in `dto` → stay `undefined` → PATCH is a no-op
      // on those two fields, the existing vacancy keeps its own value).
      // create branch validates through `createVacancySchema` (same omission
      // → `.default()` fills seniority: 'SENIOR' / location: 'Remote').
      if (isEdit && vacancy) {
        const parsed = updateVacancySchema.safeParse(dto)
        if (!parsed.success) return
        await updateMutation.mutateAsync({ id: vacancy.id, dto: parsed.data })
      } else {
        const parsed = createVacancySchema.safeParse(dto)
        if (!parsed.success) return
        await createMutation.mutateAsync(parsed.data)
      }
      onClose()
    },
  })

  // Re-seed the form whenever the target vacancy changes (open a different
  // card's edit Sheet, or switch from edit back to create) — keyed on
  // vacancy?.id only, same convention as AttachReceiptSheet's tx?.id effect.
  useEffect(() => {
    form.reset(vacancy ? valuesFromVacancy(vacancy) : emptyValues())
    setSlugAutoLinked(!vacancy)
    // Keyed on vacancy?.id only — re-running on every form/state identity
    // change would clobber in-progress edits (same pattern as AttachReceiptSheet).
  }, [vacancy?.id])

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
          >
            {isEdit ? 'Сохранить изменения' : 'Создать вакансию'}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
