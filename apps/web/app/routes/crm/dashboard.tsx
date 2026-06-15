import { createFileRoute } from '@tanstack/react-router'
import { BarChart3, Briefcase, Clock, TrendingUp, Users } from 'lucide-react'
import { motion } from 'framer-motion'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuth } from '@/context/auth'
import { DropDashboard } from './routing/components/DropDashboard'
import { AccountantDashboard } from './routing/components/AccountantDashboard'
import { HRDashboard } from './routing/components/HRDashboard'

export const Route = createFileRoute('/crm/dashboard')({
  component: DashboardPage,
})

const stats = [
  { label: 'Активных проектов', value: '—', icon: Briefcase, hint: 'Нет данных' },
  { label: 'Сотрудников', value: '—', icon: Users, hint: 'Нет данных' },
  { label: 'Транзакций', value: '—', icon: TrendingUp, hint: 'Нет данных' },
  { label: 'Собеседований', value: '—', icon: Clock, hint: 'Нет данных' },
]

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.07 } },
}

const item = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.25, 0.1, 0.25, 1] as const } },
}

function DashboardPage() {
  const { user } = useAuth()

  // DROP role: рендерим платёжный хаб вместо общего дашборда.
  // Route-access guard уже добавил DROP в допустимые роли для /crm/dashboard;
  // resolveRoleHome тоже указывает DROP → /crm/dashboard.
  if (user?.role === 'DROP') {
    return <DropDashboard />
  }

  // ACCOUNTANT role: финансовый хаб-дашборд с KPI валидации (ACCOUNTANT Sprint 1).
  // /crm/dashboard уже разрешён для ACCOUNTANT в route-access; данные KPI отдаёт
  // GET /api/finance/accountant-summary (RBAC ACCOUNTANT+ADMIN, 403 для прочих).
  if (user?.role === 'ACCOUNTANT') {
    return <AccountantDashboard />
  }

  // HR role: рекрутинг хаб-дашборд с KPI собеседований + статусом зарплаты.
  // /crm/dashboard уже разрешён для HR в route-access; данные KPI отдаёт
  // GET /api/interviews/hr-summary (RBAC HR+ADMIN, 403 для прочих).
  if (user?.role === 'HR') {
    return <HRDashboard />
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Дашборд</h1>
        <p className="text-sm text-muted-foreground">Добро пожаловать в CheekyCheeseIT CRM</p>
      </div>

      <motion.div
        className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
        variants={container}
        initial="hidden"
        animate="show"
        layout
      >
        {stats.map((stat) => (
          <motion.div key={stat.label} variants={item} layout>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  {stat.label}
                </CardTitle>
                <stat.icon className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold tracking-tight">{stat.value}</div>
                <p className="mt-1 text-xs text-muted-foreground">{stat.hint}</p>
              </CardContent>
            </Card>
          </motion.div>
        ))}
      </motion.div>

      <motion.div
        className="grid gap-4 lg:grid-cols-2"
        variants={container}
        initial="hidden"
        animate="show"
        layout
      >
        <motion.div variants={item} layout>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base">Последние транзакции</CardTitle>
              <BarChart3 className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent className="space-y-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3">
                  <Skeleton className="h-8 w-8 rounded-full" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-3 w-28" />
                    <Skeleton className="h-3 w-20" />
                  </div>
                  <Skeleton className="h-5 w-14 rounded-md" />
                </div>
              ))}
            </CardContent>
          </Card>
        </motion.div>

        <motion.div variants={item} layout>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base">Ближайшие собеседования</CardTitle>
              <Clock className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent className="space-y-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3">
                  <Skeleton className="h-8 w-8 rounded-full" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-3 w-32" />
                    <Skeleton className="h-3 w-24" />
                  </div>
                  <Skeleton className="h-5 w-16 rounded-md" />
                </div>
              ))}
            </CardContent>
          </Card>
        </motion.div>
      </motion.div>
    </div>
  )
}
