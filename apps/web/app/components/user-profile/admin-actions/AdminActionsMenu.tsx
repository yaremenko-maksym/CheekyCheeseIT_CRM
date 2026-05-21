import { useState } from 'react'
import {
  Zap,
  ChevronDown,
  Pencil,
  Shield,
  DollarSign,
  Percent,
  Wallet,
  Users,
  FolderInput,
  StickyNote,
  Archive,
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
import { EditProfileDialog } from './EditProfileDialog'
import { ChangeRoleDialog } from './ChangeRoleDialog'
import { ChangeSalaryDialog } from './ChangeSalaryDialog'
import { ChangeRequisitesDialog } from './ChangeRequisitesDialog'
// ManageTeamDialog and ReassignProjectDialog: kept on disk but not wired — the
// backend endpoints return 501 (NotImplementedException) until follow-up work
// implements actual DB mutations.
import { AdminNoteDialog } from './AdminNoteDialog'
import { ArchiveUserDialog } from './ArchiveUserDialog'

type OpenDialog = ActionKey | null

function buildActionConfig(role: string): Record<ActionKey, { icon: React.ReactNode; label: string }> {
  const isShareRole = role === 'SENIOR' || role === 'ADMIN'
  return {
    'edit-profile': { icon: <Pencil className="mr-2 h-4 w-4" />, label: 'Редактировать данные' },
    'change-role': { icon: <Shield className="mr-2 h-4 w-4" />, label: 'Изменить роль' },
    'change-salary': isShareRole
      ? { icon: <Percent className="mr-2 h-4 w-4" />, label: 'Изменить долю %' }
      : { icon: <DollarSign className="mr-2 h-4 w-4" />, label: 'Изменить зарплату' },
    'change-requisites': { icon: <Wallet className="mr-2 h-4 w-4" />, label: 'Изменить реквизиты' },
    'manage-team': { icon: <Users className="mr-2 h-4 w-4" />, label: 'Управление командой' },
    'reassign-project': { icon: <FolderInput className="mr-2 h-4 w-4" />, label: 'Переназначить проект' },
    'set-note': { icon: <StickyNote className="mr-2 h-4 w-4" />, label: 'Заметка админа' },
    'archive': { icon: <Archive className="mr-2 h-4 w-4" />, label: 'Архивировать' },
  }
}

const SEPARATOR_BEFORE: ActionKey[] = ['manage-team', 'set-note', 'archive']

/**
 * Actions whose backend endpoints are not implemented yet (return 501).
 * Shown disabled in the menu with a "скоро" hint instead of being hidden,
 * so admins know the capability is planned.
 */
const NOT_IMPLEMENTED: ActionKey[] = ['manage-team', 'reassign-project']

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

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="gap-1">
            <Zap className="h-4 w-4" />
            Действия
            <ChevronDown className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {actions.map((a) => {
            const config = actionConfig[a]
            const disabled = NOT_IMPLEMENTED.includes(a)
            return (
              <span key={a}>
                {SEPARATOR_BEFORE.includes(a) && <DropdownMenuSeparator />}
                <DropdownMenuItem
                  onClick={() => { if (!disabled) setOpen(a) }}
                  disabled={disabled}
                  className={a === 'archive' ? 'text-destructive focus:text-destructive' : ''}
                  title={disabled ? 'Скоро будет доступно' : undefined}
                >
                  {config.icon}
                  {config.label}
                  {disabled && (
                    <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground">
                      скоро
                    </span>
                  )}
                </DropdownMenuItem>
              </span>
            )
          })}
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
      {/* manage-team and reassign-project are not implemented yet — backend returns 501. */}
      {/* Dialogs intentionally not rendered while NOT_IMPLEMENTED includes these keys. */}
      {open === 'set-note' && (
        <AdminNoteDialog userId={userId} currentNote={user.adminNote} onClose={close} />
      )}
      {open === 'archive' && (
        <ArchiveUserDialog userId={userId} userName={user.displayName} onClose={close} />
      )}
    </>
  )
}
