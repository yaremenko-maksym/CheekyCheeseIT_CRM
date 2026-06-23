import { useDroppable } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ExternalLink, Phone } from 'lucide-react'
import { Link } from '@tanstack/react-router'
import type { InterviewDto, InterviewStage } from '@crm/shared'
import { cn } from '@/lib/utils'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { getInitials } from '@/components/users/UserAvatar'
import { COLUMN_BG, COLUMN_HEADER_BG, STAGE_COLORS, STAGE_LABELS, formatDate } from '../constants'

// ── Sortable card ─────────────────────────────────────────────────────────

export function InterviewCard({
  interview,
  onClick,
  draggable = true,
}: {
  interview: InterviewDto
  onClick: () => void
  draggable?: boolean
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: interview.id,
    disabled: !draggable,
  })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={onClick}
      className={cn(
        'group rounded-lg border border-border/60 border-l-4 bg-card p-3',
        'cursor-pointer select-none',
        'hover:border-border hover:bg-accent/20 hover:shadow-sm',
        'transition-all duration-150',
        STAGE_COLORS[interview.stage],
      )}
    >
      {/* Company name — primary, truncated */}
      <p className="font-semibold text-sm text-foreground truncate leading-tight">
        {interview.companyName}
      </p>

      {/* Links row — vacancy + call chip */}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {interview.vacancyUrl && (
          <a
            href={interview.vacancyUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            aria-label="Открыть вакансию"
            className={cn(
              'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5',
              'text-xs text-muted-foreground',
              'bg-muted/50 hover:bg-muted hover:text-foreground',
              'transition-colors duration-150',
              'min-h-[28px]', // touch target ≥44px satisfied by combined row
            )}
          >
            <ExternalLink className="h-3 w-3 shrink-0" />
            <span>Вакансия</span>
          </a>
        )}

        {interview.callUrl && (
          <a
            href={interview.callUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            aria-label="Присоединиться к звонку"
            className={cn(
              'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5',
              'text-xs text-muted-foreground',
              'bg-muted/50 hover:bg-muted hover:text-foreground',
              'transition-colors duration-150',
              'min-h-[28px]',
            )}
          >
            <Phone className="h-3 w-3 shrink-0" />
            <span>Звонок</span>
          </a>
        )}
      </div>

      {/* Footer row — HR avatar link + date */}
      <div className="mt-2 flex items-center justify-between gap-2">
        {interview.hrName && interview.hrId ? (
          <Link
            to="/profile/$userId"
            params={{ userId: interview.hrId }}
            onClick={(e) => e.stopPropagation()}
            aria-label={`Профиль HR: ${interview.hrName}`}
            className={cn(
              'flex items-center gap-1.5 min-w-0',
              'rounded-md p-0.5 -m-0.5',
              'hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              'transition-colors duration-150',
              // Touch target: avatar 20px + padding ≥ 28px; combined with margin expansion
            )}
          >
            <Avatar className="h-5 w-5 shrink-0 text-[10px]">
              <AvatarFallback className="text-[9px] font-medium">
                {getInitials(interview.hrName)}
              </AvatarFallback>
            </Avatar>
            <span className="text-xs text-muted-foreground truncate max-w-[60px] leading-none">
              {interview.hrName}
            </span>
          </Link>
        ) : interview.hrName ? (
          // hrName without hrId — fallback to plain text (no link target)
          <div className="flex items-center gap-1.5 min-w-0">
            <Avatar className="h-5 w-5 shrink-0 text-[10px]">
              <AvatarFallback className="text-[9px] font-medium">
                {getInitials(interview.hrName)}
              </AvatarFallback>
            </Avatar>
            <span className="text-xs text-muted-foreground truncate max-w-[60px] leading-none">
              {interview.hrName}
            </span>
          </div>
        ) : null}

        <span className="text-xs text-muted-foreground/70 ml-auto tabular-nums shrink-0">
          {formatDate(interview.createdAt)}
        </span>
      </div>
    </div>
  )
}

// ── Static overlay card used during drag ─────────────────────────────────

export function InterviewCardStatic({ interview }: { interview: InterviewDto }) {
  return (
    <div
      className={cn(
        'rounded-lg border border-border/60 border-l-4 bg-card p-3',
        'shadow-2xl cursor-grabbing select-none opacity-95',
        STAGE_COLORS[interview.stage],
      )}
    >
      <p className="font-semibold text-sm text-foreground truncate leading-tight">
        {interview.companyName}
      </p>
      <div className="mt-2 flex items-center justify-between gap-2">
        {interview.hrName && (
          <div className="flex items-center gap-1.5 min-w-0">
            <Avatar className="h-5 w-5 shrink-0">
              <AvatarFallback className="text-[9px] font-medium">
                {getInitials(interview.hrName)}
              </AvatarFallback>
            </Avatar>
            <span className="text-xs text-muted-foreground truncate max-w-[60px]">
              {interview.hrName}
            </span>
          </div>
        )}
        <span className="text-xs text-muted-foreground/70 ml-auto tabular-nums shrink-0">
          {formatDate(interview.createdAt)}
        </span>
      </div>
    </div>
  )
}

// ── Kanban column ─────────────────────────────────────────────────────────

export function KanbanColumn({
  stage,
  interviews: cards,
  onCardClick,
  canDrag = true,
}: {
  stage: InterviewStage
  interviews: InterviewDto[]
  onCardClick: (interview: InterviewDto) => void
  canDrag?: boolean
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage })

  return (
    <div
      className={cn('flex flex-col min-w-44 w-44 shrink-0 rounded-xl p-2 h-full', COLUMN_BG[stage])}
    >
      {/* Column header — stage label + card count */}
      <div
        className={cn(
          'mb-2 flex items-center gap-2 rounded-lg px-2 py-1.5 shrink-0',
          COLUMN_HEADER_BG[stage],
        )}
      >
        <span className="font-semibold text-xs truncate tracking-wide uppercase opacity-80">
          {STAGE_LABELS[stage]}
        </span>
        <span
          className={cn(
            'ml-auto shrink-0 tabular-nums',
            'text-xs font-medium rounded-full px-1.5 py-0.5',
            'bg-black/10 dark:bg-white/10',
          )}
        >
          {cards.length}
        </span>
      </div>

      {/* Drop zone + card list */}
      <SortableContext items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
        <div
          ref={setNodeRef}
          className={cn(
            'flex flex-col gap-2 flex-1 overflow-y-auto rounded-lg p-1 transition-colors duration-150',
            isOver && 'bg-white/5 ring-1 ring-border/40',
          )}
        >
          {cards.map((card) => (
            <InterviewCard
              key={card.id}
              interview={card}
              onClick={() => onCardClick(card)}
              draggable={canDrag}
            />
          ))}
        </div>
      </SortableContext>
    </div>
  )
}
