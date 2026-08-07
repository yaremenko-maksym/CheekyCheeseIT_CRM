import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { ExternalLink, Loader2, ThumbsDown, ThumbsUp, X } from 'lucide-react'
import type { JobExclusionDto, JobSuggestionDto } from '@crm/shared'
import {
  useCreateJobExclusion,
  useDeleteJobExclusion,
  useJobExclusions,
  useJobSuggestions,
  useUpdateJobSuggestionStatus,
} from '@/hooks/use-job-sourcing'
import { Button } from '@/components/ui/button'
import {
  CrmDialogBody,
  CrmDialogFooter,
  CrmDialogHeader,
  Dialog,
  CrmDialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/crm-dialog'
import { Input } from '@/components/ui/input'
import { openOriginalPosting } from './open-original'

/**
 * Подбор вакансий — the working loop of task-job-sourcing-slice1.
 *
 * One suggestion at a time: title, company, date, description (markdown), then
 * «Открыть оригинал» / «Откликнулись» / «Не подходит». Answering either of the
 * last two advances to the next vacancy.
 *
 * SECURITY — two things this component is deliberately careful about:
 *
 *  1. `descriptionMd` comes from a third party. It is rendered with
 *     react-markdown and NO `rehype-raw`, so raw HTML in the string stays TEXT.
 *     (The API already converted the feed's HTML to markdown and dropped
 *     script/style — this is the second, independent layer.)
 *  2. «Открыть оригинал» calls `window.open` SYNCHRONOUSLY, first thing in the
 *     handler. See open-original.ts for the full reasoning; the short version
 *     is that an `await` in front of it makes the button silently do nothing on
 *     a phone.
 */

function formatDate(iso: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' })
}

function ExclusionsPanel({
  seniorId,
  canManageGlobal,
}: {
  seniorId: string | undefined
  canManageGlobal: boolean
}) {
  const { data, isLoading } = useJobExclusions(seniorId)
  const createExclusion = useCreateJobExclusion(seniorId)
  const deleteExclusion = useDeleteJobExclusion(seniorId)
  const [value, setValue] = useState('')

  const items: JobExclusionDto[] = data?.items ?? []
  const derived = items.filter((i) => i.origin === 'PROJECT')
  const manual = items.filter((i) => i.origin === 'MANUAL')

  const submit = () => {
    const trimmed = value.trim()
    if (trimmed.length < 2 || !seniorId) return
    createExclusion.mutate(
      { scope: 'SENIOR', seniorId, kind: 'COMPANY', value: trimmed },
      { onSuccess: () => setValue('') },
    )
  }

  return (
    <section className="mt-6 border-t border-border/50 pt-4" data-testid="job-exclusions-panel">
      <h3 className="text-sm font-medium text-foreground">Исключения</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Компании из ваших проектов исключаются автоматически — вакансии своего клиента вы не
        увидите.
      </p>

      {isLoading ? (
        <p className="mt-3 text-xs text-muted-foreground">Загрузка…</p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          {derived.map((item) => (
            <span
              key={`derived-${item.normalizedValue}`}
              data-testid="job-exclusion-derived"
              title={item.sourceLabel ? `Из проекта «${item.sourceLabel}»` : undefined}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-3 py-1 text-xs text-muted-foreground"
            >
              {item.value}
              <span className="text-[10px] uppercase tracking-wide opacity-70">проект</span>
            </span>
          ))}
          {manual.map((item) => (
            <span
              key={item.id ?? item.normalizedValue}
              data-testid="job-exclusion-manual"
              className="inline-flex items-center gap-1 rounded-full border border-border px-3 py-1 text-xs"
            >
              {item.value}
              {item.scope === 'GLOBAL' && (
                <span className="text-[10px] uppercase tracking-wide opacity-70">общее</span>
              )}
              {item.id && (item.scope === 'SENIOR' || canManageGlobal) && (
                <button
                  type="button"
                  aria-label={`Удалить исключение ${item.value}`}
                  onClick={() => deleteExclusion.mutate(item.id as string)}
                  className="ml-0.5 inline-flex h-5 w-5 min-h-[20px] min-w-[20px] items-center justify-center rounded-full hover:bg-muted"
                >
                  <X className="h-3 w-3" aria-hidden />
                </button>
              )}
            </span>
          ))}
          {items.length === 0 && (
            <p className="text-xs text-muted-foreground">Пока ничего не исключено.</p>
          )}
        </div>
      )}

      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            }
          }}
          placeholder="Компания или стоп-слово"
          aria-label="Новое исключение"
          data-testid="job-exclusion-input"
        />
        <Button
          type="button"
          variant="outline"
          onClick={submit}
          disabled={value.trim().length < 2 || createExclusion.isPending}
          data-testid="job-exclusion-add"
          className="min-h-[44px] sm:min-h-9"
        >
          Добавить
        </Button>
      </div>
    </section>
  )
}

export function JobSuggestionDialog({
  open,
  onClose,
  seniorId,
  canManageGlobal = false,
}: {
  open: boolean
  onClose: () => void
  /** Whose queue to show. `undefined` = "mine" (a SENIOR viewing their own). */
  seniorId: string | undefined
  canManageGlobal?: boolean
}) {
  const { data, isLoading, isError } = useJobSuggestions(seniorId, open)
  const updateStatus = useUpdateJobSuggestionStatus(seniorId)

  const current: JobSuggestionDto | undefined = data?.items[0]
  const total = data?.total ?? 0

  /**
   * SYNCHRONOUS by contract — `window.open` is the FIRST thing that happens.
   * Do not add `await` above this line, and do not make the button's onClick
   * async. See open-original.ts.
   */
  const handleOpenOriginal = () => {
    openOriginalPosting(current?.posting.url)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose()
      }}
    >
      <CrmDialogContent maxWidth="sm:max-w-2xl" data-testid="job-suggestion-dialog">
        <CrmDialogHeader>
          <DialogTitle className="pr-8 text-base sm:text-lg">Подбор вакансий</DialogTitle>
          <DialogDescription className="sr-only">
            Вакансии с внешних площадок, подобранные для синьора
          </DialogDescription>
          {total > 0 && (
            <p className="mt-1 text-xs text-muted-foreground" data-testid="job-queue-counter">
              Осталось: {total}
            </p>
          )}
        </CrmDialogHeader>

        <CrmDialogBody className="pb-2">
          {isLoading && (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              Загрузка вакансий…
            </div>
          )}

          {isError && !isLoading && (
            <p className="py-8 text-sm text-destructive" data-testid="job-suggestion-error">
              Не удалось загрузить вакансии. Попробуйте позже.
            </p>
          )}

          {!isLoading && !isError && !current && (
            <div className="py-8 text-center" data-testid="job-suggestion-empty">
              <p className="text-sm font-medium">Подходящих вакансий нет</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Новые появятся после следующего сбора — или ослабьте исключения ниже.
              </p>
            </div>
          )}

          {!isLoading && !isError && current && (
            <article data-testid="job-suggestion-card">
              <h2 className="text-base font-semibold sm:text-lg" data-testid="job-suggestion-title">
                {current.posting.title}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                <span data-testid="job-suggestion-company">{current.posting.companyName}</span>
                {current.posting.location && <span> · {current.posting.location}</span>}
                {current.posting.publishedAt && (
                  <span> · {formatDate(current.posting.publishedAt)}</span>
                )}
              </p>

              <div
                className="prose prose-sm dark:prose-invert mt-4 max-w-none break-words text-sm leading-relaxed [&_a]:underline [&_li]:my-0.5 [&_p]:my-2 [&_ul]:list-disc [&_ul]:pl-5"
                data-testid="job-suggestion-description"
              >
                {/*
                  NO rehype-raw: raw HTML inside the markdown must stay TEXT.
                  Adding it would turn a hostile feed into stored XSS in an
                  authenticated origin — pinned by
                  __tests__/JobSuggestionDialog.test.tsx.
                */}
                <ReactMarkdown>{current.posting.descriptionMd}</ReactMarkdown>
              </div>
            </article>
          )}

          <ExclusionsPanel seniorId={seniorId} canManageGlobal={canManageGlobal} />
        </CrmDialogBody>

        <CrmDialogFooter className="sm:justify-between">
          <Button
            type="button"
            variant="outline"
            onClick={handleOpenOriginal}
            disabled={!current}
            data-testid="job-open-original"
            /*
              `order-last` looks backwards but is right: CrmDialogFooter is
              `flex-col-reverse` on mobile, so the LAST child renders at the
              TOP. Opening the original is the first thing the user does, so on
              a phone it belongs above the two verdicts; on `sm:` the footer is
              a normal row again and the ordering resets.
            */
            className="order-last min-h-[44px] w-full sm:order-none sm:w-auto"
          >
            <ExternalLink className="mr-2 h-4 w-4 shrink-0" aria-hidden />
            Открыть оригинал
          </Button>

          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              type="button"
              variant="outline"
              onClick={() => current && updateStatus.mutate({ id: current.id, status: 'REJECTED' })}
              disabled={!current || updateStatus.isPending}
              data-testid="job-mark-rejected"
              className="min-h-[44px] w-full sm:w-auto"
            >
              <ThumbsDown className="mr-2 h-4 w-4 shrink-0" aria-hidden />
              Не подходит
            </Button>
            <Button
              type="button"
              onClick={() => current && updateStatus.mutate({ id: current.id, status: 'APPLIED' })}
              disabled={!current || updateStatus.isPending}
              data-testid="job-mark-applied"
              className="min-h-[44px] w-full sm:w-auto"
            >
              <ThumbsUp className="mr-2 h-4 w-4 shrink-0" aria-hidden />
              Откликнулись
            </Button>
          </div>
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}
