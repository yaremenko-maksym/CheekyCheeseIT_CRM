import { Trans } from '@lingui/react/macro'
import type { UserProfileDto } from '@crm/shared'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

interface EmailChangeWarningDialogProps {
  pendingEmailChange: string | null
  editingUser: Pick<UserProfileDto, 'displayName'> | null
  originalEmail: string
  /** Cancel button: the parent reverts the form's email field and clears the pending change. */
  onCancel: () => void
  /** Confirm button: the parent keeps the new email and clears the pending change. */
  onConfirm: () => void
  /** Dismiss (Esc / overlay): the parent clears the pending change only. */
  onDismiss: () => void
}

/**
 * ut-9: Email change warning. Confirms or reverts the email field.
 * Pure move out of UserDialog — behavior unchanged. The form stays in the
 * parent: revert logic lives in the `onCancel` handler it passes down.
 */
export function EmailChangeWarningDialog({
  pendingEmailChange,
  editingUser,
  originalEmail,
  onCancel,
  onConfirm,
  onDismiss,
}: EmailChangeWarningDialogProps) {
  return (
    <AlertDialog open={!!pendingEmailChange} onOpenChange={(o) => !o && onDismiss()}>
      <AlertDialogContent data-testid="email-change-warning">
        <AlertDialogHeader>
          <AlertDialogTitle>
            <Trans>Змінити email?</Trans>
          </AlertDialogTitle>
          <AlertDialogDescription className="space-y-2">
            <span className="block">
              <Trans>
                Зміна email може розірвати вхід через Google для{' '}
                <strong>{editingUser?.displayName}</strong>. Переконайтеся, що користувач знає про
                зміну і за потреби змінить свій обліковий запис Google.
              </Trans>
            </span>
            <span className="block text-muted-foreground">
              <Trans>Старий:</Trans> <code className="px-1 rounded bg-muted">{originalEmail}</code>
              <br />
              <Trans>Новий:</Trans>{' '}
              <code className="px-1 rounded bg-muted">{pendingEmailChange}</code>
            </span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>
            <Trans>Скасувати</Trans>
          </AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} data-testid="email-change-confirm">
            <Trans>Підтвердити зміну</Trans>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
