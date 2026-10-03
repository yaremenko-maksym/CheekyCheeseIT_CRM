import { Fragment } from 'react'
import type { I18n } from '@lingui/core'
import { msg, select } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { useNavigate } from '@tanstack/react-router'
import { ArrowRight } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useLocale } from '@/lib/i18n'
import { DOCUMENT_STATUS_MESSAGES } from '@/components/documents/document-labels'
import { ProjectApprovalActions } from '@/components/projects/ProjectApprovalActions'
import { CancelPendingShareButton } from '@/components/pending-share/cancel-pending-share'
import { SeniorShareApprovalActions } from '@/components/pending/SeniorShareApprovalActions'
import { renderPendingTitle, resolveProposer } from '@/components/pending/pending-title'
import { formatRelativeTime } from '@crm/shared'
import type { Locale, PendingItem, PendingItemOrUnknown } from '@crm/shared'

export type PendingZone = 'mine' | 'proposedByMe'

/** Relative time through the shared `formatRelativeTime` (the same helper
 * the documents/invoices cards use — task-i18n-stage3e-pr4 dropped the local
 * `date-fns/ru` duplicate, which was Russian-only). `Intl.RelativeTimeFormat`
 * throws a RangeError on an unparsable date, so the raw string is shown
 * instead of crashing the whole screen. */
function fmtRelative(iso: string, locale: Locale): string {
  try {
    return formatRelativeTime(iso, locale)
  } catch {
    return iso
  }
}

/** `subjectType` is the server's own answer to "which endpoint family does
 * this row's action belong to" — required and closed (`'USER' | 'PROJECT'`,
 * see its doc in `@crm/shared`'s `pending.ts`), so there is no missing-value
 * case to guess at any more: integration decision 1, 2026-09-11. */
function shareScopeOf(item: PendingItem): 'user' | 'project' {
  return item.subjectType === 'USER' ? 'user' : 'project'
}

/**
 * One piece of the meta line. `nowrap` marks the phrases a line break must
 * never split — the relative time («меньше минуты назад») and the
 * «X% → Y%» pair — both of which the AC7 screenshot caught broken in half at
 * 320px (COPY-M-5, fix-round 3). Segments are joined by a BREAKABLE « · »,
 * so the wrap moves to the separator instead of into a phrase.
 */
type MetaSegment = { text: string; nowrap?: boolean }

/**
 * A line always has at least one segment — every branch of `metaLinesFor`
 * below ends with the relative time. Spelled as a non-empty tuple so the
 * JSX key can read `line[0].text` outright: an `?.` there would be an
 * unfalsifiable branch (no input can produce an empty line), which the
 * mutation gate rightly reports as a surviving mutant.
 */
type MetaLine = [MetaSegment, ...MetaSegment[]]

/**
 * Lines, not a string: a `proposedByMe` share row puts the numbers on their
 * own line and «Ждём: …» on the next, exactly as design spec §6.4 draws it.
 * That also removes the longest string on the screen as a class, rather than
 * making it break in a nicer place.
 */
function metaLinesFor(
  item: PendingItemOrUnknown,
  zone: PendingZone,
  locale: Locale,
  i18n: I18n,
): MetaLine[] {
  const rel: MetaSegment = { text: fmtRelative(item.createdAt, locale), nowrap: true }
  // `in` rather than a plain read: COPY-L-6's degraded row (`kind: 'UNKNOWN'`)
  // carries no `waitingFor` at all — it carries nothing beyond the four
  // structural fields.
  const waiting: MetaSegment | null =
    'waitingFor' in item && item.waitingFor?.length
      ? { text: i18n._(msg`Чекаємо: ${item.waitingFor.join(', ')}`) }
      : null

  if (item.kind === 'PROJECT_APPROVAL') {
    if (zone === 'proposedByMe') {
      return [waiting ? [waiting, rel] : [rel]]
    }
    // COPY-H-1 (fix-round 3): present tense. `proposedBy` is a displayName
    // carrying no gender, so the past tense «Предложил» was wrong for half
    // the names it can hold — the same defect #648 already fixed once by
    // switching to «Подтверждает {имя}».
    const proposer = resolveProposer(i18n, item.proposedBy)
    return [proposer ? [{ text: i18n._(msg`Пропонує ${proposer}`) }, rel] : [rel]]
  }

  if (item.kind === 'SHARE_APPROVAL') {
    const pct = item.pendingPercent
    const cur = item.currentPercent
    // Four wordings of ONE phrase (task-i18n-stage3e-pr4, K-docs): who is
    // speaking (the reader proposed it → «запропоновано»; someone proposes it
    // to the reader → «пропонують») × whether the current figure is known.
    // An ICU `select` keeps all four in ONE catalog entry, so each language
    // can reorder them; the percentages are plain placeholders — a `%`
    // figure takes no plural form.
    const variant =
      zone === 'proposedByMe'
        ? cur != null
          ? 'proposedFrom'
          : 'proposedNew'
        : cur != null
          ? 'proposingFrom'
          : 'proposingNew'
    // Stryker disable next-line ObjectLiteral,StringLiteral: Lingui's select() macro must read this options object as a literal at compile time (the `{}` mutant makes the transform throw before any test runs); `other` is unreachable — `variant` is one of the four keys above
    const leadText = select(variant, {
      // Stryker disable next-line StringLiteral: a multi-line options object needs its own per-line disable ("next-line" does not cascade past the opening brace); the select() macro must read each message as a literal at compile time — see the ObjectLiteral directive above
      proposedFrom: `Зараз ${cur}% → запропоновано ${pct}%`,
      // Stryker disable next-line StringLiteral: a multi-line options object needs its own per-line disable ("next-line" does not cascade past the opening brace); the select() macro must read each message as a literal at compile time — see the ObjectLiteral directive above
      proposedNew: `Запропоновано ${pct}%`,
      // Stryker disable next-line StringLiteral: a multi-line options object needs its own per-line disable ("next-line" does not cascade past the opening brace); the select() macro must read each message as a literal at compile time — see the ObjectLiteral directive above
      proposingFrom: `Зараз ${cur}% → пропонують ${pct}%`,
      // Stryker disable next-line StringLiteral: a multi-line options object needs its own per-line disable ("next-line" does not cascade past the opening brace); the select() macro must read each message as a literal at compile time — see the ObjectLiteral directive above
      proposingNew: `Пропонують ${pct}%`,
      // Stryker disable next-line StringLiteral: a multi-line options object needs its own per-line disable ("next-line" does not cascade past the opening brace); the select() macro must read each message as a literal at compile time — see the ObjectLiteral directive above
      other: `${pct}%`,
    })
    const lead: MetaSegment = { text: leadText, nowrap: true }
    if (zone === 'proposedByMe') {
      // COPY-M-4: for a USER-scope share the approver IS the subject, and
      // the title now names them («Доля по умолчанию — Имя»). Printing
      // «Ждём: Имя» two lines below repeated the same name twice.
      const who = item.subjectType === 'USER' ? null : waiting
      // COPY-M-8 (fix-round 4): the two-line split earns its keep at THREE
      // segments (numbers + «Ждём: …» + давность), which is the case
      // COPY-M-5 measured. Once COPY-M-4 removes «Ждём» there are two left,
      // and keeping them apart gave давность — the least significant token
      // on the screen — a whole line, in a zone whose neighbouring rows
      // print their meta on one. At 320px nothing changes (the wrap moves
      // to the « · » either way); at 768+ it is one line less per row.
      return who ? [[lead], [who, rel]] : [[lead, rel]]
    }
    return [[lead, rel]]
  }
  // CONTRACT_TO_SIGN (§6.3) and the AC6 unknown-kind default branch (§6.5)
  // both render давность only — no "от кого" (see use-pending-items.ts's
  // `proposedBy` doc: nobody "proposes" a contract the same way).
  return [[rel]]
}

function OpenLink({ item, primary }: { item: PendingItemOrUnknown; primary?: boolean }) {
  const navigate = useNavigate()
  // Same try/catch + hard-navigation fallback as notifications-bell.tsx's
  // `handleItemClick` — `item.link` is server data, not a route literal
  // TanStack Router's typed `Link` can validate at compile time.
  function handleOpen() {
    try {
      void navigate({ to: item.link as never })
    } catch {
      window.location.assign(item.link)
    }
  }
  return (
    <Button
      type="button"
      // Stryker disable next-line StringLiteral: verified empirically against `class-variance-authority` (cva) — an empty-string variant key falls back to `defaultVariants.variant` ('default'), IDENTICAL output to the literal `'default'` here (`buttonVariants({variant: ''})` and `buttonVariants({variant: 'default'})` produce the same class string). Only the 'ghost' → '' half of this ternary is genuinely observable, and it already has its own killing test (see "not.toHaveClass('bg-primary')").
      variant={primary ? 'default' : 'ghost'}
      size="sm"
      className="h-11 gap-1 sm:h-7"
      onClick={handleOpen}
      data-testid={`pending-item-open-${item.subjectId}`}
    >
      <Trans>Відкрити</Trans>
      <ArrowRight className="h-3 w-3" aria-hidden />
    </Button>
  )
}

function renderActions(item: PendingItemOrUnknown, zone: PendingZone, onActed: () => void) {
  const has = (a: PendingItemOrUnknown['actions'][number]) => item.actions.includes(a)

  if (item.kind === 'PROJECT_APPROVAL') {
    if (zone === 'mine' && has('approve') && has('reject')) {
      return (
        <ProjectApprovalActions
          projectId={item.subjectId}
          companyName={item.titleParams.projectName}
          onActed={onActed}
        />
      )
    }
    // §6.4: proposedByMe (ADMIN observer) — no revoke endpoint in main for a
    // project draft (task «Допущения») — 'open' only.
    return has('open') ? <OpenLink item={item} /> : null
  }

  if (item.kind === 'SHARE_APPROVAL') {
    if (zone === 'mine' && has('approve') && has('reject')) {
      return (
        <SeniorShareApprovalActions
          scope={shareScopeOf(item)}
          id={item.subjectId}
          onActed={onActed}
        />
      )
    }
    if (zone === 'proposedByMe' && has('cancel')) {
      return (
        <CancelPendingShareButton
          scope={shareScopeOf(item)}
          id={item.subjectId}
          pendingPercent={item.pendingPercent ?? 0}
          onActed={onActed}
        />
      )
    }
    return has('open') ? <OpenLink item={item} /> : null
  }

  if (item.kind === 'CONTRACT_TO_SIGN') {
    // §6.3: single primary CTA, no approve/reject on this screen at all —
    // signing stays in ContractTab/ContractActionBar (task «Границы»).
    return has('open') ? <OpenLink item={item} primary /> : null
  }

  // AC6 — unknown kind never crashes the screen: 'open' if offered, else
  // nothing (no guess at what other actions would even mean).
  return has('open') ? <OpenLink item={item} /> : null
}

export interface PendingItemRowProps {
  item: PendingItemOrUnknown
  zone: PendingZone
  onActed: () => void
}

/**
 * task-pending-screen design spec §6. One row shape for every `kind` — the
 * differences are confined to `metaFor`/`renderActions` above, not to the
 * JSX skeleton, matching §9's "один и тот же .item-row на всех классах
 * устройств" decision.
 *
 * Renders a `<div>`, not the `<li>` — `PendingKindSection` supplies the
 * `<motion.li>` wrapper (design spec §11's AnimatePresence/exit animation
 * needs to own the actual list-item node so the whole row — border, padding,
 * everything — collapses together, not just its content).
 */
export function PendingItemRow({ item, zone, onActed }: PendingItemRowProps) {
  const { t, i18n } = useLingui()
  const locale = useLocale()
  const title = renderPendingTitle(i18n, item) ?? t`Запит на дію`
  return (
    <div
      className={cn(
        'flex flex-wrap items-center justify-between gap-2.5 rounded-md border px-3 py-2.5',
        zone === 'proposedByMe'
          ? 'border-amber-500/30 bg-amber-500/[0.06]'
          : 'border-border/40 bg-muted/20',
      )}
      data-testid={`pending-item-row-${item.kind}-${item.subjectId}`}
      // Design spec §12: not reachable by Tab (it is a container, not a
      // control — `-1`, never `0`), but focusable programmatically so the
      // page can land focus HERE when the row above it disappears from
      // under the user. Without it `.focus()` is a no-op on a plain div and
      // focus falls back to <body>.
      tabIndex={-1}
    >
      {/* Design spec §9 (mobile): "заголовок+мета на всю ширину, кнопки на
          следующей строке". `flex-wrap` alone does not produce that — a
          `flex-1 min-w-0` text column SHRINKS instead of forcing the actions
          onto the next line, and at 320px that left the meta line wrapping
          inside a ~60px gutter beside the buttons (seen in the AC7
          screenshot, not in any assertion: nothing overflowed, it was just
          unreadable). `w-full` below `sm:` is what actually makes the two
          blocks stack. */}
      <div className="w-full min-w-0 sm:flex-1">
        {item.kind === 'CONTRACT_TO_SIGN' ? (
          // §6.3: title and badge are SEPARATE flex items (each wraps on its
          // own) — the exact defect the design doc's own mock caught on
          // 320px when they shared one `<p>` (see design spec §6.3's own
          // writeup of that fix).
          <div className="item-title-row flex flex-wrap items-center gap-1.5">
            <p className="min-w-10 flex-1 truncate text-sm font-medium" title={title}>
              {title}
            </p>
            <Badge variant="default" className="flex-none">
              {/* COPY-M-2 (fix-round 3) / COPY-H-docs-4 (wave e): the SAME status of
                  the same object reads the same everywhere — the wording lives
                  in the documents hub (`DOCUMENT_STATUS_MESSAGES`), the one
                  canon `document-status-badge` also renders. */}
              {i18n._(DOCUMENT_STATUS_MESSAGES.READY_TO_SIGN)}
            </Badge>
          </div>
        ) : (
          // §10.4: one line + truncate from 640px up, 2-line wrap-anywhere
          // below it — an 80-char project/share title must not push the
          // action buttons off the row (AC7).
          // UX-M-1: `title` = the full rendered string, so a truncated name
          // (768px uk: «Частка за замовчуванням — {seniorName}») stays
          // reachable by hover / long-press.
          <p
            className="line-clamp-2 wrap-anywhere text-sm font-medium sm:line-clamp-none sm:truncate"
            title={title}
          >
            {/* COPY-L-4 (fix-round 3) / design spec §6.5: a forward-compatible
                unknown kind with no title used to render a row of nothing but
                a date — the graceful degradation stopped being honest exactly
                where it exists for. */}
            {title}
          </p>
        )}
        <div data-testid={`pending-item-meta-${item.subjectId}`}>
          {metaLinesFor(item, zone, locale, i18n).map((line) => (
            <p key={line[0].text} className="mt-0.5 text-[11.5px] text-muted-foreground">
              {line.map((seg, i) => (
                <Fragment key={seg.text}>
                  {i > 0 ? ' · ' : null}
                  <span className={seg.nowrap ? 'whitespace-nowrap' : undefined}>{seg.text}</span>
                </Fragment>
              ))}
            </p>
          ))}
        </div>
        {/* UX-H-1 (fix-round 3, design review round 1): the viewer's own
            share on the project they are being asked to join. Verbatim the
            line `PendingProjectApprovalsPanel` already shows for the same
            data — the two surfaces are one «все →» click apart, so one
            wording. It matters most for a DROP: they have no route access to
            `/projects` at all and this row offers no «Відкрити», so without
            it «Подтвердить» is a yes given blind. `text-[11px]
            text-amber-300/70` and not the `tabular-nums font-medium` of a
            SHARE_APPROVAL row — here the percent is context for the
            decision, not the decision itself. */}
        {/* COPY-M-12 (fix-round 4): and the NEGATIVE half of it, verbatim
            from the widget as well. A missing figure gets a whole
            replacement sentence rather than silence: these are the same rows
            the widget lists, so a DROP reading «Доля неизвестна» on the
            dashboard and nothing here — with «Подтвердить» under both — is
            the blind «да» UX-H-1 exists to prevent, just in its other
            branch. `line-clamp-2`, not `truncate`, for the same reason the
            widget uses it (#646 fix-round 4: at 320px truncate cut off the
            actionable half of the sentence). */}
        {item.kind === 'PROJECT_APPROVAL' &&
          zone === 'mine' &&
          (item.viewerSharePercent != null ? (
            <p className="mt-0.5 text-[11px] text-amber-300/70">
              {item.seniorName ? (
                <Trans>
                  Ваша частка: {item.viewerSharePercent}% · сеньйор: {item.seniorName}
                </Trans>
              ) : (
                <Trans>Ваша частка: {item.viewerSharePercent}%</Trans>
              )}
            </p>
          ) : (
            <p className="mt-0.5 line-clamp-2 text-[11px] text-amber-300/70">
              <Trans>
                Частка не прийшла із сервера. Не підтверджуйте наосліп — запитайте адміна
              </Trans>
            </p>
          ))}
      </div>
      <div className="w-full sm:w-auto sm:flex-none">{renderActions(item, zone, onActed)}</div>
    </div>
  )
}
