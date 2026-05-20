import { useState } from 'react'
import { Zap, ChevronDown } from 'lucide-react'
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
import { ManageTeamDialog } from './ManageTeamDialog'
import { ReassignProjectDialog } from './ReassignProjectDialog'
import { AdminNoteDialog } from './AdminNoteDialog'
import { ArchiveUserDialog } from './ArchiveUserDialog'

type OpenDialog = ActionKey | null

const ACTION_LABELS: Record<ActionKey, string> = {
  'edit-profile': '✏️ Редактировать данные',
  'change-role': '🎭 Изменить роль',
  'change-salary': '💰 Изменить зарплату',
  'change-requisites': '🏦 Изменить реквизиты',
  'manage-team': '👥 Управление командой',
  'reassign-project': '📂 Переназначить проект',
  'set-note': '📝 Заметка админа',
  'archive': '🗑️ Архивировать',
}

const SEPARATOR_BEFORE: ActionKey[] = ['manage-team', 'set-note', 'archive']

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

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="default" size="sm" className="gap-1">
            <Zap className="h-4 w-4" />
            Действия
            <ChevronDown className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {actions.map((a) => (
            <span key={a}>
              {SEPARATOR_BEFORE.includes(a) && <DropdownMenuSeparator />}
              <DropdownMenuItem
                onClick={() => setOpen(a)}
                className={a === 'archive' ? 'text-destructive focus:text-destructive' : ''}
              >
                {ACTION_LABELS[a]}
              </DropdownMenuItem>
            </span>
          ))}
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
      {open === 'manage-team' && (
        <ManageTeamDialog userId={userId} onClose={close} />
      )}
      {open === 'reassign-project' && (
        <ReassignProjectDialog userId={userId} onClose={close} />
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
