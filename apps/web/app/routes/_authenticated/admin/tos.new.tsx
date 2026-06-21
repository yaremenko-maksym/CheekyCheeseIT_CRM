import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { lazy, Suspense, useState } from 'react'
import { api } from '@/lib/axios'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button } from '@/components/ui/button'
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
import { AlertTriangle, ChevronLeft, Eye } from 'lucide-react'
import { MarkdownDiff } from '@/components/admin/MarkdownDiff'

// Lazy-load CodeMirror + markdown extension + dark theme — only ADMIN reaches this route.
const CodeMirrorEditor = lazy(async () => {
  const [{ default: CodeMirror }, { markdown }, { oneDark }] = await Promise.all([
    import('@uiw/react-codemirror'),
    import('@codemirror/lang-markdown'),
    import('@codemirror/theme-one-dark'),
  ])
  const mdExtension = markdown()
  function LazyEditor(props: React.ComponentProps<typeof CodeMirror>) {
    const extensions = [mdExtension, ...(props.extensions ?? [])]
    return <CodeMirror theme={oneDark} {...props} extensions={extensions} />
  }
  return { default: LazyEditor }
})

export const Route = createFileRoute('/_authenticated/admin/tos/new')({
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
  const [showPreview, setShowPreview] = useState(false)

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
      void navigate({ to: '/admin/tos' })
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
        <Skeleton className="h-[520px]" />
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
            onClick={() => void navigate({ to: '/admin/tos' })}
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

        <div className="flex items-center gap-2">
          {/* Preview button → opens modal */}
          <Button
            variant="outline"
            onClick={() => setShowPreview(true)}
            disabled={currentBody.trim() === ''}
            data-testid="preview-tos-button"
          >
            <Eye className="mr-1.5 h-4 w-4" />
            Предпросмотр
          </Button>
          <Button
            onClick={() => setShowConfirm(true)}
            disabled={publishMutation.isPending || currentBody.trim() === ''}
            data-testid="publish-tos-button"
          >
            Опубликовать
          </Button>
        </div>
      </div>

      {/* Full-width CodeMirror editor */}
      <div
        className="flex flex-col rounded-lg border border-border/60 overflow-hidden"
        data-testid="tos-editor-wrapper"
      >
        <div className="border-b border-border/60 bg-muted/30 px-3 py-1.5 text-xs font-medium text-muted-foreground">
          Markdown редактор
        </div>
        <div className="overflow-hidden">
          <Suspense fallback={<Skeleton className="h-[520px] w-full" />}>
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
              style={{ height: '520px', fontSize: '13px' }}
              data-testid="tos-editor-codemirror"
            />
          </Suspense>
        </div>
      </div>

      {/* Preview modal — GFM-rendered document view */}
      <Dialog open={showPreview} onOpenChange={setShowPreview}>
        <DialogContent
          className="max-w-4xl w-full"
          style={{ maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}
          data-testid="preview-tos-dialog"
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Eye className="h-4 w-4" />
              Предпросмотр ToS
            </DialogTitle>
            <DialogDescription>
              Финальный вид документа Terms of Service для пользователей.
            </DialogDescription>
          </DialogHeader>

          {/* Scrollable document container */}
          <div className="flex-1 overflow-y-auto min-h-0 py-2">
            <div
              className="mx-auto bg-white dark:bg-zinc-950 rounded-lg border border-border/40 shadow-sm"
              style={{ maxWidth: '680px', padding: '56px 64px', minHeight: '900px' }}
              data-testid="preview-tos-dialog-document"
            >
              {currentBody.trim() ? (
                <div className="prose prose-sm dark:prose-invert max-w-none [&_table]:border-collapse [&_td]:border [&_td]:border-border/60 [&_td]:px-3 [&_td]:py-1.5 [&_th]:border [&_th]:border-border/60 [&_th]:px-3 [&_th]:py-1.5 [&_th]:bg-muted/40">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{currentBody}</ReactMarkdown>
                </div>
              ) : (
                <p className="text-muted-foreground italic">Редактор пуст.</p>
              )}
            </div>
          </div>

          <DialogFooter className="pt-2 border-t border-border/40">
            <Button
              variant="outline"
              onClick={() => setShowPreview(false)}
              data-testid="preview-tos-dialog-close"
            >
              Закрыть
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Publish confirmation dialog */}
      <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
        <DialogContent data-testid="publish-tos-confirm-dialog">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              Опубликовать новую версию ToS (v{(currentTos?.version ?? 0) + 1})?
            </DialogTitle>
            <DialogDescription>
              Текущая версия ToS будет деактивирована (сохранится в истории). Все пользователи
              должны будут принять новую версию Terms of Service заново.
            </DialogDescription>
          </DialogHeader>
          <MarkdownDiff oldText={currentTos?.bodyMarkdown ?? ''} newText={currentBody} />
          <DialogFooter>
            <Button
              variant="ghost"
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
