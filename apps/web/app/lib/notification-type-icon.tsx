/**
 * Per-type notification icon — extracted from `notifications-bell.tsx`
 * (task-notification-settings-ui, position 7b, `docs/design/
 * notification-settings.md` §0.7) so the bell popup and the profile
 * "Уведомления" settings tab share ONE icon mapping instead of a second
 * 10-way switch drifting out of sync with the first.
 *
 * task-notification-types-producers (позиция 6). Значок — единственная часть
 * строки, которую клиент выбирает НЕ по реестру подписей: реестр отвечает за
 * текст, здесь — за то, чтобы событие узнавалось до чтения. Неизвестный тип
 * получает нейтральный кружок, а не падение (AC2).
 */
import {
  CircleAlert,
  CircleCheck,
  CircleX,
  Circle,
  FileSignature,
  FolderPlus,
  Users,
  Wallet,
} from 'lucide-react'
import type { Notification } from '@crm/shared'

export function TypeIcon({ type }: { type: Notification['type'] }) {
  switch (type) {
    case 'INVOICE_SIGN_REQUIRED':
      return <FileSignature className="h-4 w-4 text-amber-300" />
    case 'INVOICE_SIGNED':
      return <FileSignature className="h-4 w-4 text-emerald-300" />
    case 'TRANSACTION_ADDED':
    case 'TRANSACTION_STATUS_CHANGED':
      return <Wallet className="h-4 w-4 text-sky-300" />
    case 'TEAM_MEMBER_ADDED':
    case 'TEAM_NEW_MEMBER':
      return <Users className="h-4 w-4 text-violet-300" />
    case 'PROJECT_MEMBER_ADDED':
      return <FolderPlus className="h-4 w-4 text-violet-300" />
    case 'PROJECT_CONFIRM_REQUIRED':
    case 'SHARE_CONFIRM_REQUIRED':
    case 'DOCUMENT_SIGN_REQUIRED':
      // Семейство «Ждёт решения» — один значок на все три, потому что от
      // человека во всех трёх случаях ждут одного и того же: решения.
      return <CircleAlert className="h-4 w-4 text-amber-300" />
    case 'APPROVAL_CONFIRMED':
      return <CircleCheck className="h-4 w-4 text-emerald-300" />
    case 'APPROVAL_REJECTED':
      return <CircleX className="h-4 w-4 text-rose-300" />
    default:
      return <Circle className="h-4 w-4 text-muted-foreground/60" />
  }
}
