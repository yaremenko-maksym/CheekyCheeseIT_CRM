import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { lazy, Suspense, useState } from 'react'
import { api } from '@/lib/axios'
import ReactMarkdown from 'react-markdown'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

// Lazy-load CodeMirror + markdown extension — only ADMIN reaches this route.
const CodeMirrorEditor = lazy(async () => {
  const [{ default: CodeMirror }, { markdown }] = await Promise.all([
    import('@uiw/react-codemirror'),
    import('@codemirror/lang-markdown'),
  ])
  const mdExtension = markdown()
  function LazyEditor(props: React.ComponentProps<typeof CodeMirror>) {
    const extensions = [mdExtension, ...(props.extensions ?? [])]
    return <CodeMirror {...props} extensions={extensions} />
  }
  return { default: LazyEditor }
})
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { toast } from 'sonner'
import { AlertTriangle, ChevronLeft } from 'lucide-react'
import { MarkdownDiff } from '@/components/admin/MarkdownDiff'

export const Route = createFileRoute('/crm/admin/templates/tos/new')({
  component: TosNewPage,
})

interface TosVersionRow {
  id: string
  version: number
  bodyMarkdown: string
  isActive: boolean
  createdAt: string
}

function TosNewPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()

  // Pre-fill from current active version
  const { data: currentTos, isLoading } = useQuery<TosVersionRow | null>({
    queryKey: ['tos-current'],
    queryFn: async () => {
      const res = await api.get<TosVersionRow | null>('/tos/current')
      return res.data
    },
    staleTime: 60_000,
  })

  const [body, setBody] = useState<string | null>(null)
  const [showConfirm, setShowConfirm] = useState(false)

  const currentBody = body ?? currentTos?.bodyMarkdown ?? ''

  const publishMutation = useMutation({
    mutationFn: async () => {
      return api.post('/tos', { bodyMarkdown: currentBody })
    },
    onSuccess: () => {
      toast.success('Новая версия ToS опубликована. Пользователи увидят уведомление.')
      void qc.invalidateQueries({ queryKey: ['tos-current'] })
      void qc.invalidateQueries({ queryKey: ['tos-versions-all'] })
      void qc.invalidateQueries({ queryKey: ['onboarding-status'] })
      setShowConfirm(false)
      void navigate({ to: '/crm/admin/templates/tos' })
    },
    onError: () => {
      toast.error('Ошибка при публикации версии ToS')
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
            onClick={() => void navigate({ to: '/crm/admin/templates/tos' })}
            data-testid="back-button"
            aria-label="Назад к ToS"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div>
            <h2 className="text-lg font-semibold">Новая версия ToS</h2>
            <p className="text-xs text-muted-foreground">
              {currentTos
                ? `Следующая версия: v${currentTos.version + 1} (текущая — v${currentTos.version})`
                : 'Первая версия'}
            </p>
          </div>
        </div>

        <Button
          onClick={() => setShowConfirm(true)}
          disabled={publishMutation.isPending || currentBody.trim() === ''}
          data-testid="publish-tos-button"
        >
          Опубликовать
        </Button>
      </div>

      {/* Split-view editor */}
      <div className="grid grid-cols-2 gap-4" style={{ minHeight: '480px' }}>
        {/* Left: CodeMirror */}
        <div className="flex flex-col rounded-lg border border-border/60 overflow-hidden">
          <div className="border-b border-border/60 bg-muted/30 px-3 py-1.5 text-xs font-medium text-muted-foreground">
            Markdown редактор
          </div>
          <div className="flex-1 overflow-auto">
            <Suspense fallback={<Skeleton className="h-72 w-full" />}>
              <CodeMirrorEditor
                value={currentBody}
                onChange={(val) => setBody(val)}
                basicSetup={{
                  lineNumbers: true,
                  highlightActiveLineGutter: true,
                  foldGutter: false,
                  drawSelection: true,
                  syntaxHighlighting: true,
                  bracketMatching: false,
                  closeBrackets: false,
                  autocompletion: false,
                  searchKeymap: false,
                }}
                style={{ height: '100%', fontSize: '13px' }}
                data-testid="tos-editor-codemirror"
              />
            </Suspense>
          </div>
        </div>

        {/* Right: preview */}
        <div className="flex flex-col rounded-lg border border-border/60 overflow-hidden">
          <div className="border-b border-border/60 bg-muted/30 px-3 py-1.5 text-xs font-medium text-muted-foreground">
            Предпросмотр
          </div>
          <div
            className="flex-1 overflow-auto p-4 prose prose-sm dark:prose-invert max-w-none"
            data-testid="tos-editor-preview"
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
        <DialogContent data-testid="publish-tos-confirm-dialog">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              Опубликовать новую версию ToS?
            </DialogTitle>
            <DialogDescription>
              Все пользователи, уже прошедшие онбординг, увидят баннер с предложением ознакомиться с
              новой версией Terms of Service.
            </DialogDescription>
          </DialogHeader>
          <MarkdownDiff oldText={currentTos?.bodyMarkdown ?? ''} newText={currentBody} />
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
              data-testid="confirm-publish-tos-button"
            >
              {publishMutation.isPending ? 'Публикация…' : 'Опубликовать'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
