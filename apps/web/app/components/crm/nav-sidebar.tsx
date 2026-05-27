import { Link } from '@tanstack/react-router'
import {
  BookOpen,
  Briefcase,
  ChevronLeft,
  ChevronRight,
  DollarSign,
  FileSignature,
  FileText,
  KanbanSquare,
  LayoutDashboard,
  BarChart3,
  UserCircle,
  Users,
  UsersRound,
} from 'lucide-react'
import type { SessionUser } from '@crm/shared'
import type { FileRouteTypes } from '@/routeTree.gen'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

type Role = SessionUser['role']
type RouteTo = FileRouteTypes['to']

interface NavItem {
  label: string
  icon: React.ElementType
  to: RouteTo
  roles: Role[]
}

const NAV_ITEMS: NavItem[] = [
  {
    label: 'Дашборд',
    icon: LayoutDashboard,
    to: '/crm/dashboard',
    roles: ['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT'],
  },
  {
    label: 'Профиль',
    icon: UserCircle,
    to: '/crm/profile',
    roles: ['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT'],
  },
  {
    label: 'Пользователи',
    icon: Users,
    to: '/crm/users',
    roles: ['ADMIN'],
  },
  {
    label: 'Команда',
    icon: UsersRound,
    to: '/crm/team',
    roles: ['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT'],
  },
  {
    label: 'Проекты',
    icon: Briefcase,
    to: '/crm/projects',
    roles: ['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT'],
  },
  {
    label: 'Финансы',
    icon: DollarSign,
    to: '/crm/finance',
    roles: ['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT'],
  },
  {
    label: 'Инвойсы',
    icon: FileSignature,
    to: '/crm/finance/invoices',
    roles: ['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT'],
  },
  {
    label: 'Статистика',
    icon: BarChart3,
    to: '/crm/stats',
    roles: ['ADMIN'],
  },
  {
    label: 'Собеседования',
    icon: KanbanSquare,
    to: '/crm/interviews',
    roles: ['ADMIN', 'SENIOR', 'HR'],
  },
  {
    label: 'Документы',
    icon: FileText,
    to: '/crm/documents',
    roles: ['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT'],
  },
  {
    label: 'База знаний',
    icon: BookOpen,
    to: '/crm/knowledge',
    roles: ['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT'],
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
  const items = NAV_ITEMS.filter((item) => item.roles.includes(user.role))

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
            <nav className="flex flex-col gap-0.5 p-2 pt-3">
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
          <div className="border-b border-border/60 px-4 py-3">
            <div className="flex items-center gap-2">
              <div className="flex h-6 w-6 items-center justify-center rounded-md bg-primary">
                <span className="text-[9px] font-black text-primary-foreground">CC</span>
              </div>
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
