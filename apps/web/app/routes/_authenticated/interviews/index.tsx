import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import {
  DndContext,
  DragOverlay,
  KeyboardCode,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
} from '@dnd-kit/core'
import { arrayMove } from '@dnd-kit/sortable'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { z } from 'zod'
import { Plus, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { InterviewDto, InterviewStage } from '@crm/shared'
import { useAuth } from '@/context/auth'
import { api } from '@/lib/axios'
import { trackFeatureClick } from '@/lib/telemetry'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { RejoinTeamDialog } from '@/components/users/RejoinTeamDialog'
import { useActiveTeam } from '@/hooks/use-active-team'
import { useRoleGuard } from '@/hooks/use-role-guard'
import { UsersRound } from 'lucide-react'
import { ACTIVE_STAGES, ALL_STAGES, TERMINAL_STAGES } from './constants'
import { InterviewCardStatic, KanbanColumn } from './components/KanbanColumn'
import { InterviewDetailSheet } from './components/InterviewDetailSheet'
import { JobSuggestionDialog } from '@/components/job-sourcing/JobSuggestionDialog'
import { CreateInterviewDialog } from './components/CreateInterviewDialog'
import { CreateProjectFromHiredDialog } from './components/CreateProjectFromHiredDialog'

// coordinateGetter for KeyboardSensor on the Kanban board.
//
// ArrowLeft / ArrowRight navigate column-by-column using droppable rect centers.
// This is deterministic regardless of scroll position or how many cards are in
// each column — it does NOT rely on 25-px increments or sortable-item iteration.
// The approach makes E2E keyboard-drag tests reliable in headless Playwright.
const kanbanKeyboardCoordinateGetter: KeyboardCoordinateGetter = (
  event,
  { currentCoordinates, context: { droppableRects } },
) => {
  if (event.code !== KeyboardCode.Right && event.code !== KeyboardCode.Left) return undefined

  event.preventDefault()

  // Collect column droppable ids — stage ids are UPPER_SNAKE_CASE strings.
  const stageIds: string[] = []
  droppableRects.forEach((_rect, id) => {
    if (typeof id === 'string' && /^[A-Z][A-Z_]*$/.test(id)) stageIds.push(id)
  })

  if (stageIds.length === 0) return undefined

  // Sort columns left-to-right by rect center x.
  const sorted = stageIds.sort((a, b) => {
    const ra = droppableRects.get(a)
    const rb = droppableRects.get(b)
    return (ra?.left ?? 0) + (ra?.width ?? 0) / 2 - ((rb?.left ?? 0) + (rb?.width ?? 0) / 2)
  })

  // Find which column contains the current coordinates.
  const curX = currentCoordinates.x
  let currentIdx = sorted.findIndex((id) => {
    const r = droppableRects.get(id)
    return r && curX >= r.left && curX <= r.right
  })
  if (currentIdx === -1) {
    // Fallback: find nearest column center
    currentIdx = sorted.reduce((best, id, idx) => {
      const r = droppableRects.get(id)
      if (!r) return best
      const dist = Math.abs(curX - (r.left + r.width / 2))
      const bestR = droppableRects.get(sorted[best] ?? '')
      const bestDist = bestR ? Math.abs(curX - (bestR.left + bestR.width / 2)) : Infinity
      return dist < bestDist ? idx : best
    }, 0)
  }

  const nextIdx =
    event.code === KeyboardCode.Right
      ? Math.min(currentIdx + 1, sorted.length - 1)
      : Math.max(currentIdx - 1, 0)

  const targetId = sorted[nextIdx]
  if (!targetId) return undefined
  const rect = droppableRects.get(targetId)
  if (!rect) return undefined

  // Return a point in the lower portion of the target column (80% down).
  // This avoids card droppables that cluster near the top and ensures
  // closestCenter resolves to the column area, not a nearby card.
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height * 0.8 }
}

type UserDto = {
  id: string
  email: string
  displayName: string
  avatarUrl: string | null
  avatarDocumentId: string | null
  role: 'ADMIN' | 'SENIOR' | 'JUNIOR' | 'HR' | 'ACCOUNTANT'
  googleId: string | null
  createdAt: string
  updatedAt: string
}

const searchSchema = z.object({
  seniorId: z.string().optional(),
})

export const Route = createFileRoute('/_authenticated/interviews/')({
  validateSearch: searchSchema,
  component: InterviewsPage,
})

// State for the "hired via DnD" create-project prompt
type HiredDndState = {
  interview: InterviewDto
  seniorId: string
  seniorName: string
} | null

function InterviewsPage() {
  // Drop role - phase 1 fix (AC4): DROP must not access /interviews —
  // sidebar already hides the link, but a direct URL navigation should also
  // redirect away. Mirrors the guard pattern used by /projects.
  useRoleGuard(['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT'])
  const { user } = useAuth()
  const queryClient = useQueryClient()

  const isAdmin = user?.role === 'ADMIN'
  const isHR = user?.role === 'HR'
  const isSenior = user?.role === 'SENIOR'
  const canCreate = isAdmin || isHR || isSenior
  const isJunior = user?.role === 'JUNIOR'
  // ADMIN and HR can create projects from hired candidates
  const canCreateProject = isAdmin || isHR

  const search = Route.useSearch()
  const navigate = useNavigate()
  const [createOpen, setCreateOpen] = useState(false)
  const [jobSourcingOpen, setJobSourcingOpen] = useState(false)
  const [selectedCard, setSelectedCard] = useState<InterviewDto | null>(null)
  const [activeCardId, setActiveCardId] = useState<string | null>(null)

  // Bug fix 2: state for "hired via DnD → create project" prompt
  const [hiredDndState, setHiredDndState] = useState<HiredDndState>(null)

  function setSelectedSeniorId(id: string) {
    void navigate({ to: '/interviews', search: { seniorId: id }, replace: true })
  }

  // round-2 AC2: only ADMIN/HR may list all users (board selector). SENIOR sees
  // only their own board (effectiveSeniorId = user.id) and never needs the user
  // list — gating prevents the 403 the backend returns for SENIOR on /users.
  const { data: allUsers = [] } = useQuery<UserDto[]>({
    queryKey: ['users'],
    queryFn: () => api.get<UserDto[]>('/users').then((r) => r.data),
    enabled: isAdmin || isHR,
    staleTime: 5 * 60_000,
  })

  const { data: teams = [] } = useQuery<
    { id: string; members: { userId: string; role: string }[] }[]
  >({
    queryKey: ['teams'],
    queryFn: () => api.get('/teams').then((r) => r.data),
    enabled: isHR,
    staleTime: 5 * 60_000,
  })

  const allSeniors = allUsers.filter((u) => u.role === 'SENIOR')
  const seniors = isHR
    ? allSeniors.filter((s) =>
        teams.some(
          (t) =>
            t.members.some((m) => m.userId === s.id && m.role === 'SENIOR') &&
            t.members.some((m) => m.userId === user!.id && m.role === 'HR'),
        ),
      )
    : allSeniors

  const effectiveSeniorId = isSenior ? (user?.id ?? '') : (search.seniorId ?? seniors[0]?.id ?? '')

  const { data: interviewsList = [], isLoading } = useQuery<InterviewDto[]>({
    queryKey: ['interviews', effectiveSeniorId],
    queryFn: () =>
      api.get<InterviewDto[]>(`/interviews?seniorId=${effectiveSeniorId}`).then((r) => r.data),
    enabled: !!effectiveSeniorId && !isJunior,
  })

  const byStage = useMemo(() => {
    const map: Record<string, InterviewDto[]> = {}
    for (const stage of ALL_STAGES) map[stage] = []
    for (const i of interviewsList) map[i.stage]?.push(i)
    for (const stage of ALL_STAGES) map[stage]!.sort((a, b) => a.position - b.position)
    return map
  }, [interviewsList])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    // KeyboardSensor enables a11y keyboard drag-and-drop.
    // kanbanKeyboardCoordinateGetter navigates column-by-column using droppable
    // rect centers — deterministic regardless of scroll position or column fill.
    useSensor(KeyboardSensor, { coordinateGetter: kanbanKeyboardCoordinateGetter }),
  )
  const activeCard = activeCardId
    ? (interviewsList.find((i) => i.id === activeCardId) ?? null)
    : null

  const moveMutation = useMutation({
    mutationFn: ({
      id,
      stage,
      position,
    }: {
      id: string
      stage: InterviewStage
      position: number
    }) =>
      api.patch<InterviewDto>(`/interviews/${id}/move`, { stage, position }).then((r) => r.data),
    onError: () => {
      queryClient.invalidateQueries({ queryKey: ['interviews', effectiveSeniorId] })
    },
    onSuccess: (updated, variables) => {
      queryClient.invalidateQueries({ queryKey: ['interviews', effectiveSeniorId] })
      // Bug fix 2: after DnD move to HIRED, open CreateProjectFromHiredDialog
      // if the current user has project-creation rights.
      if (variables.stage === 'HIRED' && canCreateProject) {
        const movedCard = interviewsList.find((i) => i.id === updated.id) ?? updated
        const seniorUser = allUsers.find((u) => u.id === (movedCard.seniorId ?? effectiveSeniorId))
        setHiredDndState({
          interview: updated,
          seniorId: movedCard.seniorId ?? effectiveSeniorId,
          seniorName: updated.seniorName ?? seniorUser?.displayName ?? '',
        })
      }
    },
  })

  function handleDragStart(event: DragStartEvent) {
    setActiveCardId(event.active.id as string)
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveCardId(null)
    const { active, over } = event
    if (!over) return

    const draggedId = active.id as string
    const overId = over.id as string
    const draggedCard = interviewsList.find((i) => i.id === draggedId)
    if (!draggedCard) return

    // Only admin/HR can move terminal cards
    if (TERMINAL_STAGES.includes(draggedCard.stage) && !isAdmin && !isHR) return

    const overIsStage = (ACTIVE_STAGES as string[]).concat(TERMINAL_STAGES).includes(overId)
    let targetStage: InterviewStage
    let targetIndex: number

    const sourceColumn = byStage[draggedCard.stage] ?? []

    if (overIsStage) {
      targetStage = overId as InterviewStage
      targetIndex = byStage[targetStage]?.length ?? 0
    } else {
      const overCard = interviewsList.find((i) => i.id === overId)
      if (!overCard) return
      targetStage = overCard.stage
      const targetColumn = byStage[targetStage] ?? []
      targetIndex = targetColumn.findIndex((i) => i.id === overId)
      if (targetIndex === -1) targetIndex = targetColumn.length
    }

    const oldIndex = sourceColumn.findIndex((i) => i.id === draggedId)
    if (draggedCard.stage === targetStage && oldIndex === targetIndex) return

    queryClient.setQueryData<InterviewDto[]>(['interviews', effectiveSeniorId], (old) => {
      if (!old) return old

      if (draggedCard.stage === targetStage) {
        // Same column — reorder with arrayMove, reassign positions by index
        const col = [...sourceColumn]
        const reordered = arrayMove(col, oldIndex, targetIndex)
        const updated = new Map(reordered.map((c, idx) => [c.id, { ...c, position: idx }]))
        return old.map((i) => updated.get(i.id) ?? i)
      } else {
        // Cross-column move — insert into target, shift positions
        const targetColumn = (byStage[targetStage] ?? []).filter((i) => i.id !== draggedId)
        targetColumn.splice(targetIndex, 0, { ...draggedCard, stage: targetStage })
        const updatedTarget = new Map(targetColumn.map((c, idx) => [c.id, { ...c, position: idx }]))
        const updatedSource = new Map(
          sourceColumn
            .filter((i) => i.id !== draggedId)
            .map((c, idx) => [c.id, { ...c, position: idx }]),
        )
        return old.map((i) => updatedTarget.get(i.id) ?? updatedSource.get(i.id) ?? i)
      }
    })

    // task-telemetry-web: not a click — the delegated [data-track] listener
    // can't see a dnd-kit drag, so this feature signal is fired manually,
    // gated on an ACTUAL move (the early-returns above already ruled out a
    // same-column no-op reorder).
    trackFeatureClick('interview-kanban-drag')
    moveMutation.mutate({ id: draggedId, stage: targetStage, position: targetIndex })
  }

  // Drop role - phase 1 (AC7): teamless SENIOR empty state. Hook order
  // is stable — `useActiveTeam` always runs; the gate just toggles render.
  const { isTeamless: isTeamlessSenior, isLoading: isTeamLoading } = useActiveTeam()
  const [rejoinDialogOpen, setRejoinDialogOpen] = useState(false)

  if (isJunior) {
    return (
      <div className="flex flex-col h-full px-6 pt-4">
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-24 text-center">
          <p className="text-sm font-medium text-muted-foreground">Нет доступа к разделу</p>
        </div>
      </div>
    )
  }

  if (isSenior && !isTeamLoading && isTeamlessSenior) {
    return (
      <div className="flex flex-col h-full px-6 pt-4">
        <div
          className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-24 text-center"
          data-testid="interviews-teamless-empty-state"
        >
          <UsersRound className="h-10 w-10 text-muted-foreground/30" />
          <p className="mt-4 text-sm font-medium">У вас нет активной команды</p>
          <p className="mt-1 text-xs text-muted-foreground max-w-md">
            Доступ к собеседованиям откроется после привязки к команде.
          </p>
          <Button size="sm" className="mt-4 gap-1.5" onClick={() => setRejoinDialogOpen(true)}>
            <Plus className="h-4 w-4" />
            Создать или выбрать команду
          </Button>
        </div>
        <RejoinTeamDialog open={rejoinDialogOpen} onClose={() => setRejoinDialogOpen(false)} />
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden" data-testid="interviews-page">
      <motion.div
        className="px-6 pt-4 mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between shrink-0"
        initial={{ opacity: 0, y: -12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
      >
        <div className="flex items-center gap-3 flex-wrap">
          {((isAdmin && seniors.length > 0) || isHR) && (
            <div className="flex items-center gap-2">
              <select
                className="h-9 rounded-md border border-border bg-input px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={effectiveSeniorId}
                onChange={(e) => setSelectedSeniorId(e.target.value)}
              >
                {seniors.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.displayName}
                  </option>
                ))}
              </select>
              {effectiveSeniorId && (
                <Link
                  to="/profile/$userId"
                  params={{ userId: effectiveSeniorId }}
                  className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
                >
                  Профиль
                </Link>
              )}
            </div>
          )}

          {canCreate && (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="mr-1.5 h-4 w-4" />
              Новая карточка
            </Button>
          )}

          {/*
            task-job-sourcing-slice1 §4 — entry point to the vacancy queue.
            Lives next to «Новая карточка» because it feeds the same board: a
            vacancy the senior applies to becomes the next interview card.
            Same audience as the board itself (ADMIN / HR / SENIOR).
          */}
          {canCreate && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setJobSourcingOpen(true)}
              data-testid="open-job-sourcing"
            >
              <Search className="mr-1.5 h-4 w-4" />
              Подбор вакансий
            </Button>
          )}
        </div>
      </motion.div>

      <div className="flex flex-1 min-h-0 overflow-x-auto overflow-y-hidden pb-6">
        {isLoading ? (
          <div className="flex gap-3 px-6">
            {ACTIVE_STAGES.map((s) => (
              <div key={s} className="flex flex-col min-w-44 w-44 shrink-0 gap-2">
                <Skeleton className="h-7 w-full" />
                {[1, 2].map((i) => (
                  <Skeleton key={i} className="h-20 w-full" />
                ))}
              </div>
            ))}
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            <motion.div
              className="flex gap-3 items-stretch h-full px-6"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.4, delay: 0.1 }}
            >
              {ACTIVE_STAGES.map((stage, idx) => (
                <motion.div
                  key={stage}
                  className="h-full"
                  initial={{ opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3, delay: idx * 0.05 }}
                >
                  <KanbanColumn
                    stage={stage}
                    interviews={byStage[stage] ?? []}
                    onCardClick={setSelectedCard}
                    canDrag={isAdmin || isHR}
                  />
                </motion.div>
              ))}

              <div className="shrink-0 self-stretch w-px bg-border/60 mx-1" />

              {TERMINAL_STAGES.map((stage, idx) => (
                <motion.div
                  key={stage}
                  className="h-full"
                  initial={{ opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3, delay: (ACTIVE_STAGES.length + idx) * 0.05 }}
                >
                  <KanbanColumn
                    stage={stage}
                    interviews={byStage[stage] ?? []}
                    onCardClick={setSelectedCard}
                    canDrag={isAdmin || isHR}
                  />
                </motion.div>
              ))}
            </motion.div>
            <DragOverlay>
              {activeCard && <InterviewCardStatic interview={activeCard} />}
            </DragOverlay>
          </DndContext>
        )}
      </div>

      {selectedCard && (
        <InterviewDetailSheet
          interview={selectedCard}
          open={!!selectedCard}
          onClose={() => setSelectedCard(null)}
          onSaved={(updated) => setSelectedCard(updated)}
          onDeleted={() => setSelectedCard(null)}
          canDelete={isAdmin || isHR}
          canMove={isAdmin || isHR || isSenior}
          canMoveTerminal={isAdmin || isHR || isSenior}
          canCreateProject={canCreateProject}
        />
      )}

      {createOpen && (
        <CreateInterviewDialog
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          seniors={seniors}
          defaultSeniorId={isSenior ? (user?.id ?? '') : effectiveSeniorId}
          isSenior={isSenior}
        />
      )}

      {/*
        Job sourcing queue (task-job-sourcing-slice1). A SENIOR passes no
        seniorId — the API resolves it to themselves and ignores anything else,
        so the board's senior-picker cannot be used to peek at someone else.
      */}
      {jobSourcingOpen && (
        <JobSuggestionDialog
          open={jobSourcingOpen}
          onClose={() => setJobSourcingOpen(false)}
          seniorId={isSenior ? undefined : effectiveSeniorId}
          canManageGlobal={isAdmin || isHR}
        />
      )}

      {/* Bug fix 2+3: CreateProjectFromHiredDialog triggered by DnD drop into
          HIRED column. Rendered at page level (not inside Sheet) so its portal
          and focus-trap work independently. Bug fix 3: onClose properly wired
          so the Cancel button closes the dialog. */}
      {hiredDndState && (
        <CreateProjectFromHiredDialog
          open={!!hiredDndState}
          onClose={() => setHiredDndState(null)}
          seniorId={hiredDndState.seniorId}
          seniorName={hiredDndState.seniorName}
          companyName={hiredDndState.interview.companyName}
        />
      )}
    </div>
  )
}
