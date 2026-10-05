import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Trans, useLingui } from '@lingui/react/macro'
import type { ProjectMemberDto, Role } from '@crm/shared'
import { api } from '@/lib/axios'
import { cn } from '@/lib/utils'
import { getInitialsBySpaceSplit } from '@/lib/initials'
import { ROLE_LABEL_MESSAGES } from '@/components/ui/role-select'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
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
import { ROLE_VARIANT } from './constants'

export interface UserForAdd {
  id: string
  displayName: string
  email: string
  role: string
  avatarUrl: string | null
  avatarDocumentId: string | null
  hasActiveProject: boolean
}

interface ProjectMemberDialogsProps {
  projectId: string
  /** Member awaiting remove confirmation; the confirm dialog is open while non-null. */
  removeMemberTarget: ProjectMemberDto | null
  onCloseRemoveMember: () => void
  addMemberOpen: boolean
  onCloseAddMember: () => void
  /** Candidates already filtered by the page (`availableToAdd`). */
  availableToAdd: UserForAdd[]
  /** Ids added during the current picker session; the page resets it when opening the picker. */
  addedMemberIds: Set<string>
  onMemberAdded: (userId: string) => void
}

/**
 * Remove-member confirm + add-member picker dialogs, moved verbatim from `$projectId.tsx`.
 * Owns the two member mutations and the picker's pending-ids state. The open flag, the
 * remove target and `addedMemberIds` stay on the page (its trigger buttons write them).
 */
export function ProjectMemberDialogs({
  projectId,
  removeMemberTarget,
  onCloseRemoveMember,
  addMemberOpen,
  onCloseAddMember,
  availableToAdd,
  addedMemberIds,
  onMemberAdded,
}: ProjectMemberDialogsProps) {
  const { t, i18n } = useLingui()
  const qc = useQueryClient()
  const [pendingMemberIds, setPendingMemberIds] = useState<Set<string>>(new Set())

  const removeMemberMutation = useMutation({
    mutationFn: (userId: string) => api.delete(`/projects/${projectId}/members/${userId}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['projects', projectId] })
      void qc.invalidateQueries({ queryKey: ['projects'] })
      onCloseRemoveMember()
    },
  })

  const addMemberMutation = useMutation({
    mutationFn: (userId: string) => api.post(`/projects/${projectId}/members`, { userId }),
    onSuccess: (_, userId) => {
      void qc.invalidateQueries({ queryKey: ['projects', projectId] })
      void qc.invalidateQueries({ queryKey: ['projects'] })
      void qc.invalidateQueries({ queryKey: ['users'] })
      onMemberAdded(userId)
      setPendingMemberIds((prev) => {
        const next = new Set(prev)
        next.delete(userId)
        return next
      })
    },
    onError: (_, userId) => {
      setPendingMemberIds((prev) => {
        const next = new Set(prev)
        next.delete(userId)
        return next
      })
    },
  })

  return (
    <>
      {/* ── Remove member confirm ── */}
      <Dialog open={!!removeMemberTarget} onOpenChange={(v) => !v && onCloseRemoveMember()}>
        <CrmDialogContent maxWidth="sm:max-w-sm">
          <CrmDialogHeader>
            <DialogTitle>
              <Trans>Прибрати зі складу?</Trans>
            </DialogTitle>
            <DialogDescription className="sr-only">
              <Trans>Підтвердження видалення учасника зі складу проєкту.</Trans>
            </DialogDescription>
          </CrmDialogHeader>
          <CrmDialogBody className="pb-2">
            <p className="text-sm text-muted-foreground">
              <Trans>
                <span className="font-medium text-foreground">
                  {removeMemberTarget?.displayName}
                </span>{' '}
                більше не буде у складі проєкту.
              </Trans>
            </p>
          </CrmDialogBody>
          <CrmDialogFooter>
            <Button variant="outline" onClick={() => onCloseRemoveMember()}>
              <Trans>Скасувати</Trans>
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                removeMemberTarget && removeMemberMutation.mutate(removeMemberTarget.userId)
              }
              disabled={removeMemberMutation.isPending}
            >
              <Trans>Прибрати</Trans>
            </Button>
          </CrmDialogFooter>
        </CrmDialogContent>
      </Dialog>
      {/* ── Add member ── */}
      <Dialog
        open={addMemberOpen}
        onOpenChange={(v) => {
          // Stryker disable next-line ConditionalExpression: Radix never emits onOpenChange(true) for a controlled Dialog without a trigger, so `if (true)` is unobservable
          if (!v) onCloseAddMember()
        }}
      >
        <CrmDialogContent maxWidth="max-w-sm">
          <CrmDialogHeader>
            <DialogTitle>
              <Trans>Додати до складу</Trans>
            </DialogTitle>
            <DialogDescription className="sr-only">
              <Trans>Вибір учасників для додавання до складу проєкту.</Trans>
            </DialogDescription>
          </CrmDialogHeader>
          <CrmDialogBody>
            <div className="max-h-72 space-y-1.5 overflow-y-auto">
              {availableToAdd.length === 0 && (
                <p className="text-sm text-muted-foreground py-2">
                  <Trans>Немає кого додати</Trans>
                </p>
              )}
              {availableToAdd.map((u) => {
                const isAdded = addedMemberIds.has(u.id)
                const isPending = pendingMemberIds.has(u.id)
                return (
                  <div key={u.id} className="flex items-center gap-2.5 rounded-md px-3 py-2">
                    <Avatar className="h-7 w-7 shrink-0">
                      {u.avatarUrl && <AvatarImage src={u.avatarUrl} />}
                      <AvatarFallback className="text-[10px]">
                        {getInitialsBySpaceSplit(u.displayName)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{u.displayName}</p>
                      <p className="truncate text-xs text-muted-foreground">{u.email}</p>
                    </div>
                    <Badge
                      variant={ROLE_VARIANT[u.role] ?? 'junior'}
                      className="shrink-0 text-[9px]"
                    >
                      {i18n._(ROLE_LABEL_MESSAGES[u.role as Role])}
                    </Badge>
                    <Button
                      size="sm"
                      // Stryker disable next-line StringLiteral: 'default' is also the cva defaultVariants fallback, so emptying it is equivalent
                      variant={isAdded ? 'outline' : 'default'}
                      className={cn(
                        'shrink-0 h-7 text-xs px-2.5',
                        isAdded && 'text-emerald-500 border-emerald-500/40',
                      )}
                      disabled={isAdded || isPending}
                      onClick={() => {
                        setPendingMemberIds((prev) => new Set(prev).add(u.id))
                        addMemberMutation.mutate(u.id)
                      }}
                    >
                      {isAdded ? t`Додано` : isPending ? t`Додаємо…` : t`Додати`}
                    </Button>
                  </div>
                )
              })}
            </div>
          </CrmDialogBody>
        </CrmDialogContent>
      </Dialog>
    </>
  )
}
