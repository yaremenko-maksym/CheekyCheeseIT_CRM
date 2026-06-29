import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '@/lib/axios'
import { contractTargetRoleSchema, CONTRACT_VARIABLE_DESCRIPTIONS } from '@crm/shared'
import type { ContractTargetRole, ContractTemplateRow, CustomVariable } from '@crm/shared'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
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
import { AlertTriangle, ChevronLeft, Eye } from 'lucide-react'
const MarkdownDiff = lazy(() =>
  import('@/components/admin/MarkdownDiff').then((m) => ({ default: m.MarkdownDiff })),
)
import { VariablesPanel } from '@/components/contracts/VariablesPanel'
import {
  buildTokenHighlightExtension,
  injectTokenHighlightStyles,
} from '@/components/contracts/contractTokenHighlight'
import { PdfPreview } from '@/components/documents/pdf-preview'
import type { EditorView } from '@uiw/react-codemirror'

export const Route = createFileRoute('/_authenticated/admin/contracts/$role')({
  component: ContractEditorPage,
})

// Lazy-load CodeMirror + markdown extension + dark theme — heavy deps (~500 KB gzip) loaded
// only when ADMIN navigates to the editor route. React.lazy requires a module
// with a `.default` export, so we wrap the dynamic import in a thin adapter.
const CodeMirrorEditor = lazy(async () => {
  const [{ default: CodeMirror }, { markdown }, { oneDark }] = await Promise.all([
    import('@uiw/react-codemirror'),
    import('@codemirror/lang-markdown'),
    import('@codemirror/theme-one-dark'),
  ])
  const mdExtension = markdown()
  function LazyEditor(
    props: React.ComponentProps<typeof CodeMirror> & {
      editorViewRef?: React.Ref<EditorView | null>
    },
  ) {
    const { editorViewRef, ...rest } = props
    const extensions = [mdExtension, ...(rest.extensions ?? [])]
    return (
      <CodeMirror
        theme={oneDark}
        {...rest}
        extensions={extensions}
        onCreateEditor={(view, state) => {
          if (editorViewRef && typeof editorViewRef === 'object') {
            ;(editorViewRef as React.MutableRefObject<EditorView | null>).current = view
          }
          rest.onCreateEditor?.(view, state)
        }}
      />
    )
  }
  return { default: LazyEditor }
})

const ROLE_LABELS: Record<ContractTargetRole, string> = {
  HR: 'HR-менеджер',
  SENIOR: 'Синьор',
  JUNIOR: 'Джун',
  DROP: 'Дроп',
  ACCOUNTANT: 'Бухгалтер',
}

const SYSTEM_KEYS = new Set(Object.keys(CONTRACT_VARIABLE_DESCRIPTIONS))
const TOKEN_SPLIT_RE = /(\{\{[a-zA-Z0-9_]+\}\})/g

/**
 * Split a plain-text string on {{...}} tokens and return an array of React
 * nodes. Custom tokens are replaced with their value text; system and unknown
 * tokens are wrapped in a safe <mark> element (no dangerouslySetInnerHTML).
 */
function renderInlineTokens(text: string, customMap: Map<string, string>): React.ReactNode[] {
  return text.split(TOKEN_SPLIT_RE).map((seg, i) => {
    const m = /^\{\{([a-zA-Z0-9_]+)\}\}$/.exec(seg)
    if (!m) return seg
    const key = m[1] ?? ''
    if (customMap.has(key)) {
      // Custom → substitute with its value (plain text node, no markup)
      return <span key={i}>{customMap.get(key)}</span>
    }
    // System or unknown → coloured badge, no HTML injection
    const isSystem = SYSTEM_KEYS.has(key)
    return (
      <mark
        key={i}
        title={key}
        className={isSystem ? 'preview-token-system' : 'preview-token-unknown'}
      >
        {seg}
      </mark>
    )
  })
}

/**
 * Preview renderer:
 *  - Custom variables → substituted with their defaultValue (or key as fallback)
 *  - System variables → stay as {{key}} but highlighted with a coloured badge
 *  - Unknown tokens   → stay as {{key}} highlighted amber
 * Document-style layout — markdown rendered via ReactMarkdown with safe React nodes.
 *
 * Exported for unit testing.
 */
export function ContractPreview({
  body,
  customVariables,
}: {
  body: string
  customVariables: CustomVariable[]
}) {
  const customMap = useMemo(
    () => new Map(customVariables.map((v) => [v.key, v.defaultValue ?? v.key])),
    [customVariables],
  )

  // Pre-process: substitute custom tokens in markdown source so ReactMarkdown
  // receives plain text where custom vars used to be. System/unknown tokens
  // are left as-is and caught by the inline renderer below.
  const processedBody = useMemo(() => {
    return body.replace(TOKEN_SPLIT_RE, (match) => {
      const m = /^\{\{([a-zA-Z0-9_]+)\}\}$/.exec(match)
      if (!m) return match
      const key = m[1] ?? ''
      return customMap.has(key) ? (customMap.get(key) ?? key) : match
    })
  }, [body, customMap])

  return (
    <>
      <style>{`
        .contract-preview mark.preview-token-system {
          background: rgba(59,130,246,0.15);
          color: #1d4ed8;
          border-radius: 3px;
          padding: 0 3px;
          font-family: monospace;
          font-size: 0.85em;
          font-style: normal;
        }
        .contract-preview mark.preview-token-unknown {
          background: rgba(245,158,11,0.18);
          color: #b45309;
          border-radius: 3px;
          padding: 0 3px;
          font-family: monospace;
          font-size: 0.85em;
          font-style: normal;
        }
        .dark .contract-preview mark.preview-token-system  { color: #93c5fd; }
        .dark .contract-preview mark.preview-token-unknown { color: #fcd34d; }
        .contract-preview table {
          border-collapse: collapse;
          width: 100%;
          margin: 0.75em 0;
          font-size: 0.875em;
        }
        .contract-preview th,
        .contract-preview td {
          border: 1px solid rgba(128,128,128,0.3);
          padding: 6px 10px;
          text-align: left;
          vertical-align: top;
        }
        .contract-preview th {
          background: rgba(128,128,128,0.08);
          font-weight: 600;
        }
        .dark .contract-preview th {
          background: rgba(255,255,255,0.05);
        }
        .dark .contract-preview th,
        .dark .contract-preview td {
          border-color: rgba(255,255,255,0.15);
        }
      `}</style>
      <div
        className="contract-preview prose prose-sm dark:prose-invert max-w-none"
        data-testid="contract-preview-content"
      >
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            // Override text renderer to catch remaining {{...}} tokens safely.
            // ReactMarkdown passes `children` as a string for leaf text nodes.
            // We split on tokens and return safe React elements.
            p: ({ children }) => (
              <p>
                {typeof children === 'string' ? renderInlineTokens(children, customMap) : children}
              </p>
            ),
            li: ({ children }) => (
              <li>
                {typeof children === 'string' ? renderInlineTokens(children, customMap) : children}
              </li>
            ),
            // GFM table cells — apply the same token highlighting so
            // {{tokens}} inside table cells get the same coloured badges.
            td: ({ children }) => (
              <td>
                {typeof children === 'string' ? renderInlineTokens(children, customMap) : children}
              </td>
            ),
            th: ({ children }) => (
              <th>
                {typeof children === 'string' ? renderInlineTokens(children, customMap) : children}
              </th>
            ),
          }}
        >
          {processedBody}
        </ReactMarkdown>
      </div>
    </>
  )
}

function ContractEditorPage() {
  const { role: roleParam } = Route.useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()

  const roleUpper = roleParam.toUpperCase()
  const parsed = contractTargetRoleSchema.safeParse(roleUpper)

  useEffect(() => {
    if (!parsed.success) {
      void navigate({ to: '/admin/contracts' })
    }
  }, [parsed.success, navigate])

  if (!parsed.success) {
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
  const [showPreview, setShowPreview] = useState(false)
  const [customVariables, setCustomVariables] = useState<CustomVariable[]>([])

  // Inject CSS classes for token highlight once
  useEffect(() => {
    injectTokenHighlightStyles()
  }, [])

  // Token highlight extension — rebuilds when custom variables change
  const tokenHighlightExt = useMemo(
    () => buildTokenHighlightExtension(customVariables),
    [customVariables],
  )

  // Ref to CodeMirror EditorView for cursor-aware token insertion
  const editorViewRef = useRef<EditorView | null>(null)

  // ── PDF preview state (Part 3) ──────────────────────────────────────────────
  // The «Предпросмотр» dialog now renders the contract as a real PDF (tokens
  // stay visible, company requisites appended) instead of an HTML mock. The PDF
  // is generated server-side from the CURRENT editor markdown.
  const [pdfBlobUrl, setPdfBlobUrl] = useState<string | null>(null)
  const [pdfLoading, setPdfLoading] = useState(false)
  const [pdfError, setPdfError] = useState(false)
  // Holds the object URL to revoke (avoids leaking blob URLs across previews).
  const pdfUrlRef = useRef<string | null>(null)

  // On first load, init editor from template
  const currentBody = body ?? template?.bodyMarkdown ?? ''

  // Seed customVariables from template on load (once)
  const seededRef = useRef(false)
  useEffect(() => {
    if (template && !seededRef.current) {
      seededRef.current = true
      setCustomVariables(template.customVariables ?? [])
    }
  }, [template])

  const publishMutation = useMutation({
    mutationFn: async () => {
      return api.post('/contracts/templates', {
        targetRole: role,
        bodyMarkdown: currentBody,
        customVariables,
      })
    },
    onSuccess: () => {
      toast.success(`Шаблон для роли ${ROLE_LABELS[role]} опубликован`)
      void qc.invalidateQueries({ queryKey: ['contract-templates-all'] })
      void qc.invalidateQueries({ queryKey: ['contract-template', role] })
      setShowConfirm(false)
    },
    onError: () => {
      toast.error('Ошибка при публикации шаблона')
      setShowConfirm(false)
    },
  })

  /**
   * Insert token at current cursor position in CodeMirror.
   * Falls back to append if editor not focused / not mounted yet.
   */
  const handleInsertToken = useCallback(
    (token: string) => {
      const view = editorViewRef.current
      if (view) {
        const { from } = view.state.selection.main
        view.dispatch({
          changes: { from, insert: token },
          selection: { anchor: from + token.length },
        })
        view.focus()
        // Sync React state from updated editor content
        setBody(view.state.doc.toString())
      } else {
        // Fallback: append to body
        setBody((prev) => (prev ?? currentBody) + token)
      }
    },
    [currentBody],
  )

  // Revoke any held blob URL (called on close / new fetch / unmount).
  const revokePdfUrl = useCallback(() => {
    if (pdfUrlRef.current) {
      URL.revokeObjectURL(pdfUrlRef.current)
      pdfUrlRef.current = null
    }
  }, [])

  // Generate the preview PDF from the CURRENT editor markdown. POSTs the body +
  // role; tokens stay visible (no substitution) and the company requisites
  // section is appended server-side. Guards against races by ignoring stale
  // responses when the dialog has been closed / re-opened.
  const generatePreview = useCallback(async () => {
    const markdown = currentBody
    if (markdown.trim() === '') return
    setPdfLoading(true)
    setPdfError(false)
    revokePdfUrl()
    setPdfBlobUrl(null)
    try {
      const res = await api.post<Blob>(
        '/contracts/templates/preview-pdf',
        { bodyMarkdown: markdown, role },
        { responseType: 'blob' },
      )
      const url = URL.createObjectURL(res.data)
      pdfUrlRef.current = url
      setPdfBlobUrl(url)
    } catch {
      setPdfError(true)
    } finally {
      setPdfLoading(false)
    }
  }, [currentBody, role, revokePdfUrl])

  // Fetch the PDF whenever the preview dialog opens; revoke on close.
  useEffect(() => {
    if (showPreview) {
      void generatePreview()
    } else {
      revokePdfUrl()
      setPdfBlobUrl(null)
      setPdfError(false)
      setPdfLoading(false)
    }
    // Intentionally keyed on `showPreview` only: the PDF is generated when the
    // modal OPENS (and via the «Обновить» button), reflecting the markdown at
    // that moment — NOT re-fetched on every keystroke while open.
  }, [showPreview])

  // Revoke on unmount.
  useEffect(() => revokePdfUrl, [revokePdfUrl])

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-[520px]" />
        <Skeleton className="h-48" />
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
            onClick={() => void navigate({ to: '/admin/contracts' })}
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
          {/* Preview button → opens modal */}
          <Button
            variant="outline"
            onClick={() => setShowPreview(true)}
            disabled={currentBody.trim() === ''}
            data-testid="preview-template-button"
          >
            <Eye className="mr-1.5 h-4 w-4" />
            Предпросмотр
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

      {/* Full-width CodeMirror editor */}
      <div
        className="flex flex-col rounded-lg border border-border/60 overflow-hidden"
        data-testid="contract-editor-wrapper"
      >
        <div className="border-b border-border/60 bg-muted/30 px-3 py-1.5 text-xs font-medium text-muted-foreground">
          Markdown редактор
        </div>
        <div className="overflow-hidden">
          <Suspense fallback={<Skeleton className="h-[520px] w-full" />}>
            <CodeMirrorEditor
              value={currentBody}
              onChange={(val) => setBody(val)}
              editorViewRef={editorViewRef}
              extensions={[tokenHighlightExt]}
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
              height="520px"
              style={{ fontSize: '13px' }}
              data-testid="contract-editor-codemirror"
            />
          </Suspense>
        </div>
      </div>

      {/* Full-width Variables panel below the editor */}
      <div
        className="rounded-lg border border-border/60 overflow-hidden"
        data-testid="variables-panel-wrapper"
      >
        <div className="border-b border-border/60 bg-muted/30 px-3 py-1.5 text-xs font-medium text-muted-foreground">
          Переменные шаблона
        </div>
        <div className="p-3">
          <VariablesPanel
            body={currentBody}
            customVariables={customVariables}
            onCustomVariablesChange={setCustomVariables}
            onInsertToken={handleInsertToken}
          />
        </div>
      </div>

      {/* Preview modal — document-style render of the final template */}
      <Dialog open={showPreview} onOpenChange={setShowPreview}>
        <DialogContent
          className="max-w-4xl w-full"
          style={{ maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}
          data-testid="preview-dialog"
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Eye className="h-4 w-4" />
              Предпросмотр PDF — {ROLE_LABELS[role]}
            </DialogTitle>
            <DialogDescription>
              Так контракт будет выглядеть в PDF. Токены вида {'{{...}}'} остаются видимыми — они
              подставятся автоматически при подписании. Блок «Реквизиты компании» добавляется в
              конце.
            </DialogDescription>
          </DialogHeader>

          {/* PDF document preview (rendered server-side from the current editor markdown) */}
          <div
            className="flex-1 overflow-hidden min-h-0 py-2"
            data-testid="preview-dialog-document"
          >
            <PdfPreview
              blobUrl={pdfBlobUrl}
              isLoading={pdfLoading}
              hasError={pdfError}
              filename={`contract-preview-${role}.pdf`}
              className="h-[70vh]"
              testId="contract-preview-pdf"
            />
          </div>

          <DialogFooter className="pt-2 border-t border-border/40">
            <Button
              variant="outline"
              onClick={() => void generatePreview()}
              disabled={pdfLoading}
              data-testid="preview-dialog-refresh"
            >
              Обновить
            </Button>
            <Button
              variant="outline"
              onClick={() => setShowPreview(false)}
              data-testid="preview-dialog-close"
            >
              Закрыть
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Publish confirmation dialog */}
      <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
        <DialogContent data-testid="publish-confirm-dialog">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              Опубликовать новую версию (v{(template?.version ?? 0) + 1})?
            </DialogTitle>
            <DialogDescription>
              Текущая версия шаблона для роли <strong>{ROLE_LABELS[role]}</strong> будет
              деактивирована (сохранится в истории). Новые сотрудники увидят обновлённый текст при
              следующем онбординге.
            </DialogDescription>
          </DialogHeader>
          <Suspense fallback={<Skeleton className="h-20 w-full rounded-md" />}>
            <MarkdownDiff oldText={template?.bodyMarkdown ?? ''} newText={currentBody} />
          </Suspense>
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
