import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/axios'
import { lazy, Suspense, useState } from 'react'
import { Trans } from '@lingui/react/macro'
import { TosPdfPreview } from '@/components/admin/TosPdfPreview'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'
import { format } from 'date-fns'
import { Plus, Clock } from 'lucide-react'

// Lazy-load CodeMirror + markdown extension + dark theme — only ADMIN reaches this route.
const CodeMirrorViewer = lazy(async () => {
  const [{ default: CodeMirror }, { markdown }, { oneDark }] = await Promise.all([
    import('@uiw/react-codemirror'),
    import('@codemirror/lang-markdown'),
    import('@codemirror/theme-one-dark'),
  ])
  const mdExtension = markdown()
  function LazyViewer(props: React.ComponentProps<typeof CodeMirror>) {
    const extensions = [mdExtension, ...(props.extensions ?? [])]
    return <CodeMirror theme={oneDark} {...props} extensions={extensions} />
  }
  return { default: LazyViewer }
})

export const Route = createFileRoute('/_authenticated/admin/tos/')({
  component: TosEditorPage,
})

interface TosVersionRow {
  id: string
  version: number
  bodyMarkdown: string
  isActive: boolean
  createdAt: string
}

function TosEditorPage() {
  const { data: allVersions = [], isLoading } = useQuery<TosVersionRow[]>({
    queryKey: ['tos-versions-all'],
    queryFn: async () => {
      const res = await api.get<TosVersionRow[]>('/tos/versions')
      return res.data
    },
    staleTime: 30_000,
  })

  // Active version is the one with isActive=true
  const activeVersion = allVersions.find((v) => v.isActive) ?? null
  const historicalVersions = allVersions
    .filter((v) => !v.isActive)
    .sort((a, b) => b.version - a.version)

  // Read-only preview state for history — currently viewed version
  const [previewVersion, setPreviewVersion] = useState<TosVersionRow | null>(null)

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Skeleton className="h-96" />
          <Skeleton className="h-96" />
        </div>
      </div>
    )
  }

  const displayedVersion = previewVersion ?? activeVersion

  return (
    <div className="flex flex-col gap-4">
      {/* Header — UX-M-3 (fix-round 2): «Нова версія умов»/«New Terms
          version» crowded the title at 320px on a single `items-center
          justify-between` row (no mobile stacking) — stacks below `sm:`. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">
            <Trans>Умови використання</Trans>
          </h2>
          {activeVersion && (
            <p className="text-xs text-muted-foreground">
              <Trans>
                Активна версія: v{activeVersion.version} · оновлена{' '}
                {format(new Date(activeVersion.createdAt), 'dd.MM.yyyy')}
              </Trans>
            </p>
          )}
        </div>
        <Button asChild data-testid="publish-new-tos-button" className="self-start sm:self-auto">
          <Link to="/admin/tos/new">
            <Plus className="mr-1.5 h-4 w-4" />
            <Trans>Нова версія умов</Trans>
          </Link>
        </Button>
      </div>

      {/* Split-view: read-only CodeMirror + preview */}
      {displayedVersion ? (
        <>
          {previewVersion && (
            <div className="flex items-center justify-between rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-2">
              <p className="text-sm text-amber-600 dark:text-amber-400">
                <Trans>Перегляд архівної версії v{previewVersion.version}</Trans>
              </p>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPreviewVersion(null)}
                data-testid="back-to-active-tos"
              >
                <Trans>До активної версії</Trans>
              </Button>
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2" style={{ minHeight: '420px' }}>
            {/* Left: read-only editor */}
            <div className="flex flex-col rounded-lg border border-border/60 overflow-hidden">
              <div className="flex items-center justify-between border-b border-border/60 bg-muted/30 px-3 py-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  Markdown{' '}
                  {displayedVersion.isActive ? (
                    <Badge variant="outline" className="ml-1 text-[10px] py-0">
                      <Trans>активна</Trans>
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="ml-1 text-[10px] py-0 text-amber-500">
                      <Trans>архів v{displayedVersion.version}</Trans>
                    </Badge>
                  )}
                </span>
              </div>
              <div className="flex-1 overflow-auto opacity-70 pointer-events-none">
                <Suspense fallback={<Skeleton className="h-72 w-full" />}>
                  <CodeMirrorViewer
                    value={displayedVersion.bodyMarkdown}
                    editable={false}
                    basicSetup={{
                      lineNumbers: true,
                      highlightActiveLineGutter: false,
                      foldGutter: false,
                      drawSelection: false,
                      syntaxHighlighting: true,
                      bracketMatching: false,
                      closeBrackets: false,
                      autocompletion: false,
                      searchKeymap: false,
                    }}
                    style={{ height: '100%', fontSize: '13px' }}
                  />
                </Suspense>
              </div>
            </div>

            {/* Right: PDF preview */}
            <TosPdfPreview
              bodyMarkdown={displayedVersion.bodyMarkdown}
              className="overflow-hidden"
              data-testid="tos-preview-pane"
            />
          </div>
        </>
      ) : (
        <div className="rounded-lg border border-dashed border-border p-12 text-center">
          <p className="text-muted-foreground">
            <Trans>Немає активної версії умов використання. Створіть першу версію.</Trans>
          </p>
        </div>
      )}

      {/* Historical versions list */}
      {historicalVersions.length > 0 && (
        <div className="flex flex-col gap-2" data-testid="tos-history-list">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <Separator className="flex-1" />
            <span className="text-xs text-muted-foreground">
              <Trans>Історія версій</Trans>
            </span>
            <Separator className="flex-1" />
          </div>
          <div className="space-y-1">
            {historicalVersions.map((ver) => (
              <button
                key={ver.id}
                type="button"
                className="flex w-full items-center justify-between rounded-lg border border-border/60 bg-muted/20 px-4 py-2.5 text-sm transition-colors hover:bg-muted/40"
                onClick={() => setPreviewVersion(ver)}
                data-testid={`tos-history-item-v${ver.version}`}
              >
                <span className="font-medium">
                  <Trans>Версія v{ver.version}</Trans>
                </span>
                <span className="text-muted-foreground text-xs">
                  {format(new Date(ver.createdAt), 'dd.MM.yyyy HH:mm')}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
