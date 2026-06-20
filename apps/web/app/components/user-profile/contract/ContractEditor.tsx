import { lazy, Suspense } from 'react'
import { Info } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { CONTRACT_VARIABLE_DESCRIPTIONS_BRACED } from '@crm/shared'
import { cn } from '@/lib/utils'

// Lazy-load CodeMirror + markdown extension + dark theme — heavy deps (~500 KB gzip).
// Reuses the same loader pattern as apps/web/app/routes/crm/admin/contracts.$role.tsx
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

export interface ContractEditorProps {
  value: string
  onChange: (value: string) => void
  /** When true, editor is rendered read-only with a frozen banner. */
  readOnly: boolean
  /** Banner message shown above the editor when frozen. */
  frozenBanner?: string
  className?: string
  /** Whether to show the variables hint panel (controlled externally). */
  showHint?: boolean
  onToggleHint?: () => void
}

export function ContractEditor({
  value,
  onChange,
  readOnly,
  frozenBanner,
  className,
  showHint = false,
  onToggleHint,
}: ContractEditorProps) {
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {/* Frozen banner — shown in READY_TO_SIGN / SIGNED */}
      {readOnly && frozenBanner && (
        <div
          className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300"
          data-testid="contract-editor-frozen-banner"
        >
          {frozenBanner}
        </div>
      )}

      <div
        className="flex flex-col rounded-lg border border-border/60 overflow-hidden"
        style={{ height: '480px' }}
      >
        <div className="flex items-center justify-between border-b border-border/60 bg-muted/30 px-3 py-1.5 shrink-0">
          <span className="text-xs font-medium text-muted-foreground">Markdown редактор</span>
          {onToggleHint && (
            <button
              type="button"
              onClick={onToggleHint}
              aria-label="Подсказка переменных"
              data-testid="contract-editor-hint-toggle"
              className="rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <Info className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <div className="flex-1 overflow-auto min-h-0">
          <Suspense fallback={<Skeleton className="h-72 w-full" />}>
            <CodeMirrorEditor
              value={value}
              onChange={onChange}
              readOnly={readOnly}
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
                highlightActiveLine: !readOnly,
                highlightSelectionMatches: false,
                closeBracketsKeymap: false,
                searchKeymap: false,
              }}
              style={{ height: '100%', fontSize: '13px' }}
            />
          </Suspense>
        </div>
      </div>

      {/* Variables hint panel */}
      {showHint && (
        <div
          className="rounded-lg border border-border/60 bg-muted/40 p-4"
          data-testid="contract-editor-hint-panel"
        >
          <p className="mb-2 text-sm font-medium">Доступные переменные</p>
          <div className="grid gap-1 sm:grid-cols-2">
            {Object.entries(CONTRACT_VARIABLE_DESCRIPTIONS_BRACED).map(
              ([variable, description]) => (
                <div key={variable} className="flex items-start gap-2 text-xs">
                  <code className="shrink-0 rounded bg-primary/10 px-1 py-0.5 font-mono text-primary">
                    {variable}
                  </code>
                  <span className="text-muted-foreground">{description}</span>
                </div>
              ),
            )}
          </div>
        </div>
      )}
    </div>
  )
}
