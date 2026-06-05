import { useState } from 'react'
import { Loader2, RotateCcw, Save, CheckCheck, RefreshCw } from 'lucide-react'
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
import { Button } from '@/components/ui/button'
import type { EmployeeContractStatus } from '@crm/shared'
import { contractActionState } from './useEmployeeContract'

export interface ContractActionBarProps {
  status: EmployeeContractStatus
  isDirty: boolean
  isSaving: boolean
  onSave: () => void
  onMarkReady: () => void
  onReset: () => void
  onRevert: () => void
}

export function ContractActionBar({
  status,
  isDirty,
  isSaving,
  onSave,
  onMarkReady,
  onReset,
  onRevert,
}: ContractActionBarProps) {
  const actions = contractActionState(status)
  const [revertConfirmOpen, setRevertConfirmOpen] = useState(false)

  const handleRevertClick = () => {
    if (actions.revertDestructive) {
      setRevertConfirmOpen(true)
    } else {
      onRevert()
    }
  }

  const handleRevertConfirm = () => {
    setRevertConfirmOpen(false)
    onRevert()
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
        {actions.showSave && (
          <Button
            data-testid="contract-save-btn"
            size="sm"
            disabled={!isDirty || isSaving}
            onClick={onSave}
          >
            {isSaving ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="mr-1.5 h-3.5 w-3.5" />
            )}
            Сохранить
          </Button>
        )}

        {actions.showMarkReady && (
          <Button
            data-testid="contract-mark-ready-btn"
            size="sm"
            variant="secondary"
            onClick={onMarkReady}
          >
            <CheckCheck className="mr-1.5 h-3.5 w-3.5" />
            Отметить готовым
          </Button>
        )}

        {actions.showReset && (
          <Button data-testid="contract-reset-btn" size="sm" variant="ghost" onClick={onReset}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            Сбросить к шаблону
          </Button>
        )}

        {actions.showRevert && (
          <Button
            data-testid="contract-revert-btn"
            size="sm"
            variant={actions.revertDestructive ? 'destructive' : 'outline'}
            onClick={handleRevertClick}
          >
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
            Вернуть в черновик
          </Button>
        )}
      </div>

      {/* Confirm dialog for SIGNED revert — destructive action */}
      <AlertDialog open={revertConfirmOpen} onOpenChange={setRevertConfirmOpen}>
        <AlertDialogContent data-testid="contract-revert-confirm-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Вернуть контракт в черновик?</AlertDialogTitle>
            <AlertDialogDescription>
              Сбросит подписанный контракт и онбординг участника (удалит ToS). Участнику потребуется
              заново пройти онбординг. Продолжить?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction
              data-testid="contract-revert-confirm-ok"
              onClick={handleRevertConfirm}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Вернуть в черновик
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
