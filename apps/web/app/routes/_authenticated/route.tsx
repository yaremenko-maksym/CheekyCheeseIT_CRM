import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import { motion } from 'framer-motion'
import { useQuery } from '@tanstack/react-query'
import { AuthProvider } from '@/context/auth'
import { NotificationsProvider } from '@/context/notifications'
import { useOnboardingGate } from '@/context/onboarding'
import { LogOut, Menu, Search, UserCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useAuth } from '@/context/auth'
import { api } from '@/lib/axios'
import { useLogout } from '@/lib/use-logout'
import { NavSidebar } from '@/components/crm/nav-sidebar'
import { isRouteAllowed, resolveRoleHome } from '@/lib/route-access'
import { BrandMark } from '@/components/brand-mark'
import { NotificationsBell } from '@/components/layout/notifications-bell'
import { UserAvatar } from '@/components/users/UserAvatar'
import { TosUpdateBanner } from '@/components/onboarding/TosUpdateBanner'
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
import type { OnboardingStatusDto } from '@crm/shared'

export const Route = createFileRoute('/_authenticated')({
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
  const handleLogout = useLogout()
  const location = useRouterState({ select: (s) => s.location })
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false
    return localStorage.getItem('sidebar-collapsed') === 'true'
  })
  const [mobileOpen, setMobileOpen] = useState(false)

  // Onboarding gate completeness — gates post-onboarding queries in header.
  const { isComplete: onboardingComplete } = useOnboardingGate()

  // Onboarding gate: fetch status after user is authenticated
  const { data: onboardingStatus } = useQuery<OnboardingStatusDto>({
    queryKey: ['onboarding-status'],
    queryFn: async () => {
      const res = await api.get<OnboardingStatusDto>('/onboarding/status')
      return res.data
    },
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
  })

  // Redirect to onboarding if contract or ToS not completed
  useEffect(() => {
    if (!onboardingStatus) return
    const onOnboardingRoute = location.pathname.startsWith('/onboarding')
    if ((onboardingStatus.requiresContract || onboardingStatus.requiresTos) && !onOnboardingRoute) {
      void navigate({ to: '/onboarding' })
    }
  }, [onboardingStatus, location.pathname, navigate])

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

  // A11y (foundation.md §7): respect prefers-reduced-motion — when the user
  // opts out of motion we freeze the ambient blobs on their static frame
  // (no keyframe loop) instead of drifting.
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(() =>
    typeof window !== 'undefined' && 'matchMedia' in window
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false,
  )
  useEffect(() => {
    if (typeof window === 'undefined' || !('matchMedia' in window)) return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const handler = () => setPrefersReducedMotion(mq.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  // Ambient animation runs only when the tab is visible AND the user has not
  // opted out of motion. Otherwise blobs render their static initial frame.
  const ambientActive = tabVisible && !prefersReducedMotion

  useEffect(() => {
    if (!isLoading && !user) {
      void navigate({ to: '/login' })
    }
  }, [user, isLoading, navigate])

  // Declarative role route-guard (task §4, security: front-only gating fix).
  // Defense-in-depth ПОВЕРХ backend RBAC: если роль попала по прямому URL на
  // запрещённый раздел — редиректим на её дом. Источник истины ролей —
  // lib/route-access (та же карта, что NAV_ITEMS). Onboarding-роуты исключены:
  // их гейтит отдельный onboarding-flow выше. Backend RBAC НЕ ослаблен.
  useEffect(() => {
    if (isLoading || !user) return
    const path = location.pathname
    if (path.startsWith('/onboarding')) return
    if (!isRouteAllowed(path, user.role)) {
      void navigate({ to: resolveRoleHome(user.role), replace: true })
    }
  }, [user, isLoading, location.pathname, navigate])

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
        <header className="shrink-0 border-b border-border/60 px-4 py-2.5 sm:px-6">
          <div className="flex items-center justify-between gap-3">
            <Skeleton className="h-7 w-40 rounded-md" />
            <div className="flex items-center gap-1">
              <Skeleton className="h-8 w-8 rounded-full" />
              <Skeleton className="h-8 w-8 rounded-full" />
              <Skeleton className="ml-1 hidden h-8 w-36 rounded-md lg:block" />
              <Skeleton className="h-8 w-8 rounded-full lg:hidden" />
            </div>
          </div>
        </header>
        <div className="flex flex-1 overflow-hidden">
          <div className="hidden w-52 shrink-0 border-r border-border/60 p-2 pt-3 md:block">
            <div className="flex flex-col gap-0.5">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-9 rounded-md" />
              ))}
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-4 md:p-6 lg:p-8">
            <div className="space-y-4">
              <Skeleton className="h-8 w-48 rounded-md" />
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

  // AC6: onboarding route renders only the <Outlet /> — no sidebar, no header.
  // Computed here (not inside useEffect) so it is available at render time.
  const onOnboardingRoute = location.pathname.startsWith('/onboarding')
  if (onOnboardingRoute) return <Outlet />

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
      {/* Ambient depth — harmonized to the brand-warm direction (foundation.md:
          quiet by default, amber-undertone, NO purple/AI-slop). Three faint
          primary/amber blobs drift slowly; paused while the tab is hidden and
          respecting prefers-reduced-motion via the `prefersReducedMotion`
          guard, which feeds the static initial frame so the compositor releases
          the rAF schedule (zero CPU). transform/scale only — compositor-safe. */}
      <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <motion.div
          className="absolute -left-[10%] top-[10%] h-[520px] w-[520px] rounded-full bg-primary/[0.04] blur-[120px]"
          animate={
            ambientActive
              ? { x: [0, 80, -40, 0], y: [0, -60, 40, 0], scale: [1, 1.1, 0.95, 1] }
              : { x: 0, y: 0, scale: 1 }
          }
          transition={{ duration: 24, repeat: ambientActive ? Infinity : 0, ease: 'easeInOut' }}
        />
        <motion.div
          className="absolute -right-[8%] bottom-[8%] h-[420px] w-[420px] rounded-full bg-amber-500/[0.03] blur-[110px]"
          animate={
            ambientActive
              ? { x: [0, -70, 50, 0], y: [0, 50, -40, 0], scale: [1, 0.9, 1.08, 1] }
              : { x: 0, y: 0, scale: 1 }
          }
          transition={{ duration: 30, repeat: ambientActive ? Infinity : 0, ease: 'easeInOut' }}
        />
        <motion.div
          className="absolute left-1/3 top-1/2 h-[340px] w-[340px] rounded-full bg-primary/[0.025] blur-[100px]"
          animate={
            ambientActive
              ? { x: [0, 50, -40, 0], y: [0, -40, 30, 0], scale: [1, 1.06, 0.94, 1] }
              : { x: 0, y: 0, scale: 1 }
          }
          transition={{ duration: 36, repeat: ambientActive ? Infinity : 0, ease: 'easeInOut' }}
        />
      </div>

      <header className="shrink-0 sticky top-0 z-40 border-b border-border/60 bg-background/80 px-4 py-2.5 backdrop-blur-md sm:px-6">
        <div className="flex items-center justify-between gap-2 sm:gap-3">
          <div className="flex min-w-0 items-center gap-2 sm:gap-2.5">
            <Button
              variant="ghost"
              size="icon"
              className="h-11 w-11 shrink-0 cursor-pointer md:hidden"
              aria-label="Открыть меню"
              onClick={() => setMobileOpen(true)}
            >
              <Menu />
            </Button>
            <Link
              to="/"
              className="flex min-w-0 items-center gap-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              <BrandMark className="h-7 w-7 shrink-0 text-primary" />
              <span className="truncate font-semibold tracking-tight">CheekyCheeseIT</span>
            </Link>
            <Badge
              variant="outline"
              className="hidden shrink-0 border-border/70 text-[10px] font-medium uppercase tracking-wider text-muted-foreground sm:flex"
            >
              CRM
            </Badge>
          </div>

          <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Поиск"
              className="h-11 w-11 cursor-pointer sm:h-9 sm:w-9"
            >
              <Search className="h-4 w-4" />
            </Button>

            <NotificationsBell enabled={onboardingComplete} />

            {/* Identity block (name + email) — visible only on desktop ≥lg,
                faithful to design.png (text right-aligned, to the left of the
                avatar). Hidden on mobile/tablet to keep the header compact;
                the same displayName + email remain reachable inside the
                user-menu dropdown below (so identity is never unreachable).
                NOTE: this renders email a SECOND time in the DOM (the first
                is the dropdown label) — owner-approved per app-shell.md /
                design.png. The ui-invariants-pr56 E1 spec asserts a single
                email node and is expected to be updated by AutoTest. */}
            <div
              data-testid="header-user-identity"
              className="ml-1 hidden min-w-0 flex-col items-end leading-tight lg:flex"
            >
              <span className="max-w-[12rem] truncate text-sm font-medium text-foreground">
                {user.displayName}
              </span>
              <span className="max-w-[12rem] truncate text-xs text-muted-foreground">
                {user.email}
              </span>
            </div>

            <DropdownMenu>
              {/* `asChild` forwards the trigger's ref and onClick into the
                  child. UserAvatar is a function component without a
                  forwardRef wrapper, so we can't use it directly here —
                  Radix would lose the ref and the click would not toggle
                  the dropdown. A native <button> trivially handles refs +
                  keyboard a11y, and we render UserAvatar inside it for the
                  visual. */}
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Меню пользователя"
                  data-testid="header-user-menu-trigger"
                  className="ml-1 inline-flex h-11 w-11 cursor-pointer items-center justify-center rounded-full transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:h-8 sm:w-8"
                >
                  {/* Avatar trigger. displayName + email also appear in the
                      desktop identity block above (≥lg) and always in the
                      dropdown label (revealed on open). */}
                  <UserAvatar
                    // Suppress the thumbnail query while onboarding is
                    // incomplete: /api/documents/:id/thumbnail is blocked by
                    // OnboardingGuard for pre-onboarding non-ADMIN users and
                    // would produce a 403 console error.
                    avatarDocumentId={onboardingComplete ? (user.avatarDocumentId ?? null) : null}
                    avatarUrl={user.avatarUrl}
                    displayName={user.displayName}
                    className="h-8 w-8 shrink-0 ring-1 ring-border/60 [&_[data-slot=avatar-fallback]]:bg-primary/20 [&_[data-slot=avatar-fallback]]:text-xs [&_[data-slot=avatar-fallback]]:font-medium [&_[data-slot=avatar-fallback]]:text-primary"
                  />
                </button>
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
                      variant={
                        user.role.toLowerCase() as
                          | 'admin'
                          | 'senior'
                          | 'junior'
                          | 'hr'
                          | 'accountant'
                          | 'drop'
                      }
                      data-testid="header-user-menu-role-badge"
                    >
                      {user.role}
                    </Badge>
                  </div>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link
                    to="/profile"
                    className="flex items-center gap-2 text-muted-foreground"
                    data-testid="header-user-menu-profile"
                  >
                    <UserCircle className="h-4 w-4" />
                    Профиль
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <button
                    className="flex w-full items-center gap-2 text-muted-foreground"
                    data-testid="header-user-menu-logout"
                    onClick={handleLogout}
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

      {/* Soft-notify banner: user accepted an older ToS version, new one available */}
      {onboardingStatus?.tosUpdateAvailable && !onboardingStatus.requiresTos && <TosUpdateBanner />}

      <div className="flex flex-1 overflow-hidden">
        <NavSidebar
          user={user}
          collapsed={collapsed}
          onToggle={handleToggle}
          mobileOpen={mobileOpen}
          onMobileClose={() => setMobileOpen(false)}
        />
        <main
          className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background/40"
          style={{ scrollbarGutter: 'stable' }}
        >
          <Outlet />
        </main>
      </div>
    </div>
  )
}
