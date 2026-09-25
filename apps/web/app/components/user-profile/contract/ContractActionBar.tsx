import { useState } from 'react'
import { Loader2, RotateCcw, Save, CheckCheck, RefreshCw } from 'lucide-react'
import { Trans } from '@lingui/react/macro'
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
            <Trans>Зберегти</Trans>
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
            <Trans>Позначити готовим</Trans>
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
            <Trans>Скинути до шаблону</Trans>
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
            <Trans>Повернути в чернетку</Trans>
          </Button>
        )}
      </div>

      {/* Confirm dialog for revert — text depends on destructiveness (SIGNED vs READY_TO_SIGN) */}
      <AlertDialog open={revertConfirmOpen} onOpenChange={setRevertConfirmOpen}>
        <AlertDialogContent data-testid="contract-revert-confirm-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {actions.revertDestructive ? (
                <Trans>Повернути підписаний контракт у чернетку?</Trans>
              ) : (
                <Trans>Повернути контракт у чернетку?</Trans>
              )}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {actions.revertDestructive ? (
                <Trans>
                  Це скине підпис і онбординг співробітника (видалить прийняття Умов використання) —
                  дію не можна скасувати
                </Trans>
              ) : (
                <Trans>
                  Співробітник не зможе підписати, поки ви знову не позначите контракт готовим до
                  підписання
                </Trans>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <Trans>Скасувати</Trans>
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="contract-revert-confirm-ok"
              onClick={handleRevertConfirm}
              className={
                actions.revertDestructive
                  ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                  : undefined
              }
            >
              <Trans>Повернути в чернетку</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Confirm dialog for reset to template */}
      <AlertDialog open={resetConfirmOpen} onOpenChange={setResetConfirmOpen}>
        <AlertDialogContent data-testid="contract-reset-confirm-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Скинути контракт до шаблону?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>Ваші правки в тексті контракту буде замінено актуальним шаблоном</Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <Trans>Скасувати</Trans>
            </AlertDialogCancel>
            <AlertDialogAction data-testid="contract-reset-confirm-ok" onClick={handleResetConfirm}>
              <Trans>Скинути</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
