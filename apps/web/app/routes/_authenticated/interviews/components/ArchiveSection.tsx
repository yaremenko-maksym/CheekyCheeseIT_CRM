import { useState } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { ChevronRight } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import { useLingui, Trans } from '@lingui/react/macro'
import type { InterviewDto, InterviewStage } from '@crm/shared'
import { cn } from '@/lib/utils'
import { STAGE_BADGE_COLORS, STAGE_LABEL_MESSAGES, TERMINAL_STAGES } from '../constants'
import { InterviewCard } from './KanbanColumn'

function TerminalColumn({
  stage,
  cards,
  onCardClick,
  canDrag,
}: {
  stage: string
  cards: InterviewDto[]
  onCardClick: (interview: InterviewDto) => void
  canDrag: boolean
}) {
  const { i18n } = useLingui()
  const { setNodeRef, isOver } = useDroppable({ id: stage })

  return (
    <div className="flex flex-col min-w-[180px] w-44 shrink-0">
      <div className="mb-3 flex items-center gap-2">
        <span
          className={cn(
            'text-xs font-semibold px-2 py-0.5 rounded-full border',
            STAGE_BADGE_COLORS[stage as InterviewStage],
          )}
        >
          {i18n._(STAGE_LABEL_MESSAGES[stage as InterviewStage])}
        </span>
        <span className="ml-auto text-xs text-muted-foreground">{cards.length}</span>
      </div>
      <SortableContext items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
        <div
          ref={setNodeRef}
          className={cn(
            'flex flex-col gap-2 min-h-10 rounded-lg p-1 transition-colors',
            isOver && 'bg-accent/40',
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
          {cards.length === 0 && (
            <p className="text-xs text-muted-foreground text-center py-4">
              <Trans>Сюди потрапляють завершені співбесіди</Trans>
            </p>
          )}
        </div>
      </SortableContext>
    </div>
  )
}

export function ArchiveSection({
  byStage,
  onCardClick,
  canDrag = false,
}: {
  byStage: Record<string, InterviewDto[]>
  onCardClick: (interview: InterviewDto) => void
  canDrag?: boolean
}) {
  const { i18n } = useLingui()
  const [open, setOpen] = useState(false)
  const totalArchived = TERMINAL_STAGES.reduce((sum, s) => sum + (byStage[s]?.length ?? 0), 0)

  if (totalArchived === 0) return null

  return (
    <div className="shrink-0 border border-border rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-4 py-3 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent/30 transition-colors"
      >
        <motion.span
          animate={{ rotate: open ? 90 : 0 }}
          transition={{ duration: 0.2 }}
          className="flex items-center"
        >
          <ChevronRight className="h-4 w-4" />
        </motion.span>
        <span>{i18n._(STAGE_LABEL_MESSAGES.ARCHIVED)}</span>
        <span className="ml-1 text-xs bg-muted rounded-full px-2 py-0.5">{totalArchived}</span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="archive-content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div className="border-t border-border p-4">
              <div className="flex gap-6 overflow-x-auto pb-2">
                {TERMINAL_STAGES.map((stage) => (
                  <TerminalColumn
                    key={stage}
                    stage={stage}
                    cards={byStage[stage] ?? []}
                    onCardClick={onCardClick}
                    canDrag={canDrag}
                  />
                ))}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
