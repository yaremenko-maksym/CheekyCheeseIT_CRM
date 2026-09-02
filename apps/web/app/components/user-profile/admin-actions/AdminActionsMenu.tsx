import { Fragment, useState } from 'react'
import {
  Zap,
  ChevronDown,
  Pencil,
  StickyNote,
  Archive,
  ArchiveRestore,
  MailPlus,
  Mail,
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
import { useResendPersonalEmailInvite, useUnarchiveUser } from '@/hooks/use-user-profile'
import { UserDialog } from '@/components/users/UserDialog'
import { AdminNoteDialog } from './AdminNoteDialog'
import { ArchiveUserDialog } from './ArchiveUserDialog'
import { ChangePersonalEmailDialog } from './ChangePersonalEmailDialog'

/** Edit-related ActionKeys that collectively gate the «Редактировать» button. */
const EDIT_ACTION_KEYS: ActionKey[] = [
  'edit-profile',
  'change-role',
  'change-salary',
  'change-requisites',
]

/** Actions that get a separator rendered above them. */
const SEPARATOR_BEFORE: Array<'set-note' | 'archive'> = ['set-note', 'archive']

type OpenDialog = 'edit' | 'set-note' | 'archive' | 'change-personal-email' | null

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
  const isArchived = !!user.archivedAt
  const unarchiveMutation = useUnarchiveUser(userId, { isSenior: user.role === 'SENIOR' })
  const resendInviteMutation = useResendPersonalEmailInvite(userId)

  // Show «Редактировать» if the user has any of the edit-related action keys.
  const canEdit = EDIT_ACTION_KEYS.some((k) => actions.includes(k))
  const canSetNote = actions.includes('set-note')
  const canArchive = actions.includes('archive')
  // task-user-emails-invite (spec §5): the action key alone only says the
  // VIEWER is allowed to resend — the button itself is further gated on
  // there actually being something to resend. `personalContactVisible`
  // (UX-M-1) must be checked FIRST: without it, `personalEmailCanLogin ===
  // false` cannot be told apart from "this viewer cannot see the field at
  // all" (which is also `null`, not `false` — see that field's own doc —
  // so `=== false` alone already excludes the masked case, this check is
  // belt-and-suspenders against a future loosening of that contract).
  const canResendInvite =
    actions.includes('resend-personal-invite') &&
    user.personalContactVisible === true &&
    !!user.personalEmail &&
    user.personalEmailCanLogin === false
  // security-review PR #623 round 4, owner decision: unlike resend-invite
  // above, NOT further gated on personalEmailCanLogin — must stay usable
  // both before AND after an invite is accepted (fast fix for a typo,
  // whenever it is discovered). Still requires `personalContactVisible`
  // (the same PII-visibility gate every other personalEmail-touching
  // action in this menu already respects).
  const canChangePersonalEmail =
    actions.includes('change-personal-email') && user.personalContactVisible === true

  type MenuItem = {
    key: 'edit' | 'set-note' | 'archive' | 'resend-invite' | 'change-personal-email'
    icon: React.ReactNode
    label: string
  }
  const menuItems: MenuItem[] = []
  if (canEdit) {
    menuItems.push({
      key: 'edit',
      icon: <Pencil className="mr-2 h-4 w-4" />,
      label: 'Редактировать',
    })
  }
  if (canResendInvite) {
    menuItems.push({
      key: 'resend-invite',
      icon: <MailPlus className="mr-2 h-4 w-4" />,
      // COPY-L-1 (copy-review PR #623 round 4): was the longest item in
      // this menu by a wide margin (237px vs 103/97px for the neighbours) —
      // the item only ever shows when an invite has already been sent
      // (canResendInvite below), so "повторно/снова" carries little.
      label: 'Отправить приглашение снова',
    })
  }
  if (canChangePersonalEmail) {
    menuItems.push({
      key: 'change-personal-email',
      icon: <Mail className="mr-2 h-4 w-4" />,
      label: 'Изменить личный email',
    })
  }
  if (canSetNote) {
    menuItems.push({
      key: 'set-note',
      icon: <StickyNote className="mr-2 h-4 w-4" />,
      label: 'Заметка админа',
    })
  }
  if (canArchive && !isArchived) {
    menuItems.push({
      key: 'archive',
      icon: <Archive className="mr-2 h-4 w-4" />,
      label: 'Архивировать',
    })
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="gap-1" data-testid="admin-actions-trigger">
            <Zap className="h-4 w-4" />
            Действия
            <ChevronDown className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {menuItems.map((item) => (
            // Use `Fragment` (not `<span>`) so Radix sees DropdownMenuItem as a
            // direct child — required for arrow-key keyboard cycling.
            <Fragment key={item.key}>
              {SEPARATOR_BEFORE.includes(item.key as 'set-note' | 'archive') && (
                <DropdownMenuSeparator />
              )}
              <DropdownMenuItem
                data-testid={
                  item.key === 'resend-invite'
                    ? 'admin-actions-resend-invite'
                    : item.key === 'change-personal-email'
                      ? 'admin-actions-change-personal-email'
                      : undefined
                }
                disabled={item.key === 'resend-invite' && resendInviteMutation.isPending}
                onClick={() =>
                  item.key === 'resend-invite' ? resendInviteMutation.mutate() : setOpen(item.key)
                }
                className={item.key === 'archive' ? 'text-destructive focus:text-destructive' : ''}
              >
                {item.icon}
                {item.label}
              </DropdownMenuItem>
            </Fragment>
          ))}
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

      {open === 'edit' && <UserDialog mode="edit" user={user} onClose={close} />}
      {open === 'set-note' && (
        <AdminNoteDialog userId={userId} currentNote={user.adminNote} onClose={close} />
      )}
      {open === 'archive' && <ArchiveUserDialog user={user} onClose={close} />}
      {open === 'change-personal-email' && (
        <ChangePersonalEmailDialog
          userId={userId}
          currentEmail={user.personalEmail ?? null}
          workEmail={user.email}
          onClose={close}
        />
      )}
    </>
  )
}
