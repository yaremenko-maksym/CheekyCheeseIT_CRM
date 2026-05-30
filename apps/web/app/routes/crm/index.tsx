import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { motion } from 'framer-motion'
import { BarChart3, Briefcase, Clock, TrendingUp, Users } from 'lucide-react'
import { useEffect } from 'react'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuth } from '@/context/auth'

export const Route = createFileRoute('/crm/')({
  component: CrmDashboard,
})

const stats = [
  { label: 'Active Candidates', value: '—', icon: Users, hint: 'Connect DB to see data' },
  { label: 'Open Vacancies', value: '—', icon: Briefcase, hint: 'Connect DB to see data' },
  { label: 'Placements MTD', value: '—', icon: TrendingUp, hint: 'Connect DB to see data' },
  { label: 'Avg. Time to Hire', value: '—', icon: Clock, hint: 'Connect DB to see data' },
]

const teamMembers = [
  { name: 'Administrator', initials: 'AD', role: 'admin' as const },
  { name: 'Senior Recruiter', initials: 'SR', role: 'senior' as const },
  { name: 'Junior Recruiter', initials: 'JR', role: 'junior' as const },
  { name: 'HR Manager', initials: 'HR', role: 'hr' as const },
  { name: 'Accountant', initials: 'AC', role: 'accountant' as const },
]

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.07 } },
}

const item = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.25, 0.1, 0.25, 1] as const } },
}

function CrmDashboard() {
  // Drop role - phase 1 fix (AC5): /crm root for DROP → /crm/profile.
  // DROP has no Dashboard placeholder by design (sidebar hides the link too);
  // the index route would otherwise render this legacy placeholder.
  const { user } = useAuth()
  const navigate = useNavigate()
  useEffect(() => {
    if (user?.role === 'DROP') {
      void navigate({ to: '/crm/profile', replace: true })
    }
  }, [user?.role, navigate])
  if (user?.role === 'DROP') return null

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Welcome back to CheekyCheeseIT CRM
        </p>
      </div>

      {/* Stats grid */}
      <motion.div
        className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
        variants={container}
        initial="hidden"
        animate="show"
      >
        {stats.map((stat) => (
          <motion.div key={stat.label} variants={item}>
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

      {/* Content row */}
      <motion.div
        className="grid gap-4 lg:grid-cols-2"
        variants={container}
        initial="hidden"
        animate="show"
      >
        {/* Recent candidates placeholder */}
        <motion.div variants={item}>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base">Recent Candidates</CardTitle>
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

        {/* Team roster */}
        <motion.div variants={item}>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Team Roles</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              {teamMembers.map((member, i) => (
                <div key={member.role}>
                  <div className="flex items-center gap-3 rounded-lg px-1 py-2.5">
                    <Avatar className="h-8 w-8">
                      <AvatarFallback className="bg-secondary text-xs text-secondary-foreground">
                        {member.initials}
                      </AvatarFallback>
                    </Avatar>
                    <span className="flex-1 text-sm font-medium">{member.name}</span>
                    <Badge variant={member.role}>{member.role.toUpperCase()}</Badge>
                  </div>
                  {i < teamMembers.length - 1 && <Separator className="opacity-50" />}
                </div>
              ))}
            </CardContent>
          </Card>
        </motion.div>
      </motion.div>
    </div>
  )
}
