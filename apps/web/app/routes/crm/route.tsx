import { createFileRoute, Link, Outlet, useNavigate } from '@tanstack/react-router'
import { AuthProvider } from '@/context/auth'
import { NotificationsProvider, useNotifications } from '@/context/notifications'
import { Bell, LogOut, Menu, Search, UserCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useAuth } from '@/context/auth'
import { api } from '@/lib/axios'
import { NavSidebar } from '@/components/crm/nav-sidebar'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
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


function getInitials(name: string): string {
  return name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
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
    <div className="flex h-screen flex-col bg-background text-foreground">
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
                <Avatar className="h-8 w-8 cursor-pointer ml-1">
                  {(user.avatarOverride ?? user.avatar) && (
                    <AvatarImage src={user.avatarOverride ?? user.avatar ?? undefined} alt={user.displayName} />
                  )}
                  <AvatarFallback className="bg-primary/20 text-xs text-primary">
                    {getInitials(user.displayName)}
                  </AvatarFallback>
                </Avatar>
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
