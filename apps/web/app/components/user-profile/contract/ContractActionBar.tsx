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
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false)

  // Always show confirm dialog before any revert (both READY_TO_SIGN and SIGNED)
  const handleRevertClick = () => {
    setRevertConfirmOpen(true)
  }

  const handleRevertConfirm = () => {
    setRevertConfirmOpen(false)
    onRevert()
  }

  const handleResetClick = () => {
    setResetConfirmOpen(true)
  }

  const handleResetConfirm = () => {
    setResetConfirmOpen(false)
    onReset()
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
            data-track="contract-sign-prep"
            size="sm"
            variant="secondary"
            onClick={onMarkReady}
          >
            <CheckCheck className="mr-1.5 h-3.5 w-3.5" />
            Отметить готовым
          </Button>
        )}

        {actions.showReset && (
          <Button
            data-testid="contract-reset-btn"
            size="sm"
            variant="ghost"
            onClick={handleResetClick}
          >
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

      {/* Confirm dialog for revert — text depends on destructiveness (SIGNED vs READY_TO_SIGN) */}
      <AlertDialog open={revertConfirmOpen} onOpenChange={setRevertConfirmOpen}>
        <AlertDialogContent data-testid="contract-revert-confirm-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {actions.revertDestructive
                ? 'Вернуть подписанный контракт в черновик?'
                : 'Вернуть контракт в черновик?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {actions.revertDestructive
                ? 'Это сбросит подпись и онбординг участника (удалит ToS). Действие необратимо.'
                : 'Участник не сможет подписать, пока вы снова не отметите контракт готовым к подписанию.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction
              data-testid="contract-revert-confirm-ok"
              onClick={handleRevertConfirm}
              className={
                actions.revertDestructive
                  ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                  : undefined
              }
            >
              Вернуть в черновик
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Confirm dialog for reset to template */}
      <AlertDialog open={resetConfirmOpen} onOpenChange={setResetConfirmOpen}>
        <AlertDialogContent data-testid="contract-reset-confirm-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Сбросить контракт к шаблону?</AlertDialogTitle>
            <AlertDialogDescription>
              Текущие изменения тела будут заменены актуальным шаблоном.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction data-testid="contract-reset-confirm-ok" onClick={handleResetConfirm}>
              Сбросить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
