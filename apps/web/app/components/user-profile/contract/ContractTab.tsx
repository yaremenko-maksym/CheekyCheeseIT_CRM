import { useState } from 'react'
import { AlertCircle, ExternalLink, FileText, Info } from 'lucide-react'
import { Link } from '@tanstack/react-router'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  useEmployeeContract,
  useMarkContractReady,
  useResetContractToTemplate,
  useRevertContract,
  useSaveContractBody,
} from './useEmployeeContract'
import { ContractActionBar } from './ContractActionBar'
import { ContractEditor } from './ContractEditor'
import { ContractPdfPreview } from './ContractPdfPreview'
import type { EmployeeContractStatus } from '@crm/shared'

// ─── Status badge ─────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<EmployeeContractStatus, string> = {
  DRAFT: 'Черновик',
  READY_TO_SIGN: 'Готов к подписанию',
  SIGNED: 'Подписан',
  CANCELLED: 'Отменён',
}

const STATUS_VARIANTS: Record<
  EmployeeContractStatus,
  'default' | 'secondary' | 'destructive' | 'outline'
> = {
  DRAFT: 'secondary',
  READY_TO_SIGN: 'default',
  SIGNED: 'outline',
  CANCELLED: 'destructive',
}

// ─── Frozen banner messages ───────────────────────────────────────────────────

const FROZEN_BANNERS: Partial<Record<EmployeeContractStatus, string>> = {
  READY_TO_SIGN:
    'Контракт отправлен на подпись. Редактирование заблокировано. Чтобы внести правки — верните в черновик.',
  SIGNED:
    'Контракт подписан. Редактирование заблокировано. Вернуть в черновик — значит сбросить подпись и онбординг.',
}

// ─── Props ────────────────────────────────────────────────────────────────────

export interface ContractTabProps {
  userId: string
  targetRole: string
}

// ─── Component ───────────────────────────────────────────────────────────────

export function ContractTab({ userId, targetRole }: ContractTabProps) {
  const { data: contract, isLoading, error } = useEmployeeContract(userId)

  // Local editor state — tracks unsaved body changes.
  const [localBody, setLocalBody] = useState<string | null>(null)
  const [showHint, setShowHint] = useState(false)

  const saveMutation = useSaveContractBody(userId)
  const markReadyMutation = useMarkContractReady(userId)
  const revertMutation = useRevertContract(userId)
  const resetMutation = useResetContractToTemplate(userId)

  // Sync local body when contract loads (or reloads after save/reset).
  // We only initialise localBody once — subsequent invalidations re-fetch and
  // we reset localBody to null so the editor shows the server value.
  const serverBody = contract?.bodyMarkdown ?? ''
  const editorBody = localBody ?? serverBody
  const isDirty = localBody !== null && localBody !== serverBody

  const isSaving =
    saveMutation.isPending ||
    markReadyMutation.isPending ||
    revertMutation.isPending ||
    resetMutation.isPending

  // ── Loading ────────────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="space-y-4" data-testid="contract-tab-loading">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  // ── No-template 404 empty state ────────────────────────────────────────────
  // Backend returns 404 with message "No active contract template for role X"
  // when the ADMIN hasn't created a template for this role yet.

  const errorMessage =
    error && typeof error === 'object' && 'message' in error
      ? String((error as { message: unknown }).message)
      : error instanceof Error
        ? error.message
        : null

  const isNoTemplate =
    errorMessage?.toLowerCase().includes('no active contract template') ||
    errorMessage?.toLowerCase().includes('template')

  if (isNoTemplate) {
    return (
      <div
        className="flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border py-16 text-center"
        data-testid="contract-tab-no-template"
      >
        <FileText className="h-10 w-10 text-muted-foreground/40" />
        <div className="space-y-1">
          <p className="text-sm font-medium">Нет шаблона контракта для роли {targetRole}</p>
          <p className="text-xs text-muted-foreground">
            Создайте шаблон контракта для этой роли, чтобы сформировать контракт.
          </p>
        </div>
        <Button size="sm" variant="outline" asChild>
          <Link to="/crm/admin/templates/contracts" data-testid="contract-tab-template-link">
            <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
            Перейти к шаблонам
          </Link>
        </Button>
      </div>
    )
  }

  // ── Generic error ──────────────────────────────────────────────────────────

  if (error || !contract) {
    return (
      <div
        className="flex flex-col items-center justify-center gap-3 rounded-xl border border-destructive/30 bg-destructive/5 py-16 text-center"
        data-testid="contract-tab-error"
      >
        <AlertCircle className="h-8 w-8 text-destructive/60" />
        <p className="text-sm text-muted-foreground">
          {errorMessage ?? 'Не удалось загрузить контракт.'}
        </p>
      </div>
    )
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  const handleSave = () => {
    if (!isDirty) return
    saveMutation.mutate(editorBody, {
      onSuccess: () => {
        setLocalBody(null)
      },
    })
  }

  const handleMarkReady = () => {
    markReadyMutation.mutate(undefined, {
      onSuccess: () => setLocalBody(null),
    })
  }

  const handleRevert = () => {
    revertMutation.mutate(undefined, {
      onSuccess: () => setLocalBody(null),
    })
  }

  const handleReset = () => {
    resetMutation.mutate(undefined, {
      onSuccess: () => setLocalBody(null),
    })
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const readOnly = contract.status !== 'DRAFT'
  const frozenBanner = FROZEN_BANNERS[contract.status]

  return (
    <div className="space-y-6" data-testid="contract-tab">
      {/* Status header */}
      <div className="flex items-center gap-3">
        <h3 className="text-sm font-medium text-muted-foreground">Статус контракта:</h3>
        <Badge variant={STATUS_VARIANTS[contract.status]} data-testid="contract-status-badge">
          {STATUS_LABELS[contract.status]}
        </Badge>
        {isDirty && (
          <span className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
            <Info className="h-3 w-3" />
            Есть несохранённые изменения
          </span>
        )}
      </div>

      {/* Two-column layout on wide screens: editor | PDF preview */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Left: Markdown editor */}
        <ContractEditor
          value={editorBody}
          onChange={(val) => setLocalBody(val)}
          readOnly={readOnly}
          frozenBanner={frozenBanner}
          showHint={showHint}
          onToggleHint={() => setShowHint((v) => !v)}
        />

        {/* Right: PDF preview */}
        <ContractPdfPreview userId={userId} isDirty={isDirty} />
      </div>

      {/* Action bar */}
      <ContractActionBar
        status={contract.status}
        isDirty={isDirty}
        isSaving={isSaving}
        onSave={handleSave}
        onMarkReady={handleMarkReady}
        onReset={handleReset}
        onRevert={handleRevert}
      />
    </div>
  )
}
