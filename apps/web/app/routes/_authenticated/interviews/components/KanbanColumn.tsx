import { useDroppable } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ExternalLink, Phone } from 'lucide-react'
import type { InterviewDto, InterviewStage } from '@crm/shared'
import { cn } from '@/lib/utils'
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
        'rounded-lg border border-border border-l-4 bg-card p-3 cursor-pointer hover:border-border/80 hover:bg-accent/30 transition-colors select-none',
        STAGE_COLORS[interview.stage],
      )}
    >
      <p className="font-semibold text-sm text-foreground truncate">{interview.companyName}</p>
      <div className="mt-1 flex items-center gap-2">
        {interview.vacancyUrl && (
          <a
            href={interview.vacancyUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
        {interview.callUrl && (
          <a
            href={interview.callUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <Phone className="h-3 w-3" />
          </a>
        )}
      </div>
      <div className="mt-2 flex items-center justify-between">
        {interview.hrName && (
          <span className="text-xs text-muted-foreground truncate max-w-[80px]">
            {interview.hrName}
          </span>
        )}
        <span className="text-xs text-muted-foreground ml-auto">
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
        'rounded-lg border border-border border-l-4 bg-card p-3 shadow-2xl cursor-grabbing select-none',
        STAGE_COLORS[interview.stage],
      )}
    >
      <p className="font-semibold text-sm text-foreground truncate">{interview.companyName}</p>
      <div className="mt-2 flex items-center justify-between">
        {interview.hrName && (
          <span className="text-xs text-muted-foreground truncate max-w-[80px]">
            {interview.hrName}
          </span>
        )}
        <span className="text-xs text-muted-foreground ml-auto">
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
      <div
        className={cn(
          'mb-2 flex items-center gap-2 rounded-lg px-2 py-1.5 shrink-0',
          COLUMN_HEADER_BG[stage],
        )}
      >
        <span className="font-semibold text-sm truncate">{STAGE_LABELS[stage]}</span>
        <span className="ml-auto text-xs opacity-70 bg-black/10 rounded-full px-1.5 py-0.5 shrink-0">
          {cards.length}
        </span>
      </div>
      <SortableContext items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
        <div
          ref={setNodeRef}
          className={cn(
            'flex flex-col gap-2 flex-1 overflow-y-auto rounded-lg p-1 transition-colors',
            isOver && 'bg-white/5',
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
