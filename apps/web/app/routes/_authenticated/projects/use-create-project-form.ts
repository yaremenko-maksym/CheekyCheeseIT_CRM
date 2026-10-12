import { useForm } from '@tanstack/react-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { CreateProjectDto, ProjectDto, ItDomain } from '@crm/shared'
import { api } from '@/lib/axios'

/**
 * Create-project mutation + TanStack form for the projects list page. Hook order
 * (useQueryClient -> useMutation -> useForm) is unchanged from the page.
 */
export function useCreateProjectForm({
  canEditPaymentType,
  setShowCreate,
}: {
  canEditPaymentType: boolean
  setShowCreate: (open: boolean) => void
}) {
  const queryClient = useQueryClient()

  const createMutation = useMutation({
    mutationFn: (data: CreateProjectDto) => api.post<ProjectDto>('/projects', data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['projects'] })
      setShowCreate(false)
      createForm.reset()
    },
  })

  const createForm = useForm({
    defaultValues: {
      name: '',
      companyName: '',
      domain: 'Other' as ItDomain,
      logoDocumentId: null as string | null,
      logoExternalUrl: null as string | null,
      seniorId: '',
      // Drop role - phase 2. Empty string = «не выбран» (regular senior-project).
      // Non-empty uuid string = drop-project routed through the selected DROP user.
      dropId: '',
      rate: '' as unknown as number,
      currency: 'USDT' as 'USDT' | 'USD' | 'EUR' | 'UAH',
      startDate: new Date().toISOString().slice(0, 10),
      techStack: '',
      teamSize: '',
      benefits: '',
      // task-drop-share-override-and-receiver (Surface C). Default to the
      // backend's own default ('FOP') — matches the enum Select's initial
      // selection (mirrors $projectId.tsx edit-form convention).
      paymentType: 'FOP',
      salaryReview: '',
      corpTech: '',
      notesGeneral: '',
    },
    onSubmit: async ({ value }) => {
      // Drop role - phase 2. Only include `dropId` when the user picked one.
      // Empty string → regression: regular senior-project, body matches pre-
      // phase-2 shape exactly (no `dropId` key).
      const trimmedDropId = value.dropId.trim()
      createMutation.mutate({
        name: value.name.trim(),
        companyName: value.companyName.trim(),
        domain: value.domain,
        logoDocumentId: value.logoDocumentId,
        logoExternalUrl: value.logoExternalUrl,
        seniorId: value.seniorId,
        ...(trimmedDropId ? { dropId: trimmedDropId } : {}),
        rate: Number(value.rate),
        currency: value.currency,
        startDate: new Date(value.startDate).toISOString(),
        techStack: value.techStack.trim() || null,
        teamSize: value.teamSize.trim() || null,
        benefits: value.benefits.trim() || null,
        // task-drop-share-override-and-receiver (Surface C). Field-scoped RBAC —
        // backend throws ForbiddenException for non-ADMIN/ACCOUNTANT if this key
        // is present at all. HR (who CAN reach this create form via `canCreate`)
        // never sends it — the Select stays disabled at the backend default.
        ...(canEditPaymentType ? { paymentType: value.paymentType } : {}),
        salaryReview: value.salaryReview.trim() || null,
        corpTech: value.corpTech.trim() || null,
        notesGeneral: value.notesGeneral.trim() || null,
      })
    },
  })

  return { createForm, createMutation }
}
