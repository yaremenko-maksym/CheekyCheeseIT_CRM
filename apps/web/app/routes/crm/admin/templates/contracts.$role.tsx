import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '@/lib/axios'
import { contractTargetRoleSchema } from '@crm/shared'
import type { ContractTargetRole } from '@crm/shared'
import { CONTRACT_VARIABLES } from '@/lib/contract-variables'
import CodeMirror from '@uiw/react-codemirror'
import { markdown } from '@codemirror/lang-markdown'
import ReactMarkdown from 'react-markdown'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { toast } from 'sonner'
import { AlertTriangle, ChevronLeft, Info } from 'lucide-react'

export const Route = createFileRoute('/crm/admin/templates/contracts/$role')({
  component: ContractEditorPage,
})

interface ContractTemplateRow {
  id: string
  targetRole: ContractTargetRole
  version: number
  bodyMarkdown: string
  isActive: boolean
  createdAt: string
}

const ROLE_LABELS: Record<ContractTargetRole, string> = {
  HR: 'HR-менеджер',
  SENIOR: 'Синьор',
  JUNIOR: 'Джун',
  DROP: 'Дроп',
  ACCOUNTANT: 'Бухгалтер',
}

function ContractEditorPage() {
  const { role: roleParam } = Route.useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()

  // Parse role from URL param (lowercase) → enum value (uppercase)
  const roleUpper = roleParam.toUpperCase()
  const parsed = contractTargetRoleSchema.safeParse(roleUpper)

  // If invalid role in URL → redirect back
  if (!parsed.success) {
    void navigate({ to: '/crm/admin/templates/contracts' })
    return null
  }

  const role = parsed.data

  const { data: template, isLoading } = useQuery<ContractTemplateRow | null>({
    queryKey: ['contract-template', role],
    queryFn: async () => {
      const res = await api.get<ContractTemplateRow | null>(`/contracts/templates/current/${role}`)
      return res.data
    },
    staleTime: 30_000,
  })

  const [body, setBody] = useState<string | null>(null)
  const [showConfirm, setShowConfirm] = useState(false)
  const [showHint, setShowHint] = useState(false)

  // On first load, init editor from template
  const currentBody = body ?? template?.bodyMarkdown ?? ''

  const publishMutation = useMutation({
    mutationFn: async () => {
      return api.post('/contracts/templates', {
        targetRole: role,
        bodyMarkdown: currentBody,
      })
    },
    onSuccess: () => {
      toast.success(`Шаблон для роли ${ROLE_LABELS[role]} опубликован`)
      // Invalidate so lists and onboarding page see the new version
      void qc.invalidateQueries({ queryKey: ['contract-templates-all'] })
      void qc.invalidateQueries({ queryKey: ['contract-template', role] })
      setShowConfirm(false)
    },
    onError: () => {
      toast.error('Ошибка при публикации шаблона')
      setShowConfirm(false)
    },
  })

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-2 gap-4">
          <Skeleton className="h-96" />
          <Skeleton className="h-96" />
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void navigate({ to: '/crm/admin/templates/contracts' })}
            data-testid="back-button"
            aria-label="Назад к списку"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div>
            <h2 className="text-lg font-semibold">
              Редактор: <span className="text-primary">{ROLE_LABELS[role]}</span>
            </h2>
            {template && (
              <p className="text-xs text-muted-foreground">Текущая версия: v{template.version}</p>
            )}
          </div>
          <Badge variant="outline">{role}</Badge>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setShowHint(!showHint)}
            aria-label="Подсказка переменных"
            data-testid="variables-hint-toggle"
          >
            <Info className="h-4 w-4" />
          </Button>
          <Button
            onClick={() => setShowConfirm(true)}
            disabled={publishMutation.isPending || currentBody.trim() === ''}
            data-testid="publish-template-button"
          >
            Опубликовать
          </Button>
        </div>
      </div>

      {/* Variables hint panel */}
      {showHint && (
        <div
          className="rounded-lg border border-border/60 bg-muted/40 p-4"
          data-testid="variables-hint-panel"
        >
          <p className="mb-2 text-sm font-medium">Доступные переменные</p>
          <div className="grid gap-1 sm:grid-cols-2">
            {Object.entries(CONTRACT_VARIABLES).map(([variable, description]) => (
              <div key={variable} className="flex items-start gap-2 text-xs">
                <code className="shrink-0 rounded bg-primary/10 px-1 py-0.5 font-mono text-primary">
                  {variable}
                </code>
                <span className="text-muted-foreground">{description}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Split-view editor */}
      <div className="grid grid-cols-2 gap-4" style={{ minHeight: '480px' }}>
        {/* Left: CodeMirror editor */}
        <div className="flex flex-col rounded-lg border border-border/60 overflow-hidden">
          <div className="border-b border-border/60 bg-muted/30 px-3 py-1.5 text-xs font-medium text-muted-foreground">
            Markdown редактор
          </div>
          <div className="flex-1 overflow-auto">
            <CodeMirror
              value={currentBody}
              onChange={(val) => setBody(val)}
              extensions={[markdown()]}
              basicSetup={{
                lineNumbers: true,
                highlightActiveLineGutter: true,
                highlightSpecialChars: true,
                foldGutter: false,
                drawSelection: true,
                dropCursor: true,
                allowMultipleSelections: false,
                indentOnInput: false,
                syntaxHighlighting: true,
                bracketMatching: false,
                closeBrackets: false,
                autocompletion: false,
                rectangularSelection: false,
                crosshairCursor: false,
                highlightActiveLine: true,
                highlightSelectionMatches: false,
                closeBracketsKeymap: false,
                searchKeymap: false,
              }}
              style={{ height: '100%', fontSize: '13px' }}
              data-testid="contract-editor-codemirror"
            />
          </div>
        </div>

        {/* Right: live Markdown preview */}
        <div className="flex flex-col rounded-lg border border-border/60 overflow-hidden">
          <div className="border-b border-border/60 bg-muted/30 px-3 py-1.5 text-xs font-medium text-muted-foreground">
            Предпросмотр
          </div>
          <div
            className="flex-1 overflow-auto p-4 prose prose-sm dark:prose-invert max-w-none"
            data-testid="contract-editor-preview"
          >
            {currentBody.trim() ? (
              <ReactMarkdown>{currentBody}</ReactMarkdown>
            ) : (
              <p className="text-muted-foreground italic">Начните вводить текст в редакторе…</p>
            )}
          </div>
        </div>
      </div>

      {/* Confirmation dialog */}
      <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
        <DialogContent data-testid="publish-confirm-dialog">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              Опубликовать новую версию?
            </DialogTitle>
            <DialogDescription>
              Шаблон для роли <strong>{ROLE_LABELS[role]}</strong> будет обновлён. Новые сотрудники
              увидят новый текст при следующем онбординге.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowConfirm(false)}
              data-testid="cancel-button"
            >
              Отмена
            </Button>
            <Button
              onClick={() => publishMutation.mutate()}
              disabled={publishMutation.isPending}
              data-testid="confirm-publish-button"
            >
              {publishMutation.isPending ? 'Публикация…' : 'Опубликовать'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
