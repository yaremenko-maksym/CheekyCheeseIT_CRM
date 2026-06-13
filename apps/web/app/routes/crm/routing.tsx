import { createFileRoute } from '@tanstack/react-router'
import { motion } from 'framer-motion'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/context/auth'
import { useDropSummary, DROP_SUMMARY_QUERY_KEY } from '@/hooks/use-drop-summary'
import { useDropIncomes, useDropProjects } from '@/hooks/use-drop-incomes'
import { DropBalanceCard } from './routing/components/DropBalanceCard'
import { DropActionRequiredBlock } from './routing/components/DropActionRequiredBlock'
import { DropProjectsList } from './routing/components/DropProjectsList'
import { DropQuickActions } from './routing/components/DropQuickActions'

export const Route = createFileRoute('/crm/routing')({
  component: DropRoutingHub,
})

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.06 } },
}

const card = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: [0.25, 0.1, 0.25, 1] as const } },
}

function DropRoutingHub() {
  const { user } = useAuth()
  const qc = useQueryClient()

  // Guard: this page is DROP-only; route-access guard handles redirect for
  // other roles, but we also short-circuit here defensively.
  if (user?.role !== 'DROP') return null

  return (
    <DropRoutingHubContent
      onRetrySummary={() => void qc.invalidateQueries({ queryKey: DROP_SUMMARY_QUERY_KEY })}
    />
  )
}

function DropRoutingHubContent({ onRetrySummary }: { onRetrySummary: () => void }) {
  const { data: summary, isLoading: summaryLoading, isError: summaryError } = useDropSummary()

  // Validated incomes for DropActionRequiredBlock (max 3 + count)
  const { data: validatedPage, isLoading: validatedLoading } = useDropIncomes({
    status: 'validated',
    limit: 10,
  })

  const { data: projects, isLoading: projectsLoading } = useDropProjects()

  return (
    <main data-testid="drop-routing-hub" className="space-y-6">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Дашборд</h1>
        <p className="text-sm text-muted-foreground">Платёжный хаб</p>
      </div>

      {/* Grid layout: md:2-col */}
      <motion.div
        className="grid grid-cols-1 md:grid-cols-2 gap-4"
        variants={container}
        initial="hidden"
        animate="show"
      >
        {/*
         * Desktop order: BalanceCard (col 1) + ActionRequired (col 2)
         * Mobile order: ActionRequired first (order-first on mobile), then Balance
         * Implemented via CSS order utility: on mobile, ActionRequired gets order-first.
         */}

        {/* DropBalanceCard — desktop col 1, mobile col 2 (order-2) */}
        <motion.div variants={card} className="order-2 md:order-1">
          <DropBalanceCard
            summary={summary}
            isLoading={summaryLoading}
            isError={summaryError}
            onRetry={onRetrySummary}
            variant="compact"
          />
        </motion.div>

        {/* DropActionRequiredBlock — desktop col 2, mobile col 1 (order-1) */}
        <motion.div variants={card} className="order-1 md:order-2">
          <DropActionRequiredBlock
            validatedIncomes={validatedPage?.items}
            isLoading={validatedLoading}
          />
        </motion.div>

        {/* DropProjectsList — full width */}
        <motion.div variants={card} className="col-span-full order-3">
          <DropProjectsList projects={projects} isLoading={projectsLoading} />
        </motion.div>

        {/* DropQuickActions — full width */}
        <motion.div variants={card} className="col-span-full order-4">
          <DropQuickActions />
        </motion.div>
      </motion.div>
    </main>
  )
}
