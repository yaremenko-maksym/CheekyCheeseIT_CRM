import { useForm } from '@tanstack/react-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import type { CreateInterviewDto, InterviewDto } from '@crm/shared'
import { createInterviewSchema } from '@crm/shared'
import { api } from '@/lib/axios'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  CrmDialogContent,
  CrmDialogHeader,
  CrmDialogBody,
  CrmDialogFooter,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/crm-dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type UserDto = {
  id: string
  displayName: string
}

export function CreateInterviewDialog({
  open,
  onClose,
  seniors,
  defaultSeniorId,
  isSenior,
}: {
  open: boolean
  onClose: () => void
  seniors: UserDto[]
  defaultSeniorId: string
  isSenior: boolean
}) {
  const queryClient = useQueryClient()

  const createMutation = useMutation({
    mutationFn: (data: CreateInterviewDto) =>
      api.post<InterviewDto>('/interviews', data).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['interviews'] })
      form.reset()
      onClose()
    },
  })

  const urlSchema = z.string().url('Введите корректный URL (https://...)').or(z.literal(''))

  const form = useForm({
    defaultValues: {
      seniorId: defaultSeniorId,
      companyName: '',
      vacancyUrl: '',
      callUrl: '',
    },
    onSubmit: async ({ value }) => {
      createMutation.mutate({
        seniorId: value.seniorId,
        companyName: value.companyName.trim(),
        vacancyUrl: value.vacancyUrl || null,
        callUrl: value.callUrl || null,
      })
    },
  })

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose()
      }}
    >
      <CrmDialogContent>
        <CrmDialogHeader>
          <DialogTitle>Новая карточка</DialogTitle>
          <DialogDescription className="sr-only">Новая карточка собеседования</DialogDescription>
        </CrmDialogHeader>
        <CrmDialogBody className="pb-2">
          <div className="flex flex-col gap-4">
            {!isSenior && seniors.length > 0 && (
              <form.Field name="seniorId">
                {(field) => (
                  <div className="space-y-1">
                    <Label>Синьор</Label>
                    <select
                      className="flex h-9 w-full rounded-md border border-border bg-input px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      value={field.state.value}
                      onChange={(e) => field.handleChange(e.target.value)}
                    >
                      {seniors.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.displayName}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </form.Field>
            )}

            <form.Field
              name="companyName"
              validators={{
                onBlur: ({ value }) => {
                  const r = createInterviewSchema.shape.companyName.safeParse(value.trim())
                  return r.success ? undefined : r.error.issues[0]?.message
                },
              }}
            >
              {(field) => {
                const hasError = field.state.meta.isTouched && field.state.meta.errors.length > 0
                return (
                  <div className="space-y-1">
                    <Label className={cn(hasError && 'text-destructive')}>
                      Компания <span className="text-red-400">*</span>
                    </Label>
                    <Input
                      value={field.state.value}
                      onChange={(e) => field.handleChange(e.target.value)}
                      onBlur={field.handleBlur}
                      placeholder="Название компании"
                      className={cn(
                        hasError && 'border-destructive focus-visible:ring-destructive/30',
                      )}
                    />
                    {hasError && field.state.meta.errors[0] && (
                      <p className="text-xs text-destructive">{field.state.meta.errors[0]}</p>
                    )}
                  </div>
                )
              }}
            </form.Field>

            <form.Field
              name="vacancyUrl"
              validators={{
                onBlur: ({ value }) => {
                  const r = urlSchema.safeParse(value)
                  return r.success ? undefined : r.error.issues[0]?.message
                },
              }}
            >
              {(field) => {
                const hasError = field.state.meta.isTouched && field.state.meta.errors.length > 0
                return (
                  <div className="space-y-1">
                    <Label className={cn(hasError && 'text-destructive')}>Ссылка на вакансию</Label>
                    <Input
                      value={field.state.value}
                      onChange={(e) => field.handleChange(e.target.value)}
                      onBlur={field.handleBlur}
                      placeholder="https://..."
                      className={cn(
                        hasError && 'border-destructive focus-visible:ring-destructive/30',
                      )}
                    />
                    {hasError && field.state.meta.errors[0] && (
                      <p className="text-xs text-destructive">{field.state.meta.errors[0]}</p>
                    )}
                  </div>
                )
              }}
            </form.Field>

            <form.Field
              name="callUrl"
              validators={{
                onBlur: ({ value }) => {
                  const r = urlSchema.safeParse(value)
                  return r.success ? undefined : r.error.issues[0]?.message
                },
              }}
            >
              {(field) => {
                const hasError = field.state.meta.isTouched && field.state.meta.errors.length > 0
                return (
                  <div className="space-y-1">
                    <Label className={cn(hasError && 'text-destructive')}>Ссылка на звонок</Label>
                    <Input
                      value={field.state.value}
                      onChange={(e) => field.handleChange(e.target.value)}
                      onBlur={field.handleBlur}
                      placeholder="https://meet.google.com/..."
                      className={cn(
                        hasError && 'border-destructive focus-visible:ring-destructive/30',
                      )}
                    />
                    {hasError && field.state.meta.errors[0] && (
                      <p className="text-xs text-destructive">{field.state.meta.errors[0]}</p>
                    )}
                  </div>
                )
              }}
            </form.Field>
          </div>
        </CrmDialogBody>
        <CrmDialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Отмена
          </Button>
          <Button onClick={() => void form.handleSubmit()} disabled={createMutation.isPending}>
            {createMutation.isPending ? 'Создаём...' : 'Создать'}
          </Button>
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}
