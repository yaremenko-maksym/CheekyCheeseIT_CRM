import { Link } from '@tanstack/react-router'
import {
  BarChart3,
  BookOpen,
  Briefcase,
  ChevronLeft,
  ChevronRight,
  DollarSign,
  FileText,
  Home,
  KanbanSquare,
  LayoutDashboard,
  Route,
  UserCircle,
  Users,
  UsersRound,
} from 'lucide-react'
import type { SessionUser } from '@crm/shared'
import type { FileRouteTypes } from '@/routeTree.gen'
import { cn } from '@/lib/utils'
import { navRolesFor } from '@/lib/route-access'
import { BrandMark } from '@/components/brand-mark'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useActiveTeam } from '@/hooks/use-active-team'

type Role = SessionUser['role']
type RouteTo = FileRouteTypes['to']

interface NavItem {
  label: string
  icon: React.ElementType
  to: RouteTo
  roles: readonly Role[]
}

// Drop role - phase 1: DROP sees only Profile / Team / Finance (spec §4).
// No Dashboard, no Projects, no Interviews, no Documents. Existing role
// visibilities for ADMIN / SENIOR / HR / ACCOUNTANT are unchanged.
// Drop role - phase 2: DROP gets a 4-item nav (drop-role-ux.md §2):
//   1. Мой роутинг · 2. Финансы · 3. Команда · 4. Профиль.
//   «Мой роутинг» is placed first (only DROP) using `Route` lucide icon.
// JUNIOR UX phase 2: JUNIOR gets a dedicated 5-item nav (spec §4.3):
//   1. Мой проект · 2. Легенда · 3. Финансы · 4. Документы · 5. Профиль.
//   Дашборд / Команда / Проекты / Собеседования hidden for JUNIOR.
//   Note: NAV_ITEMS order controls visible order after role-filter.
//   Профиль is placed last so JUNIOR sees it at position 5 (spec §4.3).
// roles берутся из единого источника истины lib/route-access (navRolesFor),
// чтобы карта ролей-по-роуту НЕ дублировалась между меню и route-guard'ом.
const NAV_ITEMS: NavItem[] = [
  {
    label: 'Мой роутинг',
    icon: Route,
    to: '/crm/routing',
    roles: navRolesFor('/crm/routing'),
  },
  { label: 'Мой проект', icon: Home, to: '/crm/project', roles: navRolesFor('/crm/project') },
  { label: 'Легенда', icon: BookOpen, to: '/crm/legend', roles: navRolesFor('/crm/legend') },
  {
    label: 'Дашборд',
    icon: LayoutDashboard,
    to: '/crm/dashboard',
    roles: navRolesFor('/crm/dashboard'),
  },
  { label: 'Пользователи', icon: Users, to: '/crm/users', roles: navRolesFor('/crm/users') },
  { label: 'Команда', icon: UsersRound, to: '/crm/team', roles: navRolesFor('/crm/team') },
  { label: 'Проекты', icon: Briefcase, to: '/crm/projects', roles: navRolesFor('/crm/projects') },
  { label: 'Финансы', icon: DollarSign, to: '/crm/finance', roles: navRolesFor('/crm/finance') },
  { label: 'Статистика', icon: BarChart3, to: '/crm/stats', roles: navRolesFor('/crm/stats') },
  {
    label: 'Собеседования',
    icon: KanbanSquare,
    to: '/crm/interviews',
    roles: navRolesFor('/crm/interviews'),
  },
  {
    label: 'Документы',
    icon: FileText,
    to: '/crm/documents',
    roles: navRolesFor('/crm/documents'),
  },
  {
    // Профиль last: JUNIOR sees it at position 5 (spec §4.3).
    label: 'Профиль',
    icon: UserCircle,
    to: '/crm/profile',
    roles: navRolesFor('/crm/profile'),
  },
]

interface NavSidebarProps {
  user: SessionUser
  collapsed: boolean
  onToggle: () => void
  mobileOpen: boolean
  onMobileClose: () => void
}

export function NavSidebar({
  user,
  collapsed,
  onToggle,
  mobileOpen,
  onMobileClose,
}: NavSidebarProps) {
  // Drop role - phase 1 (AC7): teamless SENIOR loses access to «Проекты»
  // and «Собеседования» — both pages depend on an active team membership.
  // For other roles the gate is a no-op (they don't go teamless).
  const { isTeamless } = useActiveTeam()
  const isTeamlessSenior = user.role === 'SENIOR' && isTeamless

  const items = NAV_ITEMS.filter((item) => {
    if (!item.roles.includes(user.role)) return false
    if (isTeamlessSenior && (item.to === '/crm/projects' || item.to === '/crm/interviews')) {
      return false
    }
    return true
  })

  return (
    <>
      {/* Desktop sidebar */}
      <TooltipProvider delayDuration={150}>
        <aside
          className={cn(
            'hidden md:flex flex-col shrink-0 border-r border-border/60 bg-background',
            'transition-[width] duration-200 ease-in-out overflow-hidden',
            collapsed ? 'w-14' : 'w-52',
          )}
        >
          <ScrollArea className="flex-1">
            <nav
              className="flex flex-col gap-0.5 p-2 pt-3"
              data-testid={
                user.role === 'JUNIOR'
                  ? 'junior-nav'
                  : user.role === 'DROP'
                    ? 'drop-nav'
                    : undefined
              }
            >
              {items.map((item) => (
                <DesktopNavLink key={item.to} item={item} collapsed={collapsed} />
              ))}
            </nav>
          </ScrollArea>

          <div className="border-t border-border/60 p-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onToggle}
                  className="h-8 w-full cursor-pointer"
                >
                  {collapsed ? (
                    <ChevronRight className="h-4 w-4" />
                  ) : (
                    <ChevronLeft className="h-4 w-4" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">{collapsed ? 'Развернуть' : 'Свернуть'}</TooltipContent>
            </Tooltip>
          </div>
        </aside>
      </TooltipProvider>

      {/* Mobile Sheet */}
      <Sheet open={mobileOpen} onOpenChange={(open) => !open && onMobileClose()}>
        <SheetContent side="left" className="w-60 p-0 gap-0">
          <SheetTitle className="sr-only">Навигация</SheetTitle>
          <SheetDescription className="sr-only">
            Боковая навигация CRM — переход между разделами системы.
          </SheetDescription>
          <div className="border-b border-border/60 px-4 py-3">
            <div className="flex items-center gap-2">
              <BrandMark variant="flat" className="h-6 w-6 text-primary" />
              <span className="text-sm font-semibold tracking-tight">CheekyCheeseIT</span>
            </div>
          </div>
          <ScrollArea className="flex-1">
            <nav className="flex flex-col gap-0.5 p-2 pt-3">
              {items.map((item) => (
                <Link
                  key={item.to}
                  to={item.to}
                  onClick={onMobileClose}
                  className="flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground data-[status=active]:bg-accent data-[status=active]:text-accent-foreground data-[status=active]:border-l-2 data-[status=active]:border-primary data-[status=active]:pl-2.5"
                >
                  <item.icon className="h-4 w-4 shrink-0" />
                  <span>{item.label}</span>
                </Link>
              ))}
            </nav>
          </ScrollArea>
        </SheetContent>
      </Sheet>
    </>
  )
}

function DesktopNavLink({ item, collapsed }: { item: NavItem; collapsed: boolean }) {
  const link = (
    <Link
      to={item.to}
      className={cn(
        'group flex items-center gap-3 rounded-md py-2 text-sm font-medium text-muted-foreground',
        'transition-colors hover:bg-accent hover:text-accent-foreground',
        'data-[status=active]:bg-accent data-[status=active]:text-accent-foreground',
        collapsed
          ? 'justify-center px-0 w-10 mx-auto data-[status=active]:ring-1 data-[status=active]:ring-primary/60'
          : 'px-3 data-[status=active]:border-l-2 data-[status=active]:border-primary data-[status=active]:pl-2.5',
      )}
    >
      <item.icon className="h-4 w-4 shrink-0 group-data-[status=active]:text-primary" />
      {!collapsed && <span>{item.label}</span>}
    </Link>
  )

  if (!collapsed) return link

  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">{item.label}</TooltipContent>
    </Tooltip>
  )
}
