import { useForm } from '@tanstack/react-form'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Sparkles, Users } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { TeamDto, TeamMode, UserProfileDto } from '@crm/shared'
import { rejoinTeamSchema } from '@crm/shared'
import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { toast } from 'sonner'
import { getApiErrorMessage, translateZodCode, translateZodMessage } from '@/lib/axios-utils'
import { Button } from '@/components/ui/button'
import {
  CrmDialogBody,
  CrmDialogContent,
  CrmDialogFooter,
  CrmDialogHeader,
  Dialog,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/crm-dialog'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Field } from './section'
import { HrChipsField } from './HrChipsField'
import { AccountantChipField } from './AccountantChipField'
import { api } from '@/lib/axios'
import { cn } from '@/lib/utils'

/**
 * Drop role - phase 1 (AC7) — «Создать/выбрать команду» dialog for a
 * teamless SENIOR. Mirrors the create-senior team-mode picker from
 * UserDialog (CREATE_NEW vs JOIN_DROP_TEAM) but submits to:
 *
 *   POST /api/users/me/rejoin-team { teamMode, dropTeamId?, hrIds?, accountantId? }
 *
 * Only SENIORs can land here — the backend rejects other roles with 403.
 */
export function RejoinTeamDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useLingui()
  const queryClient = useQueryClient()

  const { data: allUsers } = useQuery({
    queryKey: ['users-admin'],
    queryFn: () => api.get<UserProfileDto[]>('/users').then((r) => r.data),
    enabled: open,
  })
  const hrUsers = useMemo(
    () => allUsers?.filter((u) => u.role === 'HR' && !u.archivedAt) ?? [],
    [allUsers],
  )
  const accountantUsers = useMemo(
    () => allUsers?.filter((u) => u.role === 'ACCOUNTANT' && !u.archivedAt) ?? [],
    [allUsers],
  )

  const { data: dropTeams } = useQuery({
    queryKey: ['teams', { type: 'DROP', vacant: true }],
    queryFn: () => api.get<TeamDto[]>('/teams').then((r) => r.data),
    enabled: open,
    staleTime: 30_000,
  })
  const vacantDropTeams = useMemo(() => {
    if (!dropTeams) return []
    return dropTeams.filter(
      (t) =>
        t.type === 'DROP' &&
        !t.archivedAt &&
        !t.members.some((m) => m.role === 'SENIOR' && !m.leftAt),
    )
  }, [dropTeams])

  const [selectedHrIds, setSelectedHrIds] = useState<string[]>([])
  const [selectedAccountantId, setSelectedAccountantId] = useState<string>('')

  useEffect(() => {
    if (!open) return
    const initialHr = hrUsers.length === 1 && hrUsers[0] ? [hrUsers[0].id] : []
    setSelectedHrIds(initialHr)
    const initialAcc =
      accountantUsers.length === 1 && accountantUsers[0] ? accountantUsers[0].id : ''
    setSelectedAccountantId(initialAcc)
  }, [open, hrUsers.length, accountantUsers.length])

  const mutation = useMutation({
    mutationFn: (data: {
      teamMode: TeamMode
      dropTeamId?: string
      hrIds?: string[]
      accountantId?: string | null
    }) => api.post('/users/me/rejoin-team', data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['teams'] })
      void queryClient.invalidateQueries({ queryKey: ['team'] })
      void queryClient.invalidateQueries({ queryKey: ['projects'] })
      void queryClient.invalidateQueries({ queryKey: ['interviews'] })
      void queryClient.invalidateQueries({ queryKey: ['users'] })
      void queryClient.invalidateQueries({ queryKey: ['users-admin'] })
      void queryClient.invalidateQueries({ queryKey: ['auth', 'me'] })
      toast.success(t`Команду оновлено`)
      handleClose()
    },
    onError: (err: unknown) => {
      toast.error(getApiErrorMessage(err, t`Не вдалося приєднатися до команди — спробуйте ще раз`))
    },
  })

  const form = useForm({
    defaultValues: {
      teamMode: 'CREATE_NEW' as TeamMode,
      dropTeamId: '' as string,
    },
    onSubmit: async ({ value }) => {
      const isJoin = value.teamMode === 'JOIN_DROP_TEAM'

      if (isJoin && !value.dropTeamId) {
        toast.error(translateZodCode('DROP_TEAM_ID_REQUIRED'))
        return
      }
      if (!isJoin && selectedHrIds.length === 0) {
        toast.error(translateZodCode('HR_REQUIRED_MIN'))
        return
      }

      const payload = isJoin
        ? { teamMode: 'JOIN_DROP_TEAM' as TeamMode, dropTeamId: value.dropTeamId }
        : {
            teamMode: 'CREATE_NEW' as TeamMode,
            hrIds: selectedHrIds,
            accountantId: selectedAccountantId || null,
          }

      const result = rejoinTeamSchema.safeParse(payload)
      if (!result.success) {
        // fix-round 1 (SR-M-1): this branch is latent today (the two local
        // checks above catch the same two conditions first) but IS the
        // defense-in-depth layer for whatever the schema's `superRefine`
        // guards next — without `translateZodMessage` it would show the raw
        // `zod.<CODE>` key verbatim.
        const first = result.error.issues[0]
        toast.error(
          // Stryker disable next-line OptionalChaining: issues[0] is guaranteed non-null on a failed safeParse — see UserDialog.tsx's own field validators for the same invariant
          translateZodMessage(first?.message) ?? translateZodCode('VALIDATION_FAILED_FORM'),
        )
        return
      }
      mutation.mutate(payload)
    },
  })

  const handleClose = () => {
    form.reset()
    setSelectedHrIds([])
    setSelectedAccountantId('')
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <CrmDialogContent data-testid="rejoin-team-dialog">
        <CrmDialogHeader>
          <DialogTitle>
            <Trans>Створити або обрати команду</Trans>
          </DialogTitle>
          <DialogDescription className="sr-only">
            <Trans>Вибір команди</Trans>
          </DialogDescription>
          <p className="text-xs text-muted-foreground mt-1">
            <Trans>
              У вас немає активної команди. Створіть свою або приєднайтеся до команди дропа.
            </Trans>
          </p>
        </CrmDialogHeader>
        <CrmDialogBody className="space-y-3">
          <form.Field name="teamMode">
            {(field) => (
              <Field label={t`Команда`} required>
                <RadioGroup
                  value={field.state.value}
                  onValueChange={(v) => field.handleChange(v as TeamMode)}
                  className="grid gap-2"
                  data-testid="rejoin-team-mode"
                >
                  <label
                    className={cn(
                      'flex items-start gap-2 rounded-md border px-3 py-2 text-xs cursor-pointer transition-colors',
                      field.state.value === 'CREATE_NEW'
                        ? 'border-primary/50 bg-primary/5'
                        : 'border-input hover:bg-muted/40',
                    )}
                  >
                    <RadioGroupItem
                      value="CREATE_NEW"
                      className="mt-0.5"
                      data-testid="rejoin-team-mode-create-new"
                    />
                    <div className="flex-1">
                      <div className="font-medium inline-flex items-center gap-1">
                        <Sparkles className="h-3 w-3" />
                        <Trans>Створити свою команду</Trans>
                      </div>
                      <p className="text-muted-foreground mt-0.5">
                        <Trans>Нова команда — оберіть HR і бухгалтера нижче.</Trans>
                      </p>
                    </div>
                  </label>
                  <label
                    className={cn(
                      'flex items-start gap-2 rounded-md border px-3 py-2 text-xs cursor-pointer transition-colors',
                      field.state.value === 'JOIN_DROP_TEAM'
                        ? 'border-primary/50 bg-primary/5'
                        : 'border-input hover:bg-muted/40',
                      vacantDropTeams.length === 0 && 'opacity-60',
                    )}
                  >
                    <RadioGroupItem
                      value="JOIN_DROP_TEAM"
                      className="mt-0.5"
                      disabled={vacantDropTeams.length === 0}
                      data-testid="rejoin-team-mode-join-drop"
                    />
                    <div className="flex-1">
                      <div className="font-medium inline-flex items-center gap-1">
                        <Users className="h-3 w-3" />
                        <Trans>Приєднатися до команди дропа</Trans>
                      </div>
                      <p className="text-muted-foreground mt-0.5">
                        {vacantDropTeams.length === 0 ? (
                          <Trans>Немає команд дропа без активного сеньйора.</Trans>
                        ) : (
                          <Plural
                            value={vacantDropTeams.length}
                            one="Доступна # команда."
                            few="Доступно # команди."
                            many="Доступно # команд."
                            other="Доступно # команди."
                          />
                        )}
                      </p>
                    </div>
                  </label>
                </RadioGroup>
              </Field>
            )}
          </form.Field>

          <form.Subscribe selector={(s) => s.values.teamMode}>
            {(teamMode) =>
              teamMode === 'JOIN_DROP_TEAM' ? (
                <form.Field name="dropTeamId">
                  {(field) => (
                    <Field label={t`Команда дропа`} required>
                      {vacantDropTeams.length === 0 ? (
                        <p className="text-xs text-muted-foreground italic">
                          <Trans>Немає доступних команд дропа.</Trans>
                        </p>
                      ) : (
                        <Select
                          value={field.state.value || ''}
                          onValueChange={(v) => field.handleChange(v)}
                        >
                          <SelectTrigger data-testid="rejoin-drop-team-trigger">
                            <SelectValue placeholder={t`— оберіть команду —`} />
                          </SelectTrigger>
                          <SelectContent>
                            {vacantDropTeams.map((dropTeam) => {
                              const drop = dropTeam.members.find(
                                (m) => m.role === 'DROP' && !m.leftAt,
                              )
                              return (
                                <SelectItem key={dropTeam.id} value={dropTeam.id}>
                                  <div className="flex flex-col items-start">
                                    <span className="font-medium">{dropTeam.name}</span>
                                    <span className="text-[10px] text-muted-foreground">
                                      {drop?.displayName ?? t`Дропа не призначено`}
                                    </span>
                                  </div>
                                </SelectItem>
                              )
                            })}
                          </SelectContent>
                        </Select>
                      )}
                    </Field>
                  )}
                </form.Field>
              ) : (
                <>
                  <HrChipsField
                    hrUsers={hrUsers}
                    selectedIds={selectedHrIds}
                    onChange={setSelectedHrIds}
                    required
                    onlyHr={hrUsers.length === 1}
                  />
                  <AccountantChipField
                    accountantUsers={accountantUsers}
                    selectedId={selectedAccountantId}
                    onChange={setSelectedAccountantId}
                    onlyAccountant={accountantUsers.length === 1}
                  />
                </>
              )
            }
          </form.Subscribe>
        </CrmDialogBody>
        <CrmDialogFooter>
          <Button variant="ghost" onClick={handleClose}>
            <Trans>Скасувати</Trans>
          </Button>
          <Button
            onClick={() => void form.handleSubmit()}
            disabled={mutation.isPending}
            data-testid="rejoin-team-submit"
          >
            {mutation.isPending ? <Trans>Зберігаємо…</Trans> : <Trans>Зберегти</Trans>}
          </Button>
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}
