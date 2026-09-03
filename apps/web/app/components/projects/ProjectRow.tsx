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
  const pendingCaption = isPending
    ? seniorStillPending && dropStillPending
      ? `от ${project.seniorName} и дропа`
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
      <div
        className="grid items-center gap-3 px-3 py-3 min-h-19"
        style={{ gridTemplateColumns: '3fr 1.4fr 1.4fr 1.2fr 1fr' }}
      >
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
        <div className="flex items-center gap-2 min-w-0">
          {project.seniorId != null ? (
            <>
              <Avatar className="h-7 w-7 shrink-0">
                <AvatarFallback className="text-[10px] font-semibold bg-primary/20 text-primary">
                  {getInitials(project.seniorName ?? '')}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground/70 font-semibold">
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
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground/70 font-semibold">
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
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground/70 font-semibold">
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
        <div className="flex flex-col items-end justify-center text-right">
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
          className="flex min-w-0 max-w-full flex-col items-end gap-1"
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
                <p
                  className="max-w-40 truncate text-[11px] text-amber-300/80"
                  title={viewerAlreadyActedCaption ?? pendingCaption ?? undefined}
                >
                  {viewerAlreadyActedCaption ?? pendingCaption}
                </p>
              )}
              {canAct && (
                <div className="mt-1">
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
                <p
                  className="max-w-40 truncate text-[11px] text-destructive/90"
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
