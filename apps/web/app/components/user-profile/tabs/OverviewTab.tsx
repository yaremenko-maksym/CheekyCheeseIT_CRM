import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import type { UserProfileDto } from '@crm/shared'
import { ProfileEditFields } from '../self-edit/ProfileEditFields'

export interface OverviewTabProps {
  user: UserProfileDto
  data: Record<string, unknown>
  mode: 'self' | 'view'
}

export function OverviewTab({ user, mode }: OverviewTabProps) {
  const techStack = user.techStack ?? []
  return (
    <div className="space-y-6">
      {/* KPI summary row */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-xs uppercase text-muted-foreground">Зарплата</CardTitle></CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {user.monthlySalary ? `$${user.monthlySalary}` : '—'}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-xs uppercase text-muted-foreground">Доля</CardTitle></CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {(user.role === 'SENIOR' || user.role === 'ADMIN') ? `${user.seniorSharePercent}%` : '—'}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-xs uppercase text-muted-foreground">Способ выплат</CardTitle></CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {user.paymentMethod === 'USDT_ERC20' ? 'USDT' : user.paymentMethod === 'BANK_UAH_FOP' ? 'UAH' : '—'}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-xs uppercase text-muted-foreground">Регистрация</CardTitle></CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {new Date(user.createdAt).toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', year: 'numeric' })}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Технологии</CardTitle></CardHeader>
        <CardContent>
          {techStack.length === 0 ? (
            <p className="text-sm text-muted-foreground">Не указано</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {techStack.map((t) => <Badge key={t} variant="outline">{t}</Badge>)}
            </div>
          )}
        </CardContent>
      </Card>

      {mode === 'self' && (
        <Card>
          <CardHeader><CardTitle className="text-base">Личные данные</CardTitle></CardHeader>
          <CardContent>
            <ProfileEditFields user={user} />
          </CardContent>
        </Card>
      )}
    </div>
  )
}
