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
export function ProjectRow({ project, viewerRole, viewerId }: ProjectRowProps) {
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
                    copy-reviewer's own attached screenshot). `hidden
                    lg:block` — not `truncate` — because the role is already
                    readable from the avatar + column position alone below
                    `lg`, matching the orchestrator's own minimal-text-axis
                    instruction (not a grid refactor, spec §11 stays intact
                    at md+). */}
                <p className="hidden text-[10px] uppercase tracking-wide text-muted-foreground/70 font-semibold lg:block">
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
                    into the neighbor instead of wrapping). */}
                <p className="hidden text-[10px] uppercase tracking-wide text-muted-foreground/70 font-semibold lg:block">
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
                    into the neighbor instead of wrapping). */}
                <p className="hidden text-[10px] uppercase tracking-wide text-muted-foreground/70 font-semibold lg:block">
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
          className="col-span-4 flex min-w-0 max-w-full flex-row flex-wrap items-center justify-start gap-2 lg:col-span-1 lg:flex-col lg:items-end lg:justify-center lg:gap-1"
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
              <Badge
                variant="outline"
                className="gap-1 border-amber-500/30 bg-amber-500/20 text-[10px] text-amber-300"
                data-testid={`project-row-${project.id}-status-pending`}
              >
                <Clock className="h-3 w-3" aria-hidden />
                Ждёт подтверждения
              </Badge>
              {(viewerAlreadyActedCaption ?? pendingCaption) && (
                // UX-H-1: fixed max-w-40 (TransactionRow.tsx:666 precedent),
                // not max-w-full — see the container comment above for why
                // max-w-full alone never actually caps this text's width.
                // COPY-H-2: the viewer's own first-person caption
                // (`viewerAlreadyActedCaption`) takes priority over the
                // generic "who's still pending" one when the viewer is the
                // invited approver who already acted.
                // COPY-M-9 = UX-L-2(r3) (PR #646 fix-round 3): `max-w-40`
                // (160px) was sized for the OLD narrow status column — below
                // `lg:` this now lives in a full-width second row with ~230px
                // available, capping at 160px regardless leaves real idle
                // space while still truncating a caption one character
                // longer. `max-w-full` below `lg:`, back to the original
                // `max-w-40` at `lg:`+ where the column really is narrow
                // again (byte-for-byte the pre-fix-round-2 layout).
                <p
                  className="max-w-full truncate text-[11px] text-amber-300/80 lg:max-w-40"
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
                <div className="lg:mt-1">
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
