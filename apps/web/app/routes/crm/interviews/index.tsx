import { createFileRoute, Link, useNavigate, useSearch } from '@tanstack/react-router'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { arrayMove } from '@dnd-kit/sortable'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { z } from 'zod'
import { Plus } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { InterviewDto, InterviewStage } from '@crm/shared'
import { useAuth } from '@/context/auth'
import { api } from '@/lib/axios'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ACTIVE_STAGES, ALL_STAGES, TERMINAL_STAGES } from './constants'
import { InterviewCardStatic, KanbanColumn } from './components/KanbanColumn'
import { InterviewDetailSheet } from './components/InterviewDetailSheet'
import { CreateInterviewDialog } from './components/CreateInterviewDialog'

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

export const Route = createFileRoute('/crm/interviews/')({
  validateSearch: searchSchema,
  component: InterviewsPage,
})

function InterviewsPage() {
  const { user } = useAuth()
  const queryClient = useQueryClient()

  const isAdmin = user?.role === 'ADMIN'
  const isHR = user?.role === 'HR'
  const isSenior = user?.role === 'SENIOR'
  const canCreate = isAdmin || isHR || isSenior
  const isJunior = user?.role === 'JUNIOR'

  const search = useSearch({ from: '/crm/interviews/' })
  const navigate = useNavigate()
  const [createOpen, setCreateOpen] = useState(false)
  const [selectedCard, setSelectedCard] = useState<InterviewDto | null>(null)
  const [activeCardId, setActiveCardId] = useState<string | null>(null)

  function setSelectedSeniorId(id: string) {
    void navigate({ to: '/crm/interviews', search: { seniorId: id }, replace: true })
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

  const { data: teams = [] } = useQuery<{ id: string; members: { userId: string; role: string }[] }[]>({
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

  const effectiveSeniorId = isSenior
    ? (user?.id ?? '')
    : (search.seniorId ?? seniors[0]?.id ?? '')

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

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))
  const activeCard = activeCardId ? interviewsList.find((i) => i.id === activeCardId) ?? null : null

  const moveMutation = useMutation({
    mutationFn: ({ id, stage, position }: { id: string; stage: InterviewStage; position: number }) =>
      api.patch<InterviewDto>(`/interviews/${id}/move`, { stage, position }).then((r) => r.data),
    onError: () => { queryClient.invalidateQueries({ queryKey: ['interviews', effectiveSeniorId] }) },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['interviews', effectiveSeniorId] }) }, // sync final server positions
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
      targetIndex = (byStage[targetStage]?.length ?? 0)
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
          sourceColumn.filter((i) => i.id !== draggedId).map((c, idx) => [c.id, { ...c, position: idx }])
        )
        return old.map((i) => updatedTarget.get(i.id) ?? updatedSource.get(i.id) ?? i)
      }
    })

    moveMutation.mutate({ id: draggedId, stage: targetStage, position: targetIndex })
  }

  if (isJunior) {
    return (
      <div className="w-full">
        <div className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight">Собеседования</h1>
        </div>
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-24 text-center">
          <p className="text-sm font-medium text-muted-foreground">Нет доступа к разделу</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden -mx-6 px-4">
      <motion.div
        className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between shrink-0"
        initial={{ opacity: 0, y: -12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
      >
        <h1 className="text-2xl font-bold tracking-tight">Собеседования</h1>
        <div className="flex items-center gap-3 flex-wrap">
          {(isAdmin && seniors.length > 0 || isHR) && (
            <div className="flex items-center gap-2">
              <select
                className="h-9 rounded-md border border-border bg-input px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={effectiveSeniorId}
                onChange={(e) => setSelectedSeniorId(e.target.value)}
              >
                {seniors.map((s) => (
                  <option key={s.id} value={s.id}>{s.displayName}</option>
                ))}
              </select>
              {effectiveSeniorId && (
                <Link
                  to="/crm/profile/$userId"
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
        </div>
      </motion.div>

      <div className="flex flex-1 min-h-0 overflow-x-auto overflow-y-hidden pb-6">
        {isLoading ? (
          <div className="flex gap-3 px-6">
            {ACTIVE_STAGES.map((s) => (
              <div key={s} className="flex flex-col min-w-44 w-44 shrink-0 gap-2">
                <Skeleton className="h-7 w-full" />
                {[1, 2].map((i) => <Skeleton key={i} className="h-20 w-full" />)}
              </div>
            ))}
          </div>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
            <motion.div
              className="flex gap-3 items-stretch h-full"
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
                  <KanbanColumn stage={stage} interviews={byStage[stage] ?? []} onCardClick={setSelectedCard} canDrag={isAdmin || isHR} />
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
                  <KanbanColumn stage={stage} interviews={byStage[stage] ?? []} onCardClick={setSelectedCard} canDrag={isAdmin || isHR} />
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
          canCreateProject={isAdmin || isHR}
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
    </div>
  )
}
