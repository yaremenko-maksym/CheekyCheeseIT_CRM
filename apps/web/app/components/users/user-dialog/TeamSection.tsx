import { Link } from '@tanstack/react-router'
import type { ReactFormExtendedApi } from '@tanstack/react-form'
import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { Send, Sparkles, Users } from 'lucide-react'
import type { ProjectDto, TeamDto, TeamMode, UserProfileDto } from '@crm/shared'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { translateZodCode } from '@/lib/axios-utils'
import { cn } from '@/lib/utils'
import { AccountantChipField } from '../AccountantChipField'
import { HrChipsField } from '../HrChipsField'
import { Field, Section } from '../section'

// TanStack Form render props require many generics — same suppression as
// ContactsSection (the form instance is owned by UserDialog).
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyForm = ReactFormExtendedApi<any, any, any, any, any, any, any, any, any, any, any, any>
/* eslint-enable @typescript-eslint/no-explicit-any */

interface TeamSectionProps {
  form: Pick<AnyForm, 'Field' | 'Subscribe'>
  isCreate: boolean
  isEdit: boolean
  hrUsers: UserProfileDto[]
  accountantUsers: UserProfileDto[]
  selectedHrIds: string[]
  handleHrChange: (next: string[]) => void
  hrError: string | undefined
  selectedAccountantId: string
  setSelectedAccountantId: (next: string) => void
  vacantDropTeams: TeamDto[]
  availableJuniorProjects: ProjectDto[]
  juniorActiveProjects: ProjectDto[]
  onClose: () => void
}

/**
 * Team section of UserDialog: DROP team provisioning (create), SENIOR team
 * mode / HR + accountant pickers / drop-team join / channel, and JUNIOR project
 * assignment. SECURITY-SENSITIVE (RBAC team assignment). Pure move out of
 * UserDialog — role gates, filters and validators unchanged. State and the
 * useMemo derivations stay in the parent; payload building stays in the parent
 * `onSubmit`.
 */
export function TeamSection({
  form,
  isCreate,
  isEdit,
  hrUsers,
  accountantUsers,
  selectedHrIds,
  handleHrChange,
  hrError,
  selectedAccountantId,
  setSelectedAccountantId,
  vacantDropTeams,
  availableJuniorProjects,
  juniorActiveProjects,
  onClose,
}: TeamSectionProps) {
  const { t } = useLingui()
  return (
    <form.Subscribe selector={(s) => s.values.role}>
      {(role) => {
        // DROP role - phase 1 fix: drop-team is provisioned
        // atomically with the drop user via POST /api/users/drops.
        // The team section is mandatory and identical in shape to
        // the senior CREATE_NEW flow, minus the RadioGroup (no
        // «join existing» option for a drop). Only renders in
        // create-mode: editing a DROP user keeps the role lock
        // and routes through PATCH /api/users/:id.
        if (role === 'DROP' && isCreate) {
          const onlyHr = hrUsers.length === 1
          const onlyAccountant = accountantUsers.length === 1
          return (
            <Section title={t`Команда дропа`}>
              <HrChipsField
                hrUsers={hrUsers}
                selectedIds={selectedHrIds}
                onChange={handleHrChange}
                required
                onlyHr={onlyHr}
                error={hrError}
              />

              <AccountantChipField
                accountantUsers={accountantUsers}
                selectedId={selectedAccountantId}
                onChange={setSelectedAccountantId}
                onlyAccountant={onlyAccountant}
              />

              <form.Field
                name="teamTelegramChannelDrop"
                validators={{
                  onBlur: ({ value, fieldApi }) => {
                    if (!fieldApi.state.meta.isDirty) return undefined
                    const trimmed = value.trim()
                    if (!trimmed) return undefined
                    return /^@?[a-zA-Z0-9_]{5,32}$/.test(trimmed)
                      ? undefined
                      : translateZodCode('TELEGRAM_CHANNEL_FORMAT')
                  },
                }}
              >
                {(field) => {
                  const showError = field.state.meta.isTouched && field.state.meta.isDirty
                  const err = showError ? field.state.meta.errors[0] : undefined
                  return (
                    <Field
                      label={t`Telegram-канал команди`}
                      error={err}
                      hint={err ? undefined : t`Необов’язково. Канал для спілкування команди.`}
                    >
                      <div className="relative">
                        <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 inline-flex items-center gap-1 text-xs text-muted-foreground">
                          <Send className="h-3.5 w-3.5" />
                          t.me/
                        </span>
                        <Input
                          placeholder="team_channel"
                          className={cn(
                            'pl-16',
                            err && 'border-destructive focus-visible:ring-destructive/30',
                          )}
                          value={field.state.value}
                          onChange={(e) => field.handleChange(e.target.value)}
                          onBlur={field.handleBlur}
                          autoComplete="off"
                          autoCapitalize="off"
                          autoCorrect="off"
                          data-testid="user-dialog-drop-team-telegram-channel"
                        />
                      </div>
                    </Field>
                  )
                }}
              </form.Field>
            </Section>
          )
        }

        if (role === 'SENIOR') {
          const onlyHr = hrUsers.length === 1
          const onlyAccountant = accountantUsers.length === 1

          return (
            <Section title={t`Команда`}>
              {/* Drop role - phase 1 (AC3): two-option team picker.
                          - CREATE_NEW (default): legacy senior-team flow.
                          - JOIN_DROP_TEAM: pick a vacant drop-team. HR /
                            accountant / channel sourced from that team. */}
              {isCreate && (
                <form.Field name="teamMode">
                  {(field) => (
                    <Field label={t`Тип команди`} required>
                      <RadioGroup
                        value={field.state.value}
                        onValueChange={(v) => field.handleChange(v as TeamMode)}
                        className="grid gap-2"
                        data-testid="user-dialog-team-mode"
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
                            data-testid="user-dialog-team-mode-create-new"
                          />
                          <div className="flex-1">
                            <div className="font-medium inline-flex items-center gap-1">
                              <Sparkles className="h-3 w-3" />
                              <Trans>Створити свою команду</Trans>
                            </div>
                            <p className="text-muted-foreground mt-0.5">
                              <Trans>Нова команда сеньйора. Оберіть склад нижче.</Trans>
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
                            data-testid="user-dialog-team-mode-join-drop"
                          />
                          <div className="flex-1">
                            <div className="font-medium inline-flex items-center gap-1">
                              <Users className="h-3 w-3" />
                              <Trans>Додати до команди дропа</Trans>
                            </div>
                            <p className="text-muted-foreground mt-0.5">
                              {vacantDropTeams.length === 0 ? (
                                <Trans>Немає команд дропа без активного сеньйора.</Trans>
                              ) : (
                                <Plural
                                  value={vacantDropTeams.length}
                                  one="# команда доступна."
                                  few="# команди доступні."
                                  many="# команд доступно."
                                  other="# команди доступно."
                                />
                              )}
                            </p>
                          </div>
                        </label>
                      </RadioGroup>
                    </Field>
                  )}
                </form.Field>
              )}

              {/* CREATE_NEW branch: legacy HR / accountant / channel pickers. */}
              <form.Subscribe selector={(s) => s.values.teamMode}>
                {(teamMode) => {
                  // Edit mode: teamMode field doesn't apply — keep
                  // the original SENIOR edit form unchanged (renders
                  // the legacy CREATE_NEW pickers so admin can swap
                  // HR/accountant for the existing team).
                  if (isEdit || teamMode === 'CREATE_NEW')
                    return (
                      <>
                        {/* ut-16: HR as chips + searchable add popover. */}
                        <HrChipsField
                          hrUsers={hrUsers}
                          selectedIds={selectedHrIds}
                          onChange={handleHrChange}
                          required={isCreate}
                          onlyHr={onlyHr}
                          error={hrError}
                        />

                        {/* ut-16: Accountant as a chip in the same visual language. */}
                        <AccountantChipField
                          accountantUsers={accountantUsers}
                          selectedId={selectedAccountantId}
                          onChange={setSelectedAccountantId}
                          onlyAccountant={onlyAccountant}
                        />
                      </>
                    )
                  // JOIN_DROP_TEAM branch: pick the drop-team to attach to.
                  // HR/accountant are inherited from that team — no local
                  // pickers, no channel input.
                  return (
                    <form.Field
                      name="dropTeamId"
                      validators={{
                        onBlur: ({ value, fieldApi }) => {
                          if (!fieldApi.state.meta.isDirty) return undefined
                          if (!value) return translateZodCode('DROP_TEAM_ID_REQUIRED')
                          return undefined
                        },
                      }}
                    >
                      {(field) => {
                        const showError = field.state.meta.isTouched && field.state.meta.isDirty
                        const err = showError ? field.state.meta.errors[0] : undefined
                        return (
                          <Field label={t`Команда дропа`} error={err} required>
                            {vacantDropTeams.length === 0 ? (
                              <p className="text-xs text-muted-foreground italic">
                                <Trans>
                                  Немає команд дропа без активного сеньйора. Створіть дропа або
                                  оберіть «Створити свою команду».
                                </Trans>
                              </p>
                            ) : (
                              <Select
                                value={field.state.value || ''}
                                onValueChange={(v) => field.handleChange(v)}
                              >
                                <SelectTrigger data-testid="user-dialog-drop-team-trigger">
                                  <SelectValue placeholder={t`— оберіть команду дропа —`} />
                                </SelectTrigger>
                                <SelectContent>
                                  {vacantDropTeams.map((team) => {
                                    const drop = team.members.find(
                                      (m) => m.role === 'DROP' && !m.leftAt,
                                    )
                                    const hrs = team.members
                                      .filter((m) => m.role === 'HR' && !m.leftAt)
                                      .map((m) => m.displayName)
                                      .join(', ')
                                    return (
                                      <SelectItem key={team.id} value={team.id}>
                                        <div className="flex flex-col items-start">
                                          <span className="font-medium">{team.name}</span>
                                          <span className="text-[10px] text-muted-foreground">
                                            {drop?.displayName ?? t`Дропа не призначено`}
                                            {hrs ? ` · HR: ${hrs}` : ''}
                                          </span>
                                        </div>
                                      </SelectItem>
                                    )
                                  })}
                                </SelectContent>
                              </Select>
                            )}
                          </Field>
                        )
                      }}
                    </form.Field>
                  )
                }}
              </form.Subscribe>

              {/* ut-17: optional team Telegram channel.
                          Hidden when joining an existing drop-team (channel
                          inherited from that team). */}
              <form.Subscribe selector={(s) => s.values.teamMode}>
                {(teamMode) =>
                  isEdit || teamMode === 'CREATE_NEW' ? (
                    <form.Field
                      name="teamTelegramChannel"
                      validators={{
                        onBlur: ({ value, fieldApi }) => {
                          if (!fieldApi.state.meta.isDirty) return undefined
                          const trimmed = value.trim()
                          if (!trimmed) return undefined
                          return /^@?[a-zA-Z0-9_]{5,32}$/.test(trimmed)
                            ? undefined
                            : translateZodCode('TELEGRAM_CHANNEL_FORMAT')
                        },
                      }}
                    >
                      {(field) => {
                        const showError = field.state.meta.isTouched && field.state.meta.isDirty
                        const err = showError ? field.state.meta.errors[0] : undefined
                        return (
                          <Field
                            label={t`Telegram-канал команди`}
                            error={err}
                            hint={
                              err ? undefined : t`Необов’язково. Канал для спілкування команди.`
                            }
                          >
                            <div className="relative">
                              <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 inline-flex items-center gap-1 text-xs text-muted-foreground">
                                <Send className="h-3.5 w-3.5" />
                                t.me/
                              </span>
                              <Input
                                placeholder="team_channel"
                                className={cn(
                                  'pl-16',
                                  err && 'border-destructive focus-visible:ring-destructive/30',
                                )}
                                value={field.state.value}
                                onChange={(e) => field.handleChange(e.target.value)}
                                onBlur={field.handleBlur}
                                autoComplete="off"
                                autoCapitalize="off"
                                autoCorrect="off"
                                data-testid="user-dialog-team-telegram-channel"
                              />
                            </div>
                          </Field>
                        )
                      }}
                    </form.Field>
                  ) : null
                }
              </form.Subscribe>
            </Section>
          )
        }

        if (role === 'JUNIOR') {
          if (isCreate) {
            return (
              <Section title={t`Команда`}>
                <form.Field name="projectId">
                  {(field) => (
                    <Field label={t`Проєкт`} hint={t`Можна прикріпити пізніше в розділі «Проєкти»`}>
                      {availableJuniorProjects.length === 0 ? (
                        <p className="text-xs text-muted-foreground italic">
                          <Trans>Немає проєктів без активного джуніора</Trans>
                        </p>
                      ) : (
                        <Select
                          value={field.state.value || 'none'}
                          onValueChange={(v) => field.handleChange(v === 'none' ? '' : v)}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder={t`— не обрано —`} />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">{t`— не обрано —`}</SelectItem>
                            {availableJuniorProjects.map((p) => (
                              <SelectItem key={p.id} value={p.id}>
                                {p.companyName} — {p.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </Field>
                  )}
                </form.Field>
              </Section>
            )
          }
          // Edit JUNIOR: read-only project list + link
          return (
            <Section title={t`Команда`}>
              <Field label={t`Активні проєкти`}>
                {juniorActiveProjects.length === 0 ? (
                  <p className="text-xs text-muted-foreground italic">
                    <Trans>Немає активних проєктів</Trans>
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-1" data-testid="user-dialog-junior-projects">
                    {juniorActiveProjects.map((p) => (
                      <Badge key={p.id} variant="outline" className="text-[11px]">
                        {p.companyName} — {p.name}
                      </Badge>
                    ))}
                  </div>
                )}
                <Link
                  to="/projects"
                  className="text-xs text-primary hover:underline mt-1 inline-block"
                  onClick={() => onClose()}
                >
                  <Trans>Керувати в розділі «Проєкти» →</Trans>
                </Link>
              </Field>
            </Section>
          )
        }

        // ADMIN / HR / ACCOUNTANT — no team section (HR and ACCOUNTANT manage assignments via Teams page)
        return null
      }}
    </form.Subscribe>
  )
}
