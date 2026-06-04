import { diffLines } from 'diff'

interface MarkdownDiffProps {
  oldText: string
  newText: string
}

export function MarkdownDiff({ oldText, newText }: MarkdownDiffProps) {
  const oldTrimmed = oldText.trim()
  const newTrimmed = newText.trim()

  if (oldTrimmed === newTrimmed) {
    return (
      <div
        className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground"
        data-testid="markdown-diff-empty"
      >
        Изменений нет — содержимое идентично текущей версии.
      </div>
    )
  }

  if (oldTrimmed === '') {
    return (
      <div
        className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground"
        data-testid="markdown-diff-initial"
      >
        Первая публикация — всё содержимое будет добавлено как новое.
      </div>
    )
  }

  const parts = diffLines(oldTrimmed, newTrimmed)

  return (
    <div
      className="max-h-[300px] overflow-y-auto rounded-md border bg-muted/20 p-2 font-mono text-xs"
      data-testid="markdown-diff"
    >
      {parts.map((part, i) => {
        const cls = part.added
          ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
          : part.removed
            ? 'bg-rose-500/15 text-rose-700 dark:text-rose-300 line-through'
            : 'text-muted-foreground'
        const prefix = part.added ? '+ ' : part.removed ? '- ' : '  '
        return (
          <pre key={i} className={`whitespace-pre-wrap px-2 py-0.5 ${cls}`}>
            {part.value
              .split('\n')
              .filter((line, idx, arr) => !(idx === arr.length - 1 && line === ''))
              .map((line) => `${prefix}${line}`)
              .join('\n')}
          </pre>
        )
      })}
    </div>
  )
}
