import { useRef, useState } from 'react'
import { useForm } from '@tanstack/react-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { z } from 'zod'
import type { InterviewDto, InterviewStage } from '@crm/shared'
import { updateInterviewSchema, IT_DOMAINS } from '@crm/shared'
import { api } from '@/lib/axios'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import {
  STAGE_BADGE_COLORS,
  STAGE_LABELS,
  TERMINAL_STAGES,
  getNextStage,
  getPrevStage,
} from '../constants'

export function InterviewDetailSheet({
  interview,
  open,
  onClose,
  onSaved,
  onDeleted,
  canDelete,
  canMove,
  canMoveTerminal,
  canCreateProject = false,
}: {
  interview: InterviewDto
  open: boolean
  onClose: () => void
  onSaved: (updated: InterviewDto) => void
  onDeleted: () => void
  canDelete: boolean
  canMove: boolean
  canMoveTerminal: boolean
  canCreateProject?: boolean
}) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmCreateProject, setConfirmCreateProject] = useState(false)
  const [hiredInterview, setHiredInterview] = useState<InterviewDto | null>(null)

  const [createdProjectId, setCreatedProjectId] = useState<string | null>(null)
  const [confirmUnsaved, setConfirmUnsaved] = useState(false)
  const closeAfterSave = useRef(false)

  const updateMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      api.patch<InterviewDto>(`/interviews/${interview.id}`, data).then((r) => r.data),
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: ['interviews'] })
      toast.success('Карточка сохранена')
      onSaved(updated)
      if (closeAfterSave.current) {
        closeAfterSave.current = false
        onClose()
      }
    },
  })

  const moveMutation = useMutation({
    mutationFn: (data: { stage: InterviewStage; position: number }) =>
      api.patch<InterviewDto>(`/interviews/${interview.id}/move`, data).then((r) => r.data),
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: ['interviews'] })
      onSaved(updated)
      if (updated.stage === 'HIRED' && canCreateProject) {
        setHiredInterview(updated)
        setCreatedProjectId(updated.createdProjectId ?? null)
        setConfirmCreateProject(true)
        void queryClient.invalidateQueries({ queryKey: ['projects'] })
      }
    },
  })

  async function handleMoveWithSave(stage: InterviewStage, position: number) {
    if (form.state.isDirty) {
      await api.patch(`/interviews/${interview.id}`, {
        companyName: form.state.values.companyName.trim() || undefined,
        vacancyUrl: form.state.values.vacancyUrl || null,
        notesDomain: form.state.values.notesDomain || null,
        notesTechStack: form.state.values.notesTechStack || null,
        notesTeamSize: form.state.values.notesTeamSize || null,
        notesBenefits: form.state.values.notesBenefits || null,
        notesPaymentType: form.state.values.notesPaymentType || null,
        notesSalaryReview: form.state.values.notesSalaryReview || null,
        notesCorpTech: form.state.values.notesCorpTech || null,
        notesGeneral: form.state.values.notesGeneral || null,
      })
    }
    moveMutation.mutate({ stage, position })
  }

  const deleteMutation = useMutation({
    mutationFn: () => api.delete(`/interviews/${interview.id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['interviews'] })
      onDeleted()
    },
  })

  const isTerminal = TERMINAL_STAGES.includes(interview.stage)
  const nextStage = getNextStage(interview.stage)
  const prevStage = getPrevStage(interview.stage)

  const form = useForm({
    defaultValues: {
      companyName: interview.companyName,
      vacancyUrl: interview.vacancyUrl ?? '',
      notesDomain: interview.notesDomain ?? '',
      notesTechStack: interview.notesTechStack ?? '',
      notesTeamSize: interview.notesTeamSize ?? '',
      notesBenefits: interview.notesBenefits ?? '',
      notesPaymentType: interview.notesPaymentType ?? '',
      notesSalaryReview: interview.notesSalaryReview ?? '',
      notesCorpTech: interview.notesCorpTech ?? '',
      notesGeneral: interview.notesGeneral ?? '',
    },
    onSubmit: async ({ value }) => {
      updateMutation.mutate({
        companyName: value.companyName.trim() || undefined,
        vacancyUrl: value.vacancyUrl || null,
        notesDomain: value.notesDomain || null,
        notesTechStack: value.notesTechStack || null,
        notesTeamSize: value.notesTeamSize || null,
        notesBenefits: value.notesBenefits || null,
        notesPaymentType: value.notesPaymentType || null,
        notesSalaryReview: value.notesSalaryReview || null,
        notesCorpTech: value.notesCorpTech || null,
        notesGeneral: value.notesGeneral || null,
      })
    },
  })

  function FieldRow({
    name,
    label,
    placeholder,
    schema,
    textarea = false,
  }: {
    name: keyof typeof form.state.values
    label: string
    placeholder: string
    schema: z.ZodTypeAny
    textarea?: boolean
  }) {
    return (
      <form.Field
        name={name}
        validators={{
          onBlur: ({ value }) => {
            const r = schema.safeParse(value)
            return r.success ? undefined : r.error.issues[0]?.message
          },
        }}
      >
        {(field) => {
          const hasError = field.state.meta.isTouched && field.state.meta.errors.length > 0
          return (
            <div className="space-y-1">
              <Label className={cn('text-xs', hasError && 'text-destructive')}>{label}</Label>
              {textarea ? (
                <Textarea
                  value={field.state.value as string}
                  onChange={(e) => field.handleChange(e.target.value)}
                  onBlur={field.handleBlur}
                  placeholder={placeholder}
                  rows={3}
                  className={cn(hasError && 'border-destructive focus-visible:ring-destructive/30')}
                />
              ) : (
                <Input
                  value={field.state.value as string}
                  onChange={(e) => field.handleChange(e.target.value)}
                  onBlur={field.handleBlur}
                  placeholder={placeholder}
                  className={cn(hasError && 'border-destructive focus-visible:ring-destructive/30')}
                />
              )}
              {hasError && field.state.meta.errors[0] && (
                <p className="text-xs text-destructive">{field.state.meta.errors[0]}</p>
              )}
            </div>
          )
        }}
      </form.Field>
    )
  }

  return (
    <>
      <Sheet
        open={open}
        onOpenChange={(v) => {
          if (!v) {
            if (form.state.isDirty) {
              setConfirmUnsaved(true)
            } else {
              onClose()
            }
          }
        }}
      >
        <SheetContent side="right" className="w-full sm:max-w-lg flex flex-col overflow-hidden">
          <SheetHeader className="mb-4 shrink-0">
            <SheetTitle className="pr-6">{interview.companyName}</SheetTitle>
            <SheetDescription className="sr-only">Детали собеседования</SheetDescription>
            <div className="flex items-center gap-2 flex-wrap">
              <span
                className={cn(
                  'text-xs font-medium px-2 py-0.5 rounded-full border',
                  STAGE_BADGE_COLORS[interview.stage],
                )}
              >
                {STAGE_LABELS[interview.stage]}
              </span>
              {interview.seniorName && (
                <span className="text-xs text-muted-foreground">
                  Senior: {interview.seniorName}
                </span>
              )}
            </div>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto px-px pb-px">
            <div className="flex flex-col gap-4">
              <div className="space-y-3">
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  Основное
                </h3>
                <FieldRow
                  name="companyName"
                  label="Компания"
                  placeholder="Название компании"
                  schema={updateInterviewSchema.shape.companyName.unwrap()}
                />
                <FieldRow
                  name="vacancyUrl"
                  label="Ссылка на вакансию"
                  placeholder="https://..."
                  schema={z.string().url('Введите корректный URL (https://...)').or(z.literal(''))}
                />
              </div>

              {canMove && (!isTerminal || canMoveTerminal) && (
                <div className="space-y-2">
                  <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Этап
                  </h3>
                  <div className="flex gap-2">
                    {prevStage && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1 text-xs"
                        onClick={() => void handleMoveWithSave(prevStage, 0)}
                        disabled={moveMutation.isPending}
                      >
                        ← {STAGE_LABELS[prevStage]}
                      </Button>
                    )}
                    {nextStage && (
                      <Button
                        size="sm"
                        className="flex-1 text-xs"
                        onClick={() => void handleMoveWithSave(nextStage, 0)}
                        disabled={moveMutation.isPending}
                      >
                        {STAGE_LABELS[nextStage]} →
                      </Button>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1 text-xs text-emerald-400 border-emerald-500/40 hover:bg-emerald-500/10"
                      onClick={() => void handleMoveWithSave('HIRED', 0)}
                      disabled={moveMutation.isPending}
                    >
                      Нанят
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1 text-xs text-red-400 border-red-500/40 hover:bg-red-500/10"
                      onClick={() => void handleMoveWithSave('REJECTED', 0)}
                      disabled={moveMutation.isPending}
                    >
                      Отказ
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1 text-xs text-gray-400 border-gray-500/40 hover:bg-gray-500/10"
                      onClick={() => void handleMoveWithSave('ARCHIVED', 0)}
                      disabled={moveMutation.isPending}
                    >
                      Архив
                    </Button>
                  </div>
                </div>
              )}

              <div className="space-y-3">
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  Заметки синьора
                </h3>
                <form.Field name="notesDomain">
                  {(field) => (
                    <div className="space-y-1">
                      <Label className="text-xs">Домен</Label>
                      <select
                        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
                        value={field.state.value ?? ''}
                        onChange={(e) => field.handleChange((e.target.value || null) as string)}
                      >
                        <option value="">— не выбран —</option>
                        {IT_DOMAINS.map((d) => (
                          <option key={d} value={d}>
                            {d}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </form.Field>
                <FieldRow
                  name="notesTechStack"
                  label="Стек технологий"
                  placeholder="React, Node.js, AWS"
                  schema={updateInterviewSchema.shape.notesTechStack.unwrap().unwrap()}
                />
                <FieldRow
                  name="notesTeamSize"
                  label="Состав команды"
                  placeholder="5 devs, 2 QA, 1 PM"
                  schema={updateInterviewSchema.shape.notesTeamSize.unwrap().unwrap()}
                />
                <FieldRow
                  name="notesBenefits"
                  label="Бенефиты"
                  placeholder="20 days vacation, health insurance"
                  schema={updateInterviewSchema.shape.notesBenefits.unwrap().unwrap()}
                />
                <FieldRow
                  name="notesPaymentType"
                  label="Тип оплаты"
                  placeholder="ФОП / гиг-контракт / крипта"
                  schema={updateInterviewSchema.shape.notesPaymentType.unwrap().unwrap()}
                />
                <FieldRow
                  name="notesSalaryReview"
                  label="Пересмотр зарплаты"
                  placeholder="через 3 місяці"
                  schema={updateInterviewSchema.shape.notesSalaryReview.unwrap().unwrap()}
                />
                <FieldRow
                  name="notesCorpTech"
                  label="Корпоративная техника"
                  placeholder="MacBook Pro M3, iPhone 15..."
                  schema={z.string().max(255)}
                />
                <FieldRow
                  name="notesGeneral"
                  label="Общие заметки"
                  placeholder="Свободные заметки..."
                  schema={updateInterviewSchema.shape.notesGeneral.unwrap().unwrap()}
                  textarea
                />
              </div>
            </div>
          </div>

          <div className="shrink-0 pt-3 border-t border-border">
            <div className="flex gap-2">
              <form.Subscribe selector={(s) => s.isDirty}>
                {(isDirty) => (
                  <Button
                    className="flex-1"
                    onClick={() => void form.handleSubmit()}
                    disabled={updateMutation.isPending || !isDirty}
                  >
                    {updateMutation.isPending ? 'Сохраняем...' : 'Сохранить'}
                  </Button>
                )}
              </form.Subscribe>
              {canDelete && (
                <Button
                  variant="outline"
                  size="icon"
                  title="Удалить карточку"
                  className="text-red-400 border-red-500/40 hover:bg-red-500/10"
                  onClick={() => setConfirmDelete(true)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>

          <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Удалить карточку?</DialogTitle>
                <DialogDescription className="sr-only">Удаление карточки</DialogDescription>
              </DialogHeader>
              <p className="text-sm text-muted-foreground">
                Карточка "{interview.companyName}" будет удалена безвозвратно.
              </p>
              <DialogFooter>
                <Button variant="outline" onClick={() => setConfirmDelete(false)}>
                  Отмена
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => deleteMutation.mutate()}
                  disabled={deleteMutation.isPending}
                >
                  Удалить
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </SheetContent>
      </Sheet>

      <Dialog open={confirmUnsaved} onOpenChange={() => {}}>
        <DialogContent onInteractOutside={(e) => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle>Несохранённые изменения</DialogTitle>
            <DialogDescription className="sr-only">Несохранённые изменения</DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Есть несохранённые изменения. Сохранить перед закрытием?
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setConfirmUnsaved(false)
                onClose()
              }}
            >
              Не сохранять
            </Button>
            <Button
              onClick={() => {
                setConfirmUnsaved(false)
                closeAfterSave.current = true
                void form.handleSubmit()
              }}
              disabled={updateMutation.isPending}
            >
              Сохранить
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmCreateProject} onOpenChange={() => {}}>
        <DialogContent onInteractOutside={(e) => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle>Создать проект?</DialogTitle>
            <DialogDescription className="sr-only">Создание проекта</DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Создать новый проект на базе карточки «{hiredInterview?.companyName}»?
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmCreateProject(false)}>
              Нет
            </Button>
            <Button
              onClick={() => {
                setConfirmCreateProject(false)
                if (createdProjectId) {
                  void navigate({
                    to: '/crm/projects/$projectId',
                    params: { projectId: createdProjectId },
                  })
                }
              }}
            >
              Да, перейти
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
