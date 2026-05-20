import { useState } from 'react'
import {
  Zap,
  ChevronDown,
  Pencil,
  Shield,
  DollarSign,
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
import { ManageTeamDialog } from './ManageTeamDialog'
import { ReassignProjectDialog } from './ReassignProjectDialog'
import { AdminNoteDialog } from './AdminNoteDialog'
import { ArchiveUserDialog } from './ArchiveUserDialog'

type OpenDialog = ActionKey | null

const ACTION_CONFIG: Record<ActionKey, { icon: React.ReactNode; label: string }> = {
  'edit-profile': { icon: <Pencil className="mr-2 h-4 w-4" />, label: 'Редактировать данные' },
  'change-role': { icon: <Shield className="mr-2 h-4 w-4" />, label: 'Изменить роль' },
  'change-salary': { icon: <DollarSign className="mr-2 h-4 w-4" />, label: 'Изменить зарплату' },
  'change-requisites': { icon: <Wallet className="mr-2 h-4 w-4" />, label: 'Изменить реквизиты' },
  'manage-team': { icon: <Users className="mr-2 h-4 w-4" />, label: 'Управление командой' },
  'reassign-project': { icon: <FolderInput className="mr-2 h-4 w-4" />, label: 'Переназначить проект' },
  'set-note': { icon: <StickyNote className="mr-2 h-4 w-4" />, label: 'Заметка админа' },
  'archive': { icon: <Archive className="mr-2 h-4 w-4" />, label: 'Архивировать' },
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
          <Button variant="outline" size="sm" className="gap-1">
            <Zap className="h-4 w-4" />
            Действия
            <ChevronDown className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {actions.map((a) => {
            const config = ACTION_CONFIG[a]
            return (
              <span key={a}>
                {SEPARATOR_BEFORE.includes(a) && <DropdownMenuSeparator />}
                <DropdownMenuItem
                  onClick={() => setOpen(a)}
                  className={a === 'archive' ? 'text-destructive focus:text-destructive' : ''}
                >
                  {config.icon}
                  {config.label}
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
