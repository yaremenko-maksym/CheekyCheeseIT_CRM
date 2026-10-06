import { useLayoutEffect, useRef } from 'react'
import { useForm } from '@tanstack/react-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Trans, useLingui } from '@lingui/react/macro'
import type { ProjectDto, ProjectDetailDto, UpdateProjectDto } from '@crm/shared'
import { IT_DOMAINS, type ItDomain } from '@crm/shared'
import { api } from '@/lib/axios'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  CrmDialogContent,
  CrmDialogHeader,
  CrmDialogBody,
  CrmDialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/crm-dialog'
import { ProjectEditFields } from './ProjectEditFields'

/**
 * Defensive coercion: if a project row has a `domain` value that is not
 * a member of the current `IT_DOMAINS` enum (legacy seed data, or
 * external/manual writes that bypass the API validator), fall back to
 * `'Other'`. This prevents the edit dialog from silently submitting the
 * stale value and hitting a 400 «Invalid option: domain» from
 * `updateProjectSchema.parse(...)` on the server.
 *
 * The DB-level fix is migration 0012, which rewrites legacy literals
 * in-place; this is the runtime safety net for any future drift.
 */
function coerceDomain(value: string | null | undefined): ItDomain {
  return (IT_DOMAINS as readonly string[]).includes(value ?? '') ? (value as ItDomain) : 'Other'
}

interface ProjectEditDialogProps {
  project: ProjectDetailDto
  projectId: string
  viewerRole: string | undefined
  canOpenEdit: boolean
  canEditOverride: boolean
  open: boolean
  onClose: () => void
}

/**
 * Project edit dialog, moved verbatim from `$projectId.tsx`. Owns `editForm` +
 * `editMutation`. The page keeps the `open` state and the permission flags
 * (`useProjectPermissions`); this component only consumes them.
 *
 * SECURITY: the field-scoped RBAC in `onSubmit` (financial fields are sent only
 * when `canEditOverride`) is unchanged from the page — the backend remains the
 * real enforcement.
 *
 * The former imperative `openEdit()` reset of the 16 fields is reproduced as a
 * reset-on-open (keyed on `open` only, NOT on `project`: a background refetch
 * while the dialog is open must not clobber the user's in-progress edits, same
 * as before). The reset runs in a layout effect (before paint, and before the
 * dialog content mounts since Radix Portal defers it), so locally-initialised
 * children (e.g. ImageUploadField) see the fresh values and there is no flash of
 * stale values. NOTE: this ordering is not currently guarded by a test — swapping
 * `useLayoutEffect` for `useEffect` leaves the suite green.
 */
export function ProjectEditDialog({
  project,
  projectId,
  viewerRole,
  canOpenEdit,
  canEditOverride,
  open,
  onClose,
}: ProjectEditDialogProps) {
  const { t } = useLingui()
  const qc = useQueryClient()

  const editForm = useForm({
    defaultValues: {
      name: project.name ?? '',
      companyName: project.companyName ?? '',
      domain: coerceDomain(project.domain),
      logoDocumentId: project.logoDocumentId ?? (null as string | null),
      logoExternalUrl: project.logoExternalUrl ?? (null as string | null),
      rate: (project.rate ?? '') as unknown as number,
      currency: (project.currency ?? 'USDT') as 'USDT' | 'USD' | 'EUR' | 'UAH',
      seniorSharePercentOverride: project.seniorSharePercentOverride ?? null,
      // task-drop-share-override-and-receiver (Surface A). Same null-default
      // convention as seniorSharePercentOverride above.
      dropSharePercentOverride: project.dropSharePercentOverride ?? null,
      techStack: project.techStack ?? '',
      teamSize: project.teamSize ?? '',
      benefits: project.benefits ?? '',
      // task-drop-share-override-and-receiver (Surface C). paymentType is now a
      // 3-value enum Select — default to the backend's own default ('FOP') so a
      // legacy/never-set project still shows a valid, disabled-for-non-editors
      // selection instead of an empty Select.
      paymentType: project.paymentType ?? 'FOP',
      salaryReview: project.salaryReview ?? '',
      corpTech: project.corpTech ?? '',
      notesGeneral: project.notesGeneral ?? '',
    },
    onSubmit: async ({ value }) => {
      // Round-3 (PR #39 round 2): ShareSlider всегда виден (для не-HR), нет
      // toggle/Сбросить. Implicit reset: если слайдер === default — фронт всё
      // равно шлёт значение, а backend пишет null. Поэтому передаём поле
      // когда оно НА САМОМ ДЕЛЕ изменилось vs. серверный snapshot AND
      // пользователь может его редактировать. HR/SENIOR/JUNIOR ничего не
      // отправляют (canEditOverride=false).
      const overrideChanged =
        canEditOverride &&
        // Stryker disable next-line OptionalChaining: `project` is a required prop and never undefined here (the page renders this component only once the project has loaded), so `project?.` and `project.` are indistinguishable
        (value.seniorSharePercentOverride ?? null) !== (project?.seniorSharePercentOverride ?? null)
      // task-drop-share-override-and-receiver (Surface A). Same "only send when
      // actually changed AND caller is allowed to edit" convention as senior.
      const dropOverrideChanged =
        canEditOverride &&
        // Stryker disable next-line OptionalChaining: `project` is a required prop and never undefined here (the page renders this component only once the project has loaded), so `project?.` and `project.` are indistinguishable
        (value.dropSharePercentOverride ?? null) !== (project?.dropSharePercentOverride ?? null)
      editMutation.mutate({
        name: value.name.trim() || undefined,
        companyName: value.companyName.trim() || undefined,
        domain: value.domain || undefined,
        logoDocumentId: value.logoDocumentId ?? null,
        logoExternalUrl: value.logoExternalUrl ?? null,
        rate: Number(value.rate) || undefined,
        currency: value.currency || undefined,
        ...(overrideChanged
          ? { seniorSharePercentOverride: value.seniorSharePercentOverride ?? null }
          : {}),
        ...(dropOverrideChanged
          ? { dropSharePercentOverride: value.dropSharePercentOverride ?? null }
          : {}),
        techStack: value.techStack.trim() || null,
        teamSize: value.teamSize.trim() || null,
        benefits: value.benefits.trim() || null,
        // task-drop-share-override-and-receiver (Surface C). Field-scoped RBAC —
        // backend throws ForbiddenException for non-ADMIN/ACCOUNTANT if this key
        // is present AT ALL (even unchanged/null), mirroring
        // seniorSharePercentOverride/dropSharePercentOverride above. Only ADMIN/
        // ACCOUNTANT (canEditOverride) ever include it; HR's disabled Select
        // never reaches the wire.
        ...(canEditOverride ? { paymentType: value.paymentType } : {}),
        salaryReview: value.salaryReview.trim() || null,
        corpTech: value.corpTech.trim() || null,
        notesGeneral: value.notesGeneral.trim() || null,
      })
    },
  })

  const editMutation = useMutation({
    mutationFn: (data: UpdateProjectDto) =>
      // Stryker disable next-line ArrowFunction: the mutation result is never read (onSuccess ignores it), so what `.then` maps the response to is unobservable
      api.patch<ProjectDto>(`/projects/${projectId}`, data).then((r) => r.data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['projects'] })
      onClose()
    },
  })

  // Reset-on-open: replaces the page's imperative `openEdit()` field reset.
  // Reads the LATEST project through a ref so the effect keys on `open` only.
  const projectRef = useRef(project)
  projectRef.current = project
  useLayoutEffect(() => {
    if (!open) return
    const current = projectRef.current
    editForm.setFieldValue('name', current.name)
    editForm.setFieldValue('companyName', current.companyName)
    editForm.setFieldValue('domain', coerceDomain(current.domain))
    editForm.setFieldValue('logoDocumentId', current.logoDocumentId ?? null)
    editForm.setFieldValue('logoExternalUrl', current.logoExternalUrl ?? null)
    editForm.setFieldValue('rate', current.rate as unknown as number)
    editForm.setFieldValue('currency', current.currency as 'USDT' | 'USD' | 'EUR' | 'UAH')
    editForm.setFieldValue('seniorSharePercentOverride', current.seniorSharePercentOverride ?? null)
    editForm.setFieldValue('dropSharePercentOverride', current.dropSharePercentOverride ?? null)
    editForm.setFieldValue('techStack', current.techStack ?? '')
    editForm.setFieldValue('teamSize', current.teamSize ?? '')
    editForm.setFieldValue('benefits', current.benefits ?? '')
    editForm.setFieldValue('paymentType', current.paymentType ?? 'FOP')
    editForm.setFieldValue('salaryReview', current.salaryReview ?? '')
    editForm.setFieldValue('corpTech', current.corpTech ?? '')
    editForm.setFieldValue('notesGeneral', current.notesGeneral ?? '')
    // Deliberately keyed on `open` only (see doc comment above the component).
  }, [open])

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <CrmDialogContent maxWidth="max-w-lg">
        <CrmDialogHeader>
          <DialogTitle>
            <Trans>Редагувати — {project.companyName}</Trans>
          </DialogTitle>
          <DialogDescription className="sr-only">
            <Trans>
              Редагування параметрів проєкту: ставка, валюта, домен і налаштування частки.
            </Trans>
          </DialogDescription>
        </CrmDialogHeader>

        <CrmDialogBody>
          <div className="space-y-5">
            {canOpenEdit && open && (
              <ProjectEditFields
                form={editForm}
                mode="info"
                canEditOverride={canEditOverride}
                defaultSharePercent={project.seniorSharePercentDefault}
                defaultDropSharePercent={project.dropSharePercentDefault ?? 5}
                dropId={project.dropId}
                viewerRole={viewerRole}
                projectId={projectId}
                pendingShare={project.pendingSeniorShare}
              />
            )}
          </div>
        </CrmDialogBody>
        {canOpenEdit && (
          <CrmDialogFooter>
            <Button variant="outline" onClick={() => onClose()}>
              <Trans>Скасувати</Trans>
            </Button>
            <Button onClick={() => void editForm.handleSubmit()} disabled={editMutation.isPending}>
              {editMutation.isPending ? t`Збереження…` : t`Зберегти`}
            </Button>
          </CrmDialogFooter>
        )}
      </CrmDialogContent>
    </Dialog>
  )
}
