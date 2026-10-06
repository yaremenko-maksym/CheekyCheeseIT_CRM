import { Trans, useLingui } from '@lingui/react/macro'
import type { Role } from '@crm/shared'
import { cn } from '@/lib/utils'
import { getInitialsBySpaceSplit } from '@/lib/initials'
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
import type { UserOption } from '../api'

export type CandidateUser = UserOption & { disabledReason?: string }

/**
 * Presentational "Add member" dialog. Eligibility (`candidateUsers`) and the
 * add mutation are computed/owned by the page root: this component can only
 * offer what the root passed in and reports intent via callbacks.
 */
export function AddMemberDialog({
  open,
  onOpenChange,
  candidateUsers,
  selectedUserIds,
  onToggle,
  onSubmit,
  isPending,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  candidateUsers: CandidateUser[]
  selectedUserIds: Set<string>
  onToggle: (userId: string) => void
  onSubmit: () => void
  isPending: boolean
}) {
  const { t, i18n } = useLingui()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <CrmDialogContent>
        <CrmDialogHeader>
          <DialogTitle>
            <Trans>Додати учасника</Trans>
          </DialogTitle>
          <DialogDescription className="sr-only">
            <Trans>Оберіть, кого додати до команди.</Trans>
          </DialogDescription>
        </CrmDialogHeader>
        <CrmDialogBody>
          <div className="space-y-1.5 max-h-80 overflow-y-auto pr-1">
            {candidateUsers.length === 0 && (
              <p className="py-4 text-center text-sm text-muted-foreground">
                <Trans>Немає користувачів, яких можна додати</Trans>
              </p>
            )}
            {candidateUsers.map((u, idx) => {
              const isDisabled = !!u.disabledReason
              const isSelected = selectedUserIds.has(u.id)
              const prevDisabled = idx > 0 && !!candidateUsers[idx - 1]?.disabledReason
              const showDivider = isDisabled && !prevDisabled && idx > 0
              return (
                <div key={u.id}>
                  {showDivider && <div className="my-2 border-t border-border/50" />}
                  <button
                    type="button"
                    disabled={isDisabled}
                    onClick={() => {
                      if (isDisabled) return
                      onToggle(u.id)
                    }}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors',
                      isDisabled
                        ? 'cursor-not-allowed opacity-35'
                        : isSelected
                          ? 'bg-primary/10'
                          : 'hover:bg-muted/50',
                    )}
                  >
                    {!isDisabled && (
                      <div
                        className={cn(
                          'h-4 w-4 shrink-0 rounded border',
                          isSelected
                            ? 'border-primary bg-primary flex items-center justify-center'
                            : 'border-border',
                        )}
                      >
                        {isSelected && (
                          <span className="text-[10px] text-primary-foreground font-bold">✓</span>
                        )}
                      </div>
                    )}
                    {isDisabled && <div className="h-4 w-4 shrink-0" />}
                    <Avatar className="h-6 w-6 shrink-0">
                      {u.avatarUrl && <AvatarImage src={u.avatarUrl} alt={u.displayName} />}
                      <AvatarFallback className="text-[9px]">
                        {getInitialsBySpaceSplit(u.displayName)}
                      </AvatarFallback>
                    </Avatar>
                    <span className="flex-1 truncate text-sm">{u.displayName}</span>
                    <Badge variant="outline" className="text-[10px] shrink-0">
                      {i18n._(ROLE_LABEL_MESSAGES[u.role as Role])}
                    </Badge>
                    {u.disabledReason && (
                      <span className="text-[10px] text-muted-foreground shrink-0">
                        {u.disabledReason}
                      </span>
                    )}
                  </button>
                </div>
              )
            })}
          </div>
        </CrmDialogBody>
        <CrmDialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            <Trans>Скасувати</Trans>
          </Button>
          <Button disabled={selectedUserIds.size === 0 || isPending} onClick={onSubmit}>
            {selectedUserIds.size > 0 ? t`Додати (${selectedUserIds.size})` : t`Додати`}
          </Button>
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}
