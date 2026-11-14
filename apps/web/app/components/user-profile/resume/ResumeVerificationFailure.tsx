/**
 * The failure panel (verified base resume design §5.5): a FAILED check, or the
 * non-blocking warning on a VERIFIED resume whose last template / formatting
 * run failed. Amber, not destructive: the run failed in the background and
 * nothing the user typed is lost.
 *
 * Report items become the same issue rows as the completeness panel. A row is
 * a button only when its report path maps to a facts field (§10.6).
 */
import { Info, TriangleAlert } from 'lucide-react'
import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import {
  resumeReportReasonSchema,
  type ResumeReportReason,
  type ResumeVerificationErrorCode,
  type ResumeVerificationReport,
} from '@crm/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { translateApiError } from '@/lib/axios-utils'
import { IssueRow, useIssueLabel } from './ResumeCompletenessPanel'

/** R = Check again, F = Fix the facts (+ Check again), T = Choose a template (§10.3). */
type FailureActions = { retry: boolean; fixFacts: boolean; chooseTemplate: boolean }
const R: FailureActions = { retry: true, fixFacts: false, chooseTemplate: false }
const F: FailureActions = { retry: true, fixFacts: true, chooseTemplate: false }
const FT: FailureActions = { retry: true, fixFacts: true, chooseTemplate: true }
const RT: FailureActions = { retry: true, fixFacts: false, chooseTemplate: true }
const T: FailureActions = { retry: false, fixFacts: false, chooseTemplate: true }

const TEMPORARY = msg`Це тимчасово. Спробуйте ще раз за кілька хвилин.`

/** One title + body + action set per code; a new code fails the type check. `null` body = catalog. */
export const VERIFICATION_CODES: Record<
  ResumeVerificationErrorCode,
  { title: MessageDescriptor; body: MessageDescriptor | null; actions: FailureActions }
> = {
  INCOMPLETE: {
    title: msg`Заповнено не все`,
    body: msg`Перевірка не почалася: заповніть поля зі списку.`,
    actions: F,
  },
  CUSTOM_TEMPLATE: { title: msg`Шаблон не підтримує перевірку`, body: null, actions: T },
  WRITER_UNAVAILABLE: {
    title: msg`Сервіс написання тексту недоступний`,
    body: TEMPORARY,
    actions: R,
  },
  ENTAILMENT_UNAVAILABLE: {
    title: msg`Сервіс звірки з фактами недоступний`,
    body: TEMPORARY,
    actions: R,
  },
  RENDER_FAILED: {
    title: msg`Не вдалося зібрати PDF`,
    body: msg`Спробуйте ще раз. Якщо повториться — змініть шаблон або зверніться до адміністратора.`,
    actions: RT,
  },
  ATS_CHECK_FAILED: {
    title: msg`ATS не прочитав PDF`,
    body: msg`Частина тексту не читається з PDF. Скоротіть поля зі списку або оберіть інший шаблон.`,
    actions: FT,
  },
  GLYPH_CHECK_FAILED: {
    title: msg`Шрифт не показує частину символів`,
    body: msg`У PDF випали символи з полів зі списку. Замініть їх звичайними латинськими літерами або оберіть інший шаблон.`,
    actions: FT,
  },
  LAYOUT_UNFIXABLE: {
    title: msg`Резюме не вміщується в макет`,
    body: msg`Резюме не вміщується у 2 сторінки або остання сторінка майже порожня. Скоротіть нотатки або змініть щільність в оформленні.`,
    actions: F,
  },
  VISUAL_CHECK_FAILED: {
    title: msg`PDF не пройшов візуальну перевірку`,
    body: msg`На сторінці знайдено накладання або обрізаний текст. Скоротіть поля зі списку або оберіть інший шаблон.`,
    actions: FT,
  },
  VISUAL_CHECK_UNAVAILABLE: {
    title: msg`Візуальна перевірка недоступна`,
    body: TEMPORARY,
    actions: R,
  },
  STALLED: {
    title: msg`Перевірка зупинилася`,
    body: msg`Перевірка тривала надто довго й зупинилась. Запустіть її ще раз — факти збережено.`,
    actions: R,
  },
}

const PAGES = msg`більше 2 сторінок`
const LARGE = msg`файл більший за 1 МБ`

/**
 * Gate reason codes (§10.5), one line per code of `ResumeReportReason`. `BAD_INDEX` deliberately reads
 * as the generic line. A stored report may hold a code this build does not know: it gets the generic line too (R46).
 */
const REASONS: Record<Exclude<ResumeReportReason, 'BAD_INDEX'>, MessageDescriptor> = {
  EMPTY: msg`порожньо`,
  UNGROUNDED: msg`немає у фактах`,
  NON_LATIN: msg`не латиницею`,
  CONTACT_IN_TEXT: msg`містить контакти`,
  NOT_SUPPORTED: msg`шаблон це не підтримує`,
  HUMAN_EDITED: msg`змінено вручну`,
  MISSING_TEXT: msg`текст не знайдено в PDF`,
  HEADING_MISSING: msg`немає заголовка розділу`,
  HEADING_ORDER: msg`заголовки розділів не в тому порядку`,
  HIDDEN_SECTION_PRESENT: msg`прихований розділ потрапив у PDF`,
  ITEM_ORDER: msg`текст стоїть не у своєму місці роботи`,
  PERIOD_FORMAT: msg`дати у неправильному форматі`,
  CONTACT_NOT_IN_BODY: msg`немає в шапці першої сторінки`,
  REPLACEMENT_CHAR: msg`нечитабельні символи`,
  LIGATURE: msg`злиті літери (лігатури)`,
  LETTER_SPACED: msg`заголовок набрано врозрядку`,
  TOO_MANY_PAGES: PAGES,
  TOO_LARGE: LARGE,
  UNREADABLE: msg`PDF не читається як текст`,
  DROPPED_GLYPHS: msg`символи випали з PDF`,
  LAST_PAGE_UNDERFILLED: msg`остання сторінка майже порожня`,
  overflow: msg`текст виходить за поле`,
  overlap: msg`рядки накладаються`,
  ragged: msg`нерівний край тексту`,
  orphan: msg`висячий рядок`,
  'broken-bullet': msg`пункт розірвано`,
  'uneven-spacing': msg`нерівні відступи`,
  'cut-off': msg`текст обрізано`,
}
const GENERIC_REASON = msg`автоматична перевірка не пройдена`

const reasonMessage = (reason: string): MessageDescriptor => {
  const known = resumeReportReasonSchema.safeParse(reason)
  return known.success && known.data !== 'BAD_INDEX' ? REASONS[known.data] : GENERIC_REASON
}

/** Report path → the facts field it points at; `$&` = the path itself (§10.6). */
const FIELD_RULES: Array<[RegExp, string]> = [
  [/^(headline|location\.city|location\.country)$/, '$&'],
  [/^skills(\.\d+)?$/, 'skills'],
  [/^experience\.(\d+)\.period$/, 'experience.$1.start'],
  [/^experience\.(\d+)\.bullets(\.\d+)?$/, 'experience.$1.notes'],
  [/^experience\.(\d+)\.(company|role|location|start|end)$/, '$&'],
  [/^experience\.(\d+)\.(notes|technologies)(\.\d+)?$/, 'experience.$1.$2'],
  [/^education\.(\d+)\.period$/, 'education.$1.startYear'],
  [/^education\.(\d+)\.(institution|degree|startYear|endYear)$/, '$&'],
  [/^languages\.(\d+)(\.name)?$/, 'languages.$1.name'],
  [/^links\.(\d+)\.(label|url)$/, '$&'],
  [/^links\.(\d+)$/, 'links.$1.label'],
]
/** Resume-level paths: a label, never a field (the PDF, the profile, the whole summary). */
const PLAIN = /^(|summary|displayName|email|pages\.\d+)$/
/** A section key's row focuses the section's first control. */
const SECTION_FIELDS: Record<string, string> = {
  headline: 'headline',
  skills: 'skills',
  experience: 'experience.add',
  education: 'education.0.institution',
  languages: 'languages.add',
  links: 'links.0.label',
}

/**
 * Where a report row points: the path its label is read from and the facts
 * field it focuses (null = a plain resume-level row). Bracket paths from the ATS
 * checker (`experience[0].period`) are normalised to dot paths first.
 */
export function resolveReportPath(raw: string): { labelPath: string; field: string | null } {
  const path = raw.replace(/\[(\d+)\]/g, '.$1')
  if (PLAIN.test(path)) return { labelPath: path, field: null }
  for (const [re, field] of FIELD_RULES) {
    if (re.test(path)) return { labelPath: path, field: path.replace(re, field) }
  }
  // Unknown path: its section's row when the first segment is a section, else the whole resume.
  const section = path.split('.')[0] ?? ''
  const field = SECTION_FIELDS[section]
  return field ? { labelPath: section, field } : { labelPath: '', field: null }
}

/** The "whole resume" line, for a list code whose report names no item (R63). */
const WHOLE_RESUME_ROW: FailingRow = { labelPath: '', field: null, reason: '' }

const MAX_ROWS = 8

export interface ResumeVerificationFailureProps {
  code: ResumeVerificationErrorCode
  report: ResumeVerificationReport | null
  variant: 'failed' | 'warning'
  /** Focus a facts field; false when it is not on screen. */
  onFocusField: (field: string) => boolean
  onRetry: () => void
  onChooseTemplate: () => void
  /** A retry is in flight, or the viewer cannot act. */
  disabled: boolean
}

export function ResumeVerificationFailure({
  code,
  report,
  variant,
  onFocusField,
  onRetry,
  onChooseTemplate,
  disabled,
}: ResumeVerificationFailureProps) {
  const { i18n } = useLingui()
  const entry = VERIFICATION_CODES[code]
  const body = entry.body
    ? i18n._(entry.body)
    : translateApiError('RESUME_CUSTOM_TEMPLATE', undefined)

  const failing = failingRows(report)
  // R63: these bodies say "the fields in the list", so their list is never empty.
  const rows = LIST_CODES.has(code) && failing.length === 0 ? [WHOLE_RESUME_ROW] : failing
  if (variant === 'warning') {
    return (
      <div
        role="status"
        className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
        data-testid="resume-verification-warning"
      >
        <div className="flex items-start gap-2">
          <Info className="mt-0.5 size-4 shrink-0 text-amber-500" aria-hidden />
          <p className="min-w-0">
            <span className="font-semibold">
              <Trans>
                Зміна шаблону чи оформлення не пройшла перевірку — залишено попередній варіант.
              </Trans>
            </span>{' '}
            {body}
          </p>
        </div>
        {LIST_CODES.has(code) && <FailingFieldList rows={rows} onFocusField={onFocusField} />}
      </div>
    )
  }

  const firstField = rows.find((row) => row.field !== null)?.field ?? null
  const fixFacts = () => {
    if (firstField === null || !onFocusField(firstField)) onFocusField('headline')
  }

  return (
    <section
      role="alert"
      className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4"
      data-testid="resume-verification-failure"
    >
      <div className="flex items-start gap-3">
        <TriangleAlert className="mt-0.5 size-5 shrink-0 text-amber-500" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold">{i18n._(entry.title)}</h3>
            <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-amber-300">
              <Trans>Не пройшло перевірку</Trans>
            </Badge>
          </div>
          <p className="text-sm">{body}</p>
        </div>
      </div>

      {rows.length > 0 && <FailingFieldList rows={rows} onFocusField={onFocusField} />}

      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        {entry.actions.fixFacts && (
          <Button type="button" className="h-11 sm:h-9" disabled={disabled} onClick={fixFacts}>
            <Trans>Виправити факти</Trans>
          </Button>
        )}
        {entry.actions.retry && (
          <Button
            type="button"
            variant={entry.actions.fixFacts ? 'outline' : 'default'}
            className="h-11 sm:h-9"
            disabled={disabled}
            onClick={onRetry}
            data-testid="resume-verification-retry"
          >
            <Trans>Перевірити ще раз</Trans>
          </Button>
        )}
        {entry.actions.chooseTemplate && (
          <Button
            type="button"
            variant={entry.actions.retry ? 'outline' : 'default'}
            className="h-11 sm:h-9"
            disabled={disabled}
            onClick={onChooseTemplate}
          >
            <Trans>Обрати шаблон</Trans>
          </Button>
        )}
      </div>
    </section>
  )
}

/** Codes whose body points at "the fields in the list" (incomplete facts, ATS / glyph / visual gates). */
const LIST_CODES: ReadonlySet<ResumeVerificationErrorCode> = new Set([
  'INCOMPLETE',
  'ATS_CHECK_FAILED',
  'GLYPH_CHECK_FAILED',
  'VISUAL_CHECK_FAILED',
])

type FailingRow = ReturnType<typeof resolveReportPath> & { reason: string }

function failingRows(report: ResumeVerificationReport | null): FailingRow[] {
  return (report?.gates ?? [])
    .filter((gate) => !gate.ok)
    .flatMap((gate) => gate.items)
    .map((item) => ({ ...resolveReportPath(item.path), reason: item.reason }))
}

/** The failing report items, at most MAX_ROWS, plus an "and N more" line. */
function FailingFieldList({
  rows,
  onFocusField,
}: {
  rows: FailingRow[]
  onFocusField: (field: string) => boolean
}) {
  const { i18n } = useLingui()
  const issueLabel = useIssueLabel()
  const shown = rows.slice(0, MAX_ROWS)
  const more = rows.length - shown.length
  return (
    <ul className="mt-3 space-y-1" data-testid="resume-verification-items">
      {shown.map(({ labelPath, field, reason }, i) => (
        <IssueRow
          key={`${labelPath}:${reason}:${i}`}
          tone="amber"
          label={issueLabel(labelPath)}
          text={i18n._(reasonMessage(reason))}
          onFocus={field === null ? null : () => void onFocusField(field)}
        />
      ))}
      {more > 0 && (
        <li className="px-2 text-xs text-muted-foreground">
          <Trans>і ще {more}</Trans>
        </li>
      )}
    </ul>
  )
}
