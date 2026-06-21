import { useCallback, useEffect, useState } from 'react'
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
import { ContractFillForm } from './ContractFillForm'
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
  /**
   * Whether the current viewer can edit the contract. Only ADMIN can edit.
   * Non-ADMIN viewers (e.g. DROP self-view) see read-only PDF preview only.
   * Defaults to false for safety — callers must explicitly pass true for ADMIN.
   */
  canEdit?: boolean
  /** Called whenever the editor dirty state changes — used by parent for tab-change guard. */
  onDirtyChange?: (dirty: boolean) => void
}

// ─── Component ───────────────────────────────────────────────────────────────

export function ContractTab({
  userId,
  targetRole,
  canEdit = false,
  onDirtyChange,
}: ContractTabProps) {
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

  // Notify parent when dirty state changes (tab-change guard in UserProfileShell).
  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  // Screen 2: called by ContractFillForm after successful save + markReady.
  // Must be declared before early returns (Rules of Hooks).
  const handleFillFormReady = useCallback(() => {
    setLocalBody(null)
  }, [])

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

  // Axios wraps HTTP errors: error.message = "Request failed with status code 404".
  // The actual backend message is in error.response.data.message.
  // We check both so the component works with real AxiosErrors AND plain Errors.
  const errorMessage = (() => {
    if (!error || typeof error !== 'object') return null
    // AxiosError: response body message takes priority over the generic status message
    const axiosMsg = (error as { response?: { data?: { message?: unknown } } }).response?.data
      ?.message
    if (axiosMsg) return String(axiosMsg)
    // Fallback: plain Error.message (Zod errors, network errors, etc.)
    if ('message' in error) return String((error as { message: unknown }).message)
    return null
  })()

  // The backend returns 404 with "No active contract template for role X".
  // Use exact phrase match — avoids false positives from field names like sourceTemplateId.
  const isNoTemplate = errorMessage?.toLowerCase().includes('no active contract template') === true

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
          <Link to="/admin/contracts" data-testid="contract-tab-template-link">
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

  // ── Read-only view (non-ADMIN: DROP self-view and other viewers) ─────────────
  // Non-ADMIN callers see status header + PDF preview only.
  // ContractEditor / ContractActionBar / ContractFillForm are hidden to avoid
  // exposing mutation controls when backend already returns 403 for those ops.

  if (!canEdit) {
    return (
      <div className="space-y-6" data-testid="contract-tab-readonly">
        {/* Status header */}
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-medium text-muted-foreground">Статус контракта:</h3>
          <Badge variant={STATUS_VARIANTS[contract.status]} data-testid="contract-status-badge">
            {STATUS_LABELS[contract.status]}
          </Badge>
        </div>

        {/* PDF preview — the only affordance available to non-ADMIN viewers */}
        <ContractPdfPreview userId={userId} isDirty={false} data-testid="contract-pdf-preview" />
      </div>
    )
  }

  // ── Actions (ADMIN-only) ───────────────────────────────────────────────────

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

  // ── Render (ADMIN full editor) ────────────────────────────────────────────

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
          {...(frozenBanner !== undefined ? { frozenBanner } : {})}
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

      {/* Screen 2: variable fill form — shown only in DRAFT when body is saved */}
      {contract.status === 'DRAFT' && !isDirty && (
        <div className="border-t border-border pt-5">
          <h4 className="mb-3 text-sm font-semibold">Подготовить к подписанию</h4>
          <ContractFillForm
            userId={userId}
            savedCustomValues={(contract.customValues ?? {}) as Record<string, string>}
            onReady={handleFillFormReady}
          />
        </div>
      )}
    </div>
  )
}
