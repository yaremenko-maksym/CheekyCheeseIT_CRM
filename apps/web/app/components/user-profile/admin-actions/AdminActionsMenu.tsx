import { Fragment, useState } from 'react'
import {
  Zap,
  ChevronDown,
  Pencil,
  Shield,
  DollarSign,
  Percent,
  Wallet,
  StickyNote,
  Archive,
  ArchiveRestore,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { ActionKey, UserProfileDto } from '@crm/shared'
import { useUnarchiveUser } from '@/hooks/use-user-profile'
import { EditProfileDialog } from './EditProfileDialog'
import { ChangeRoleDialog } from './ChangeRoleDialog'
import { ChangeSalaryDialog } from './ChangeSalaryDialog'
import { ChangeRequisitesDialog } from './ChangeRequisitesDialog'
import { AdminNoteDialog } from './AdminNoteDialog'
import { ArchiveUserDialog } from './ArchiveUserDialog'

/** Client-side synthetic action: rendered only when `user.archivedAt` is set. */
type OpenDialog = ActionKey | 'unarchive' | null

function buildActionConfig(role: string): Record<ActionKey, { icon: React.ReactNode; label: string }> {
  const isShareRole = role === 'SENIOR' || role === 'ADMIN'
  return {
    'edit-profile': { icon: <Pencil className="mr-2 h-4 w-4" />, label: 'Редактировать данные' },
    'change-role': { icon: <Shield className="mr-2 h-4 w-4" />, label: 'Изменить роль' },
    'change-salary': isShareRole
      ? { icon: <Percent className="mr-2 h-4 w-4" />, label: 'Изменить долю %' }
      : { icon: <DollarSign className="mr-2 h-4 w-4" />, label: 'Изменить зарплату' },
    'change-requisites': { icon: <Wallet className="mr-2 h-4 w-4" />, label: 'Изменить реквизиты' },
    'set-note': { icon: <StickyNote className="mr-2 h-4 w-4" />, label: 'Заметка админа' },
    'archive': { icon: <Archive className="mr-2 h-4 w-4" />, label: 'Архивировать' },
  }
}

const SEPARATOR_BEFORE: ActionKey[] = ['set-note', 'archive']

export function AdminActionsMenu({
  userId,
  user,
  actions,
}: {
  userId: string
  user: UserProfileDto
  actions: ActionKey[]
}) {
  const [open, setOpen] = useState<OpenDialog>(null)
  const close = () => setOpen(null)
  const actionConfig = buildActionConfig(user.role)
  const isArchived = !!user.archivedAt
  const unarchiveMutation = useUnarchiveUser(userId, { isSenior: user.role === 'SENIOR' })

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="gap-1"
            data-testid="admin-actions-trigger"
          >
            <Zap className="h-4 w-4" />
            Действия
            <ChevronDown className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {actions.map((a) => {
            // For archived users hide normal "archive" action — show unarchive instead below
            if (a === 'archive' && isArchived) return null
            const config = actionConfig[a]
            // Use `Fragment` (not `<span>`) so Radix sees DropdownMenuItem as a
            // direct child — required for arrow-key keyboard cycling.
            return (
              <Fragment key={a}>
                {SEPARATOR_BEFORE.includes(a) && <DropdownMenuSeparator />}
                <DropdownMenuItem
                  onClick={() => setOpen(a)}
                  className={a === 'archive' ? 'text-destructive focus:text-destructive' : ''}
                >
                  {config.icon}
                  {config.label}
                </DropdownMenuItem>
              </Fragment>
            )
          })}
          {isArchived && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                data-testid="admin-actions-unarchive"
                onClick={() => unarchiveMutation.mutate()}
                disabled={unarchiveMutation.isPending}
                className="text-primary focus:text-primary"
              >
                <ArchiveRestore className="mr-2 h-4 w-4" />
                Восстановить из архива
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {open === 'edit-profile' && (
        <EditProfileDialog userId={userId} user={user} onClose={close} />
      )}
      {open === 'change-role' && (
        <ChangeRoleDialog userId={userId} currentRole={user.role} onClose={close} />
      )}
      {open === 'change-salary' && (
        <ChangeSalaryDialog userId={userId} user={user} onClose={close} />
      )}
      {open === 'change-requisites' && (
        <ChangeRequisitesDialog userId={userId} user={user} onClose={close} />
      )}
      {open === 'set-note' && (
        <AdminNoteDialog userId={userId} currentNote={user.adminNote} onClose={close} />
      )}
      {open === 'archive' && (
        <ArchiveUserDialog userId={userId} userName={user.displayName} onClose={close} />
      )}
    </>
  )
}
