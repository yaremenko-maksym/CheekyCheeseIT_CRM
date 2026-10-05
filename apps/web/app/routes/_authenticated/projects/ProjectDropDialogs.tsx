import { Trans, useLingui } from '@lingui/react/macro'
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
import { ROLE_LABEL_MESSAGES } from '@/components/ui/role-select'
import { getInitialsBySpaceSplit } from '@/lib/initials'
import { useProjectDropMutations } from './use-project-drop-mutations'

export interface DropCandidate {
  id: string
  displayName: string
  email: string
  avatarUrl: string | null
}

interface ProjectDropDialogsProps {
  projectId: string
  /** Display name of the currently attached drop (null/undefined when masked or absent). */
  currentDropDisplayName: string | null | undefined
  dropCandidates: DropCandidate[]
  dropPickerOpen: boolean
  onCloseDropPicker: () => void
  detachDropConfirmOpen: boolean
  onCloseDetachDropConfirm: () => void
}

/**
 * Drop attach picker + detach confirm dialogs, moved verbatim from `$projectId.tsx`.
 * Owns `useProjectDropMutations`; a successful attach/detach closes BOTH dialogs
 * (same as the page's former inline `onSuccessClose`). The `canManageDrop` gate
 * stays on the page's trigger buttons.
 */
export function ProjectDropDialogs({
  projectId,
  currentDropDisplayName,
  dropCandidates,
  dropPickerOpen,
  onCloseDropPicker,
  detachDropConfirmOpen,
  onCloseDetachDropConfirm,
}: ProjectDropDialogsProps) {
  const { t, i18n } = useLingui()
  const { dropMutation } = useProjectDropMutations(projectId, () => {
    onCloseDropPicker()
    onCloseDetachDropConfirm()
  })

  return (
    <>
      {/* ── Drop picker dialog (attach drop) ── */}
      <Dialog open={dropPickerOpen} onOpenChange={(v) => !v && onCloseDropPicker()}>
        <CrmDialogContent maxWidth="max-w-sm" data-testid="attach-drop-dialog">
          <CrmDialogHeader>
            <DialogTitle>
              <Trans>Прив’язати дропа</Trans>
            </DialogTitle>
            <DialogDescription className="sr-only">
              <Trans>Вибір дропа для проєкту</Trans>
            </DialogDescription>
          </CrmDialogHeader>
          <CrmDialogBody>
            <ul className="max-h-72 space-y-1.5 overflow-y-auto">
              {dropCandidates.length === 0 && (
                <p className="py-2 text-sm text-muted-foreground">
                  <Trans>Немає доступних дропів</Trans>
                </p>
              )}
              {dropCandidates.map((u) => (
                <li key={u.id} className="flex items-center gap-2.5 rounded-md px-3 py-2">
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
                    variant="outline"
                    className="shrink-0 border-blue-500/30 bg-blue-500/10 text-[9px] text-blue-400"
                  >
                    {i18n._(ROLE_LABEL_MESSAGES.DROP)}
                  </Badge>
                  <Button
                    size="sm"
                    className="h-7 min-h-[44px] min-w-[72px] shrink-0 px-2.5 text-xs sm:min-h-0"
                    disabled={dropMutation.isPending}
                    onClick={() => dropMutation.mutate(u.id)}
                    aria-label={t`Призначити ${u.displayName} дропом`}
                    data-testid={`assign-drop-btn-${u.id}`}
                  >
                    {dropMutation.isPending ? t`Призначаємо…` : t`Призначити`}
                  </Button>
                </li>
              ))}
            </ul>
          </CrmDialogBody>
        </CrmDialogContent>
      </Dialog>
      {/* ── Detach drop confirm dialog ── */}
      <Dialog open={detachDropConfirmOpen} onOpenChange={(v) => !v && onCloseDetachDropConfirm()}>
        <CrmDialogContent maxWidth="sm:max-w-sm" data-testid="detach-drop-dialog">
          <CrmDialogHeader>
            <DialogTitle>
              <Trans>Відв’язати дропа?</Trans>
            </DialogTitle>
            <DialogDescription className="sr-only">
              <Trans>Підтвердження відв’язання дропа від проєкту</Trans>
            </DialogDescription>
          </CrmDialogHeader>
          <CrmDialogBody className="pb-2">
            <p className="text-sm text-muted-foreground">
              <Trans>
                <span className="font-medium text-foreground">
                  {currentDropDisplayName ?? i18n._(ROLE_LABEL_MESSAGES.DROP)}
                </span>
                : доступ до проєкту буде припинено. Гроші за проєктом більше не йтимуть через ці
                реквізити.
              </Trans>
            </p>
          </CrmDialogBody>
          <CrmDialogFooter>
            <Button variant="outline" onClick={() => onCloseDetachDropConfirm()}>
              <Trans>Скасувати</Trans>
            </Button>
            <Button
              variant="destructive"
              onClick={() => dropMutation.mutate(null)}
              disabled={dropMutation.isPending}
              data-testid="detach-drop-confirm-btn"
            >
              <Trans>Відв’язати</Trans>
            </Button>
          </CrmDialogFooter>
        </CrmDialogContent>
      </Dialog>
    </>
  )
}
