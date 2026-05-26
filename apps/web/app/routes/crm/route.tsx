import { createFileRoute, Link, Outlet, useNavigate } from '@tanstack/react-router'
import { motion } from 'framer-motion'
import { AuthProvider } from '@/context/auth'
import { NotificationsProvider, useNotifications } from '@/context/notifications'
import { Bell, LogOut, Menu, Search, UserCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useAuth } from '@/context/auth'
import { api } from '@/lib/axios'
import { NavSidebar } from '@/components/crm/nav-sidebar'
import { UserAvatar } from '@/components/users/UserAvatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { TooltipProvider } from '@/components/ui/tooltip'

export const Route = createFileRoute('/crm')({
  component: CrmRoot,
})

function CrmRoot() {
  return (
    <AuthProvider>
      <NotificationsProvider>
        <TooltipProvider delayDuration={150}>
          <CrmLayout />
        </TooltipProvider>
      </NotificationsProvider>
    </AuthProvider>
  )
}


function CrmLayout() {
  const { user, isLoading } = useAuth()
  const navigate = useNavigate()
  const { unreadCount } = useNotifications()
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false
    return localStorage.getItem('sidebar-collapsed') === 'true'
  })
  const [mobileOpen, setMobileOpen] = useState(false)

  // ut-21 follow-up (Reviewer round 4 nit): ambient background blobs should
  // not consume CPU when the tab is hidden. We pause framer-motion by toggling
  // a `tabVisible` flag via `visibilitychange` and feeding a static animate
  // target when the tab is in the background — motion stops without a jump
  // back to origin and resumes smoothly on return.
  const [tabVisible, setTabVisible] = useState(() =>
    typeof document !== 'undefined' ? !document.hidden : true,
  )
  useEffect(() => {
    if (typeof document === 'undefined') return
    const handler = () => setTabVisible(!document.hidden)
    document.addEventListener('visibilitychange', handler)
    return () => document.removeEventListener('visibilitychange', handler)
  }, [])

  useEffect(() => {
    if (!isLoading && !user) {
      void navigate({ to: '/crm/login' })
    }
  }, [user, isLoading, navigate])

  const handleToggle = () => {
    setCollapsed((prev) => {
      const next = !prev
      localStorage.setItem('sidebar-collapsed', String(next))
      return next
    })
  }

  if (isLoading) {
    return (
      <div className="flex h-screen flex-col bg-background">
        <header className="shrink-0 border-b border-border/60 px-6 py-3">
          <div className="flex items-center justify-between">
            <Skeleton className="h-7 w-40" />
            <div className="flex items-center gap-2">
              <Skeleton className="h-8 w-8 rounded-full" />
              <Skeleton className="h-8 w-8 rounded-full" />
              <Skeleton className="h-8 w-8 rounded-full" />
            </div>
          </div>
        </header>
        <div className="flex flex-1 overflow-hidden">
          <div className="hidden w-52 shrink-0 border-r border-border/60 p-2 md:block">
            <div className="flex flex-col gap-1">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-9 rounded-md" />
              ))}
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-6">
            <div className="space-y-4">
              <Skeleton className="h-8 w-48" />
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-32 rounded-xl" />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (!user) return null

  return (
    <div className="relative flex h-screen flex-col bg-background text-foreground">
      {/* ut-21: ambient animated background — три цветных blob'а медленно
          дрейфуют, единый для всех табов CRM. fixed + -z-10 — позади контента,
          pointer-events-none — не мешает кликам.
          Reviewer round 4 nit: keyframe animations paused while the tab is
          hidden (see `tabVisible`). When the tab is hidden we render the
          static initial frame (no array → no keyframe loop) and set
          `repeat: 0` — framer-motion releases the rAF schedule, so the
          background uses zero CPU until the tab is focused again. */}
      <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <motion.div
          className="absolute -left-[10%] top-[10%] h-[520px] w-[520px] rounded-full bg-primary/[0.05] blur-[120px]"
          animate={tabVisible ? { x: [0, 80, -40, 0], y: [0, -60, 40, 0], scale: [1, 1.1, 0.95, 1] } : { x: 0, y: 0, scale: 1 }}
          transition={{ duration: 24, repeat: tabVisible ? Infinity : 0, ease: 'easeInOut' }}
        />
        <motion.div
          className="absolute -right-[8%] bottom-[8%] h-[420px] w-[420px] rounded-full bg-violet-500/[0.05] blur-[110px]"
          animate={tabVisible ? { x: [0, -70, 50, 0], y: [0, 50, -40, 0], scale: [1, 0.9, 1.08, 1] } : { x: 0, y: 0, scale: 1 }}
          transition={{ duration: 30, repeat: tabVisible ? Infinity : 0, ease: 'easeInOut' }}
        />
        <motion.div
          className="absolute left-1/3 top-1/2 h-[340px] w-[340px] rounded-full bg-amber-500/[0.035] blur-[100px]"
          animate={tabVisible ? { x: [0, 50, -40, 0], y: [0, -40, 30, 0], scale: [1, 1.06, 0.94, 1] } : { x: 0, y: 0, scale: 1 }}
          transition={{ duration: 36, repeat: tabVisible ? Infinity : 0, ease: 'easeInOut' }}
        />
      </div>

      <header className="shrink-0 sticky top-0 z-40 border-b border-border/60 bg-background/80 px-6 py-3 backdrop-blur-md">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden"
              onClick={() => setMobileOpen(true)}
            >
              <Menu />
            </Button>
            <Link to="/crm/dashboard" className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary">
                <span className="text-[10px] font-black text-primary-foreground">CC</span>
              </div>
              <span className="font-semibold tracking-tight">CheekyCheeseIT</span>
            </Link>
            <Badge variant="outline" className="hidden text-xs sm:flex">
              CRM
            </Badge>
          </div>

          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" aria-label="Поиск">
              <Search className="h-4 w-4" />
            </Button>

            <Button variant="ghost" size="icon" className="relative" aria-label="Уведомления">
              <Bell className="h-4 w-4" />
              {unreadCount > 0 && (
                <span className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">
                  {unreadCount > 9 ? '9+' : unreadCount}
                </span>
              )}
            </Button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <UserAvatar
                  avatarDocumentId={user.avatarDocumentId ?? null}
                  avatarUrl={user.avatarUrl}
                  displayName={user.displayName}
                  className="h-8 w-8 cursor-pointer ml-1 [&_[data-slot=avatar-fallback]]:bg-primary/20 [&_[data-slot=avatar-fallback]]:text-xs [&_[data-slot=avatar-fallback]]:text-primary"
                />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuLabel className="font-normal">
                  <div className="flex flex-col gap-0.5">
                    <span className="font-medium">{user.displayName}</span>
                    <span className="text-xs text-muted-foreground">{user.email}</span>
                  </div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <div className="pointer-events-none">
                    <Badge
                      variant={user.role.toLowerCase() as 'admin' | 'senior' | 'junior' | 'hr' | 'accountant'}
                    >
                      {user.role}
                    </Badge>
                  </div>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link
                    to="/crm/profile"
                    className="flex items-center gap-2 text-muted-foreground"
                  >
                    <UserCircle className="h-4 w-4" />
                    Профиль
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <button
                    className="flex w-full items-center gap-2 text-muted-foreground"
                    onClick={() => {
                      void api.get('/auth/logout').finally(() => {
                        window.location.href = '/login'
                      })
                    }}
                  >
                    <LogOut className="h-4 w-4" />
                    Выйти
                  </button>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <NavSidebar
          user={user}
          collapsed={collapsed}
          onToggle={handleToggle}
          mobileOpen={mobileOpen}
          onMobileClose={() => setMobileOpen(false)}
        />
        <main className="flex-1 overflow-y-auto p-6 flex flex-col" style={{ scrollbarGutter: 'stable' }}>
          <Outlet />
        </main>
      </div>
    </div>
  )
}
