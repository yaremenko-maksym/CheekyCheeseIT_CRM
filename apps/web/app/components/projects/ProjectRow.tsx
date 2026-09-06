import { Link } from '@tanstack/react-router'
import { Clock, XCircle } from 'lucide-react'
import type { ProjectDto } from '@crm/shared'
import type { Role } from '@/lib/route-access'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { ProjectLogo } from './ProjectLogo'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { ProjectApprovalActions } from './ProjectApprovalActions'

export type ProjectRowProps = {
  project: ProjectDto
  /**
   * task-senior-ui-followups §2b: the current viewer's role.
   * When `'SENIOR'`, an effective share % badge is rendered in the status
   * column — `seniorSharePercentOverride ?? seniorSharePercentDefault`.
   * Omitted / other roles → no change to the existing layout.
   */
  viewerRole?: Role | undefined
  /**
   * task-project-status-filter-ui. The current viewer's own user id — used
   * ONLY to decide whether to render the inline Confirm/Reject actions on a
   * DRAFT project (`viewerId === project.seniorId || project.dropId`, both
   * already role-masked by the backend, so this can never light up for a
   * viewer who isn't actually the invited approver). Omitted → actions
   * never render (defensive default, matches `viewerRole` above).
   */
  viewerId?: string | undefined
  /**
   * SR-L-7 (PR #646 fix-round 5, LOW — security review). `true` while the
   * `/projects` list query is a persisted snapshot that has not yet
   * finished a background refetch (`fetchStatus !== 'idle'` on the
   * `useQuery` call in `index.tsx` — see that call site's own comment).
   * ADMIN is the ONLY role that ever receives `rejectionReason` at all
   * (SR-M-5) — a REJECTED project reaching this component with `rejectionReason
   * === null` for that viewer is never a genuine fact from the server (the
   * backend always attaches one), it is what a stripped-and-not-yet-
   * refetched IndexedDB restore looks like (QA-H-3/SR-M-8, persister.ts).
   * Omitted (dashboards that never mount a REJECTED row anyway) → the old
   * "no reason paragraph" behaviour, unchanged.
   */
  reasonPending?: boolean | undefined
}

function getInitials(name: string) {
  return (name || '?')
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

const DATE_FORMAT_OPTS: Intl.DateTimeFormatOptions = {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
}

/**
 * Horizontal row-list layout for the /projects page (ut-41 + ut-42).
 *
 * Pattern mirrors `UserRow` (apps/web/app/components/users/UserRow.tsx):
 *  - Stretched-link via ::before pseudo-element: the entire row is clickable
 *    and navigates to the project detail page. Inner <a> tags for senior and
 *    junior names sit at a higher z-index (z-[2] > stretched-link z-[1]) and
 *    use onClick stopPropagation to intercept their own clicks.
 *  - No inline edit / archive controls (consistent with ut-27 + ut-38).
 *    Archive + Edit live on the project detail page header.
 *  - `data-testid="project-row-${id}"` for E2E; preserves the legacy
 *    `project-card-${id}` testid via the wrapper in the parent route so
 *    existing specs don't break.
 */
export function ProjectRow({ project, viewerRole, viewerId, reasonPending }: ProjectRowProps) {
  const isArchived = !!project.archivedAt
  // task-project-status-filter-ui (design spec §2/§7/§8). Draft/rejected are
  // a SEPARATE axis from archival (business spec §4.2 — never mixed): a
  // DRAFT/REJECTED project is never archived, so these three are mutually
  // exclusive with `isArchived` in practice, but `isArchived` is still
  // checked first below (defensive — matches this component's existing
  // priority for the badge column).
  const isPending = project.status === 'DRAFT'
  const isRejected = project.status === 'REJECTED'
  // Design spec §7: whoever the viewer is, show it — showing it for the
  // approver's OWN pending project too is redundant per the design's own
  // note ("можно не показывать вовсе") but not wrong, and keeping ONE
  // unconditional render path (no viewerRole branch) is simpler to reason
  // about and test than suppressing it for exactly one audience.
  //
  // SPEC-M-2 (PR #646 fix-round 1): names whoever is STILL PENDING
  // (`seniorApprovalPending`/`dropApprovalPending`, business spec §4.1
  // partial agreement), not whoever was merely INVITED — a project with
  // both a senior and a drop stays DRAFT after only one of them decides
  // (see `PendingProjectApprovalsPanel`'s own dismiss-fix for the same
  // underlying fact), so the earlier `project.dropId ? "...и дропа" : ...`
  // kept naming an already-decided drop. `?? true` only matters for a
  // cached/mocked DTO predating these two fields (`.optional()` on the
  // schema) — while genuinely DRAFT, "unknown" defaults to "still pending",
  // never to "already decided".
  const seniorStillPending = project.seniorApprovalPending ?? true
  const dropStillPending = !!project.dropId && (project.dropApprovalPending ?? true)
  // COPY-M-1 (PR #646 fix-round 2): the caption below is capped at
  // `max-w-40` (160px) and truncated with an ellipsis from the TAIL — a
  // long senior name used to push "и дропа" past that cap, so a viewer
  // reading "от Александра Мельниченко…" has no way to tell the drop is
  // ALSO still pending (SPEC-M-2's whole point — naming everyone who
  // hasn't decided — silently undone by truncation on exactly the names
  // long enough to need it). `seniorName` is safe to truncate here because
  // it is ALSO printed, untruncated up to its own cap, in the row's own
  // "Синьор" column — losing characters off the END of THIS copy costs
  // nothing. `dropName` has no such second location on this row, so it (or
  // the generic "дропа" fallback) goes first, where truncation can never
  // reach it.
  const pendingCaption = isPending
    ? seniorStillPending && dropStillPending
      ? `от ${project.dropName ?? 'дропа'} и ${project.seniorName}`
      : seniorStillPending
        ? `от ${project.seniorName}`
        : dropStillPending
          ? 'от дропа'
          : null
    : null
  // §Что сделать item 3: the card's own Confirm/Reject — for whoever reaches
  // this row AND is actually the invited approver (identity check, not role
  // check — correctly covers the admin-as-senior edge case too). Both ids
  // are already backend-masked per viewer (null for JUNIOR, null for a
  // non-privileged viewer of an admin-owned project), so this can never
  // light up for someone who isn't genuinely the approver.
  const viewerIsSenior = !!viewerId && viewerId === project.seniorId
  const viewerIsDrop = !!viewerId && viewerId === project.dropId
  // CR-H-1 (PR #646 fix-round 1) / CR-H-1 comment kept accurate for
  // fix-round 2's rewrite: `canAct` is read only inside the
  // `isPending ? (...)` JSX branch below, so on an ACTIVE project that
  // branch never renders and `canAct`'s value never reaches the DOM — the
  // `isPending &&` gate is exercised only by DRAFT-status tests, same as
  // before this rewrite.
  //
  // COPY-H-2 (PR #646 fix-round 2): `viewerIsInvitedApprover` alone used to
  // be enough — but on a two-approver project, the viewer's OWN
  // `seniorApprovalPending`/`dropApprovalPending` can already be `false`
  // (they confirmed, the project stays DRAFT waiting on the OTHER party)
  // while `isPending` is still `true`. The button must gate on "I,
  // specifically, still owe a decision", not "I was invited, ever" — the
  // old `canAct` kept the button live for a second click that only ever
  // produced a silent 409.
  const canAct =
    isPending && ((viewerIsSenior && seniorStillPending) || (viewerIsDrop && dropStillPending))
  // COPY-H-2: the viewer already acted (they are an invited approver, but
  // their OWN half is done) — replace the generic pendingCaption (which
  // names whoever is STILL pending, useful to ADMIN/a third party) with a
  // first-person one, symmetric for senior/drop. `null` for anyone who is
  // not an invited approver at all — they get the generic caption instead.
  const viewerAlreadyActedCaption =
    isPending && viewerIsSenior && !seniorStillPending
      ? 'Вы подтвердили. Ждём дропа'
      : isPending && viewerIsDrop && !dropStillPending
        ? 'Вы подтвердили. Ждём синьора'
        : null
  // §2b: effective share % for SENIOR viewer.
  const seniorSharePct =
    viewerRole === 'SENIOR'
      ? (project.seniorSharePercentOverride ?? project.seniorSharePercentDefault)
      : null
  const activeMembers = project.members.filter((m) => m.leftAt === null)
  const activeJuniors = activeMembers.filter((m) => m.role === 'JUNIOR')
  const firstJunior = activeJuniors[0]
  const remainingJuniors = activeJuniors.length - 1

  return (
    <div
      data-testid={`project-row-${project.id}`}
      data-project-id={project.id}
      data-archived={isArchived ? 'true' : undefined}
      data-project-status={project.status}
      className={cn(
        'group/row relative rounded-md border border-transparent transition-colors',
        'hover:bg-muted/40 hover:border-border/40',
        // §8: REJECTED reads the same "historical, awaiting manual cleanup"
        // treatment archived already has. §7: DRAFT is the opposite —
        // requires attention NOW, so it stays full-opacity and gets a thin
        // accent ring instead (same pattern as invoice-card.tsx's
        // "ожидается ваша подпись").
        (isArchived || isRejected) && 'opacity-60 hover:opacity-80',
        isPending && 'ring-1 ring-amber-500/20',
      )}
    >
      {/* COPY-H-3 = QA-H-1 (PR #646 fix-round 2). Below 1024px the status
          column (badge + caption + Confirm/Reject) visually overlapped the
          rate/date and senior columns — QA's screenshots confirmed it AT
          768px specifically, clean only from 1024px up. The review's own
          note said "<md (до 1024)", a self-contradiction (Tailwind's `md`
          is 768px); resolved toward the numeric "до 1024" since that is
          what QA's evidence actually pins — hence `lg:` (1024px) below, not
          `md:`. Orchestrator's decision (A1, reversible): do not redesign
          the grid — only the status column relocates, to a second row
          spanning full width, below `lg:`; at `lg:`+ this is byte-for-byte
          the original single-row 5-column grid (same ratios, now expressed
          as Tailwind arbitrary values instead of an inline style so they
          can vary by breakpoint at all — grid-template-columns cannot be
          responsive as a plain inline style). Grid auto-placement (default
          `grid-auto-flow: row`) puts the status column on its own row with
          no explicit row-start needed: at `<lg` it is 4 columns wide
          (col-span-4) but the FIRST row already holds exactly 4 same-width
          items (project/senior/junior/rate), so it doesn't fit and wraps —
          at `lg:` it is back to col-span-1, fits in the row's 5th slot. */}
      <div className="grid items-center gap-3 px-3 py-3 min-h-19 grid-cols-[3fr_1.4fr_1.4fr_1.2fr] lg:grid-cols-[3fr_1.4fr_1.4fr_1.2fr_1fr]">
        {/* Project info column — logo + name + company */}
        <div className="flex items-center gap-3 min-w-0">
          <ProjectLogo
            documentId={project.logoDocumentId}
            externalUrl={project.logoExternalUrl}
            companyName={project.companyName}
            fallback={getInitials(project.companyName)}
            avatarClassName="h-10 w-10 shrink-0 rounded-lg border border-border [&_[data-slot=avatar-fallback]]:rounded-lg [&_[data-slot=avatar-fallback]]:text-xs [&_[data-slot=avatar-fallback]]:font-semibold"
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span
                aria-hidden
                data-testid={`project-row-${project.id}-status-dot`}
                className={cn(
                  'h-1.5 w-1.5 rounded-full shrink-0',
                  // §7/§8: DRAFT/REJECTED are a third/fourth dot value —
                  // same priority order as the row-level opacity/ring above.
                  isArchived
                    ? 'bg-muted-foreground/40'
                    : isPending
                      ? 'bg-amber-500'
                      : isRejected
                        ? 'bg-destructive/60'
                        : 'bg-emerald-500',
                )}
              />
              {/* Stretched-link pattern: ::before fills the row so any click in
                  non-actionable space navigates to the detail page. */}
              <Link
                to="/projects/$projectId"
                params={{ projectId: project.id }}
                aria-label={`Открыть проект ${project.companyName}`}
                className={cn(
                  'text-sm font-semibold truncate cursor-pointer hover:underline leading-tight',
                  "before:absolute before:inset-0 before:content-[''] before:z-[1]",
                )}
              >
                {project.companyName}
              </Link>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground truncate">{project.name}</p>
          </div>
        </div>

        {/* Senior column — seniorId/seniorName are null for JUNIOR viewers (identity masking). */}
        <div
          data-testid={`project-row-${project.id}-senior-column`}
          className="flex items-center gap-2 min-w-0"
        >
          {project.seniorId != null ? (
            <>
              <Avatar className="h-7 w-7 shrink-0">
                <AvatarFallback className="text-[10px] font-semibold bg-primary/20 text-primary">
                  {getInitials(project.seniorName ?? '')}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                {/* CR-H-2 = COPY-H-4 (PR #646 fix-round 3). At 320px this
                    column's own grid track is ~42.4px (1.4/7 of ~212px
                    content width) — the shrink-0 avatar (28px) + gap-2 (8px)
                    already consume 36px of that, leaving ~6.4px for this
                    div. The NAME below already clips correctly there
                    (`truncate` on the Link) — this LABEL never had that
                    class, and un-breakable Cyrillic uppercase text with no
                    `overflow-hidden` does not wrap (no valid break point
                    inside one word) — it renders past its own box, visibly
                    into the neighboring Джун column ("СИНЬОРДЖУН" on the
                    copy-reviewer's own attached screenshot).
                    COPY-M-11 (PR #646 fix-round 4, MED): `hidden` (below)
                    removed this label from the accessibility tree too, not
                    just the viewport — a mobile screen-reader user got two
                    bare names with no role at all. `sr-only lg:not-sr-only`
                    keeps the same VISUAL result (role readable from avatar +
                    column position alone below `lg`, matching the
                    orchestrator's own minimal-text-axis instruction — not a
                    grid refactor, spec §11 stays intact at md+) while
                    leaving the text in the DOM/AX tree at every width. */}
                <p className="sr-only text-[10px] uppercase tracking-wide text-muted-foreground/70 font-semibold lg:not-sr-only">
                  Синьор
                </p>
                {/* Inner link sits above the row-level stretched-link (z-[2] > z-[1]).
                    stopPropagation страховка на случай если bubbling доберётся до
                    row-level click handler в будущем. */}
                <Link
                  to="/profile/$userId"
                  params={{ userId: project.seniorId }}
                  onClick={(e) => e.stopPropagation()}
                  data-testid={`project-row-${project.id}-senior-link`}
                  className="relative z-[2] block text-xs font-medium truncate hover:underline hover:text-primary underline-offset-2"
                >
                  {project.seniorName}
                </Link>
              </div>
            </>
          ) : (
            /* JUNIOR viewer — senior identity masked by backend allowlist */
            <div
              className="h-7 w-7 shrink-0 rounded-full border border-dashed border-muted-foreground/20"
              aria-hidden
            />
          )}
        </div>

        {/* Junior column */}
        <div className="flex items-center gap-2 min-w-0">
          {firstJunior ? (
            <>
              <Avatar className="h-7 w-7 shrink-0">
                {firstJunior.avatarUrl && (
                  <AvatarImage src={firstJunior.avatarUrl} alt={firstJunior.displayName} />
                )}
                <AvatarFallback className="text-[10px] font-semibold">
                  {getInitials(firstJunior.displayName)}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                {/* CR-H-2 = COPY-H-4: same fix as the Синьор label above,
                    same mechanism (own grid track ~42.4px at 320px, no
                    truncate on this label, un-breakable Cyrillic overflows
                    into the neighbor instead of wrapping).
                    COPY-M-11 (PR #646 fix-round 4): same sr-only fix as the
                    Синьор label above — same reason (accessible below `lg`,
                    not just visually hidden). */}
                <p className="sr-only text-[10px] uppercase tracking-wide text-muted-foreground/70 font-semibold lg:not-sr-only">
                  Джун
                </p>
                {/* `<div>` (not `<p>`) used as the truncate parent because we
                    nest an inline `<a>` for the junior name. Keeps `+N` suffix
                    next to the name when present. */}
                <div className="text-xs font-medium truncate">
                  <Link
                    to="/profile/$userId"
                    params={{ userId: firstJunior.userId }}
                    onClick={(e) => e.stopPropagation()}
                    data-testid={`project-row-${project.id}-junior-link`}
                    className="relative z-[2] hover:underline hover:text-primary underline-offset-2"
                  >
                    {firstJunior.displayName}
                  </Link>
                  {remainingJuniors > 0 && (
                    <span className="text-muted-foreground/70 font-normal">
                      {' '}
                      +{remainingJuniors}
                    </span>
                  )}
                </div>
              </div>
            </>
          ) : (
            <>
              {/* Empty avatar slot keeps the text-block X-position consistent
                  with the «with-junior» branch so all columns share a baseline grid. */}
              <div
                className="h-7 w-7 shrink-0 rounded-full border border-dashed border-destructive/30"
                aria-hidden
              />
              <div className="min-w-0">
                {/* CR-H-2 = COPY-H-4: same fix as the Синьор label above,
                    same mechanism (own grid track ~42.4px at 320px, no
                    truncate on this label, un-breakable Cyrillic overflows
                    into the neighbor instead of wrapping).
                    COPY-M-11 (PR #646 fix-round 4): same sr-only fix as the
                    other two labels — same reason. */}
                <p className="sr-only text-[10px] uppercase tracking-wide text-muted-foreground/70 font-semibold lg:not-sr-only">
                  Джун
                </p>
                <p className="text-xs font-medium text-destructive/80 flex items-center gap-1.5 truncate">
                  <span
                    className="h-1.5 w-1.5 rounded-full bg-destructive/50 shrink-0"
                    aria-hidden
                  />
                  Нет джуна
                </p>
              </div>
            </>
          )}
        </div>

        {/* Rate + date column.
            rate / currency are null for JUNIOR viewers (finance masking, RBAC A01).
            Render an em-dash placeholder so the column still occupies its grid cell. */}
        <div
          data-testid={`project-row-${project.id}-rate-column`}
          className="flex flex-col items-end justify-center text-right"
        >
          <p className="text-sm font-semibold tabular-nums">
            {project.rate != null ? (
              <>
                {project.rate.toLocaleString()}{' '}
                <span className="text-xs text-muted-foreground font-normal">
                  {project.currency}
                </span>
              </>
            ) : (
              <span className="text-muted-foreground/40 italic text-xs">—</span>
            )}
          </p>
          <p className="text-[11px] text-muted-foreground/80 tabular-nums">
            {new Date(project.startDate).toLocaleDateString('uk-UA', DATE_FORMAT_OPTS)}
          </p>
        </div>

        {/* Status / badges column */}
        {/* UX-H-1 (PR #646 fix-round 1): `min-w-0` here mirrors column 1's own
            `min-w-0` above — a CSS grid item's default `min-width: auto`
            refuses to shrink below its content's intrinsic width, so without
            it a long pendingCaption/rejectionReason grows THIS column and
            steals width from every other column on the row (measured: senior
            name silently truncated on 1440px, columns 0-2 collapsed to 0px
            on 768/1024px). `max-w-full` on the text below only ever computes
            against this container's own (previously unconstrained) width, so
            it could never actually cap anything — see the two `max-w-40`
            fixes below, same fixed-width pattern already used for a
            same-purpose caption in TransactionRow.tsx. */}
        <div
          data-testid={`project-row-${project.id}-status-column`}
          // COPY-H-3 = QA-H-1: `col-span-4 lg:col-span-1` is the actual
          // overlap fix (see the grid container's own comment above) — this
          // block moves to its own full-width row below `lg:`. The
          // orientation flip (row below `lg:`, column at `lg:`+) is not
          // itself required by the finding (nothing overlaps either way
          // once this is its own row) but a lone right-aligned vertical
          // stack floating at the end of a full-width row reads as broken,
          // not fixed — "бейдж + подпись + кнопки" is also how the review
          // itself describes the second row, left-to-right.
          //
          // QA-H-2 (PR #646 fix-round 3, HIGH). `flex-wrap` above is base
          // (mobile: a horizontal badge+caption row that may need to wrap
          // onto a second row on narrow screens) — it was never overridden
          // at `lg:`, so it stayed ACTIVE inside `lg:flex-col` too, where it
          // means something completely different: "start a NEW flex line
          // (stacked in the CROSS axis — i.e. beside the first) whenever the
          // current line's main-axis (height) content doesn't fit." A DRAFT
          // project with BOTH approvers still pending gets a longer caption
          // ("от <дроп> и <синьор>" — COPY-M-1) than a single-approver one;
          // once that extra height pushed the [badge, caption] stack past
          // whatever implicit height this flex-column had, `flex-wrap`
          // pulled the BADGE into a second, empty flex line of its own —
          // with no sibling to share the line's width, it rendered at its
          // OWN max-content width (147.5625px measured), ignoring the
          // column's real ~83.5px budget entirely and running off the page.
          // A same-status project with only one approver pending (shorter
          // caption, fits in one line) never triggered the second line, so
          // its badge stayed correctly constrained (117.578px) — this is why
          // the bug tracked "which project has the longer caption", not
          // "which row is first" (verified directly: moving the drop-project
          // to the LAST list position kept the badge broken; two ordinary
          // single-approver projects showed zero asymmetry regardless of
          // position — see the task's own investigation, not a guess).
          // `lg:flex-nowrap` closes it: there is only ever [badge, caption]
          // here, always meant to stack in ONE column — verified live
          // (`element.style.flexWrap = 'nowrap'` on the broken instance
          // before writing this fix) that nowrap alone drops the badge back
          // to 117.578px with zero other changes.
          className="col-span-4 flex min-w-0 max-w-full flex-row flex-wrap items-center justify-start gap-2 lg:col-span-1 lg:flex-col lg:flex-nowrap lg:items-end lg:justify-center lg:gap-1"
        >
          {isArchived ? (
            <Badge
              variant="outline"
              className="border-amber-500/30 bg-amber-500/10 text-amber-500 text-[10px]"
            >
              В архиве
            </Badge>
          ) : isPending ? (
            <>
              {/* COPY-H-5 (PR #646 fix-round 4, HIGH). At `lg:` (1024px+) the
                  status column is a `1fr` track out of the row's 8fr total
                  (~86px at 1024px content width) — this badge's own
                  intrinsic content (icon + "Ждёт подтверждения", ~118px)
                  was WIDER than that track. `lg:items-end` (container,
                  above) aligns the badge flush to the column's RIGHT edge,
                  so the overflow pushed LEFT, into the rate/amount column's
                  text ("USDT" read as "USD" — copy-reviewer's own
                  pixel-measured repro). QA-H-2's own clip test only checks
                  `rect.right <= containerRight`, which stays true here (the
                  badge's right edge sits at the row's own right edge either
                  way) — it cannot see a LEFT-ward overlap into a sibling
                  column, a different defect class from the one it fixed.
                  Three changes, from cheapest to most defensive: (1) the
                  wording — "Ждёт решения" is already the name this exact
                  fact uses elsewhere (empty-state copy, one line above in
                  this same file's history) and is shorter; (2) the icon
                  hides below `xl` (1280px) — a color dot to its LEFT
                  already carries this same "needs attention" signal
                  (`status-dot`, above) at every width, so the icon is
                  decorative reinforcement, not the only proof state, safe
                  to drop where space is tight; (3) `truncate`/`min-w-0` as
                  a hard floor — overlapping a neighbor must never be
                  possible at ANY width, even one narrower than tested,
                  whereas a mid-word ellipsis on "Ждёт решения" is merely
                  ugly. See the E2E test's own rect-intersection check
                  (project-status-filter-ui.spec.ts) for the six widths this
                  was actually measured at.

                  COPY-L-8 = UX-M-2(r5) (PR #646 fix-round 5, MED). `truncate`
                  above never actually produced the "mid-word ellipsis" this
                  comment expected — `Badge` is `inline-flex` (badge.tsx),
                  and `text-overflow: ellipsis` has no effect on an
                  inline-flex box's own content (the CSS algorithm needs a
                  block container); the ~86px `lg:` track against this
                  badge's ~94px content (measured: E2E's own scrollWidth
                  check) instead cut the last glyph in half against the
                  border with no ellipsis at all. `lg:whitespace-normal`
                  lets the text wrap onto its OWN second line inside the
                  badge instead — same "row height growing is acceptable"
                  trade the orchestrator's decision made for the identical
                  symptom on the Confirm/Reject buttons below. No `xl:`
                  reversion needed (unlike the caption a few lines down):
                  once there is enough room the text renders on one line
                  under `white-space: normal` too, so this is safe to leave
                  active from `lg:` up rather than needing a second
                  breakpoint to undo it. */}
              <Badge
                variant="outline"
                className="min-w-0 max-w-full gap-1 truncate border-amber-500/30 bg-amber-500/20 text-[10px] text-amber-300 lg:whitespace-normal lg:text-center lg:leading-tight"
                data-testid={`project-row-${project.id}-status-pending`}
              >
                <Clock className="hidden h-3 w-3 xl:inline" aria-hidden />
                Ждёт решения
              </Badge>
              {(viewerAlreadyActedCaption ?? pendingCaption) && (
                // UX-H-1 / COPY-H-2 / COPY-M-9 = UX-L-2(r3): see git history
                // for the original max-w-40 (TransactionRow.tsx:666
                // precedent) reasoning.
                //
                // COPY-H-5 follow-up (PR #646 fix-round 4, found live
                // testing the finding's own fix, same symptom as the
                // ProjectApprovalActions overlap a few lines down, confirmed
                // with an A/B measurement — not assumed from the badge's
                // fix alone): with `lg:max-w-40` (160px), a real caption
                // ("от Oleksiy Kovalenko", short enough that the 160px cap
                // never actually engaged truncation) measured at a fixed
                // 109.7px wide at 1024 AND 1100px specifically — wider than
                // this column's real budget there (~100-112px) — so it read
                // 4-14px into the rate/amount column at exactly those two
                // widths (863px/940px caption start vs 878px/945px column
                // end); at 1249/1280 the column is wide enough that the
                // same 109.7px already cleared it, which is why this went
                // unnoticed until a viewport-by-viewport measurement.
                // Dropping the `lg:` override (matching the badge just
                // above, which has always been plain `max-w-full`, no `lg:`
                // exception) removed the fixed 160px ceiling; re-measured
                // after, the box now tracks the column's own available
                // width at every one of the six widths this file tests
                // (83.5-115.5px), with no overlap at any of them.
                //
                // COPY-M-12 = UX-L-3(r5) (PR #646 fix-round 5). Removing the
                // ceiling fixed the OVERLAP but exposed a different bug the
                // narrower single-approver caption above never triggered: a
                // BOTH-pending caption ("от <дроп> и <синьор>", COPY-M-1)
                // needs ~230-340px on one line — the plain `truncate` here
                // cuts the SECOND name entirely at `lg:` (1024-1279, ~86px
                // track), reading as if only one side is still pending.
                // `lg:line-clamp-2` (same mechanism the rejectionReason
                // paragraph a few lines down already uses) wraps onto a
                // second line instead of cutting content; `lg:whitespace-normal`
                // undoes `truncate`'s own `white-space: nowrap` (the two
                // utilities target the SAME property — Tailwind's `lg:`
                // variant, generated later, wins at this breakpoint). At
                // `xl:` (1280+) the column has grown enough that this was
                // never observed to clip (design review's own live check) —
                // `xl:truncate` (re-applies all three of `truncate`'s
                // declarations, including `white-space: nowrap`) and
                // `xl:line-clamp-none` (undoes the `-webkit-box` display
                // `line-clamp` needs) restore the ORIGINAL single-line
                // behaviour there, matching ProjectRow's own precedent
                // against mixing `truncate` and `line-clamp` active at the
                // same breakpoint (see the rejectionReason paragraph's own
                // comment on this exact hazard).
                <p
                  data-testid={`project-row-${project.id}-status-caption`}
                  // `lg:break-words`: a name like "Kovalenko"/"Drozhzhyn" is
                  // one unbreakable Latin/Cyrillic run — same reasoning as
                  // ProjectApprovalActions's own buttons, a few px of
                  // residual overflow (measured live) closed by allowing a
                  // break WITHIN a word that would otherwise overflow its
                  // wrapped line.
                  className="max-w-full truncate text-[11px] text-amber-300/80 lg:line-clamp-2 lg:whitespace-normal lg:break-words xl:line-clamp-none xl:truncate"
                  title={viewerAlreadyActedCaption ?? pendingCaption ?? undefined}
                >
                  {viewerAlreadyActedCaption ?? pendingCaption}
                </p>
              )}
              {canAct && (
                // COPY-H-3 = QA-H-1: the parent's own `gap-2`/`lg:gap-1`
                // already spaces this from its siblings on both layouts —
                // `mt-1` here would double that spacing in the row layout
                // (`<lg`), where it reads as an oversized gap before the
                // buttons rather than the small vertical breathing room it
                // was for in the original column layout.
                //
                // COPY-H-5 follow-up (PR #646 fix-round 4, found live testing
                // the finding's own fix): `max-w-full` on THIS div, not just
                // on ProjectApprovalActions's own root (which it also has —
                // see that component's doc). A percentage max-width resolves
                // against the CONTAINING BLOCK, i.e. this wrapper's box — but
                // this wrapper itself was never given a width, so in the
                // parent's `lg:flex-col lg:items-end` layout (flex items
                // size to their own content, not stretched to the column,
                // by design — see the badge's identical `max-w-full` need a
                // few lines up) it was ALSO sized to fit its child, making
                // "100% of me" resolve to "however wide my child already
                // wants to be": a no-op, measured live (adding max-w-full to
                // ProjectApprovalActions ALONE left the actions box at the
                // exact same 109.6px, still overlapping the rate column by
                // ~14px). The badge has no such wrapper — it is a direct
                // child of the actual column — which is why its OWN
                // `max-w-full` alone was already enough.
                <div className="max-w-full lg:mt-1">
                  <ProjectApprovalActions
                    projectId={project.id}
                    companyName={project.companyName}
                  />
                </div>
              )}
            </>
          ) : isRejected ? (
            <>
              <Badge
                variant="outline"
                className="gap-1 border-destructive/30 bg-destructive/10 text-[10px] text-destructive"
                data-testid={`project-row-${project.id}-status-rejected`}
              >
                <XCircle className="h-3 w-3" aria-hidden />
                Отклонено
              </Badge>
              {project.rejectionReason && (
                // UX-H-1: same fixed max-w-40 fix as pendingCaption above.
                // COPY-M-9 = UX-L-2(r3): same widen-below-lg fix as the
                // caption above, but SR-M-5 (fix-round 2) made this the
                // ONLY place ADMIN ever sees this text at all (not just a
                // convenience copy) — `line-clamp-2` instead of a single
                // truncated line below `lg:` uses the full-width row's real
                // estate to show meaningfully more of it (roughly the first
                // ~40 chars at 160px single-line vs ~2 lines' worth at
                // full width); `title` still carries the untruncated text
                // for the cases where even two lines isn't enough.
                // `lg:line-clamp-1` (not `lg:truncate`) — mixing `truncate`
                // (nowrap-based) with `line-clamp` (webkit-box-based) at a
                // breakpoint boundary leaves stale `display`/`-webkit-*`
                // properties from the smaller breakpoint active; staying on
                // the clamp mechanism at both sizes avoids that.
                <p
                  className="line-clamp-2 max-w-full text-[11px] text-destructive/90 lg:line-clamp-1 lg:max-w-40"
                  title={project.rejectionReason}
                >
                  «{project.rejectionReason}»
                </p>
              )}
              {/* SR-L-7 (PR #646 fix-round 5, LOW). See `reasonPending`'s own
                  doc above for why a null reason here, for ADMIN, while the
                  list query hasn't finished a background refetch, means
                  "still loading" rather than "the server has no reason" —
                  QA's own repro (fix-round 4 discussion) needed a real
                  service-worker'd prod build to reach the `fetchStatus:
                  'paused'` case this covers; the unit test models that
                  fetchStatus value directly rather than reproducing the
                  offline/PWA setup live. */}
              {!project.rejectionReason && viewerRole === 'ADMIN' && reasonPending && (
                <p
                  className="max-w-full text-[11px] italic text-muted-foreground/70"
                  data-testid={`project-row-${project.id}-status-reason-loading`}
                >
                  Причина загружается…
                </p>
              )}
            </>
          ) : (
            <Badge variant="outline" className="text-[10px]">
              {project.domain}
            </Badge>
          )}
          {/* §2b: share % badge — visible only for SENIOR viewer. */}
          {seniorSharePct != null && (
            <span
              className="rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-mono text-primary"
              data-testid={`project-row-${project.id}-senior-share`}
            >
              {seniorSharePct}%
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
