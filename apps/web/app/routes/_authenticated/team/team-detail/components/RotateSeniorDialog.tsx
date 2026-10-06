import { RefreshCw } from 'lucide-react'
import { Trans, useLingui } from '@lingui/react/macro'
import { getInitialsBySpaceSplit } from '@/lib/initials'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
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
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { UserOption } from '../api'

/**
 * Presentational "Rotate senior" dialog. SECURITY-SENSITIVE: submitting it
 * reassigns the SENIOR role / team ownership. The vacant-senior eligibility
 * computation (`vacantSeniors`), the `allTeamsForRotate` query and the rotate
 * mutation all stay in the page root; this component only lists the
 * candidates it is handed and forwards selection / submit through callbacks.
 */
export function RotateSeniorDialog({
  open,
  onOpenChange,
  activeSenior,
  vacantSeniors,
  newSeniorId,
  onSelect,
  onSubmit,
  isPending,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  activeSenior: { displayName: string } | null
  vacantSeniors: UserOption[]
  newSeniorId: string
  onSelect: (id: string) => void
  onSubmit: () => void
  isPending: boolean
}) {
  const { t } = useLingui()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <CrmDialogContent data-testid="team-rotate-senior-dialog">
        <CrmDialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RefreshCw className="h-4 w-4" />
            {activeSenior ? t`Змінити сеньйора` : t`Призначити сеньйора`}
          </DialogTitle>
          <DialogDescription className="sr-only">
            <Trans>Оберіть сеньйора для команди.</Trans>
          </DialogDescription>
          <p className="text-xs text-muted-foreground mt-1">
            {activeSenior
              ? t`Поточного сеньйора «${activeSenior.displayName}» буде знято з команди. Новий сеньйор має бути без активної команди.`
              : t`Оберіть сеньйора без активної команди. Дроп та інші учасники команди залишаються.`}
          </p>
        </CrmDialogHeader>
        <CrmDialogBody className="space-y-3">
          <div className="grid gap-1.5">
            <Label>
              <Trans>Новий сеньйор</Trans>
            </Label>
            {vacantSeniors.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">
                <Trans>Немає сеньйорів без активної команди</Trans>
              </p>
            ) : (
              <Select value={newSeniorId} onValueChange={onSelect}>
                <SelectTrigger data-testid="team-rotate-senior-select">
                  <SelectValue placeholder={t`— оберіть сеньйора —`} />
                </SelectTrigger>
                <SelectContent>
                  {vacantSeniors.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      <div className="flex items-center gap-2">
                        <Avatar className="h-5 w-5">
                          {s.avatarUrl && <AvatarImage src={s.avatarUrl} alt={s.displayName} />}
                          <AvatarFallback className="text-[9px]">
                            {getInitialsBySpaceSplit(s.displayName)}
                          </AvatarFallback>
                        </Avatar>
                        <span>{s.displayName}</span>
                        <span className="text-[10px] text-muted-foreground">{s.email}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        </CrmDialogBody>
        <CrmDialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            <Trans>Скасувати</Trans>
          </Button>
          <Button
            disabled={!newSeniorId || isPending}
            onClick={onSubmit}
            data-testid="team-rotate-senior-submit"
          >
            {isPending ? t`Зберігаємо…` : activeSenior ? t`Змінити` : t`Призначити`}
          </Button>
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}
