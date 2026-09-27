import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Trans, useLingui } from '@lingui/react/macro'
import { api } from '@/lib/axios'
import { contractTargetRoleSchema, formatDate } from '@crm/shared'
import type { ContractTargetRole, ContractTemplateRow } from '@crm/shared'
import { ROLE_LABEL_MESSAGES } from '@/components/ui/role-select'
import { useLocale } from '@/lib/i18n'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Pencil, FileText } from 'lucide-react'

export const Route = createFileRoute('/_authenticated/admin/contracts/')({
  component: ContractsListPage,
})

// All 5 possible roles (ADMIN excluded per spec)
const ALL_ROLES: ContractTargetRole[] = ['HR', 'SENIOR', 'JUNIOR', 'DROP', 'ACCOUNTANT']

function ContractsListPage() {
  const { t, i18n } = useLingui()
  const locale = useLocale()
  const { data: templates = [], isLoading } = useQuery<ContractTemplateRow[]>({
    queryKey: ['contract-templates-all'],
    queryFn: async () => {
      const res = await api.get<ContractTemplateRow[]>('/contracts/templates')
      return res.data
    },
    staleTime: 30_000,
  })

  // For each role — pick the active template (if any)
  const activeByRole: Partial<Record<ContractTargetRole, ContractTemplateRow>> = {}
  for (const tpl of templates) {
    const parsed = contractTargetRoleSchema.safeParse(tpl.targetRole)
    if (!parsed.success) continue
    if (tpl.isActive) {
      activeByRole[parsed.data] = tpl
    }
  }

  if (isLoading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-40 rounded-xl" />
        ))}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          <Trans>
            Шаблони договорів для кожної ролі. Натисніть «Редагувати», щоб змінити текст.
          </Trans>
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {ALL_ROLES.map((role) => {
          const active = activeByRole[role]
          return (
            <Card
              key={role}
              className="flex flex-col gap-0 border-border/60 transition-shadow hover:shadow-md"
              data-testid={`contract-template-card-${role.toLowerCase()}`}
            >
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                    <CardTitle className="text-base font-semibold">
                      {i18n._(ROLE_LABEL_MESSAGES[role])}
                    </CardTitle>
                  </div>
                  <Badge variant="outline" className="shrink-0 text-xs">
                    {role}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col justify-between gap-3">
                {active ? (
                  <div className="space-y-1 text-sm text-muted-foreground">
                    <p>
                      <Trans>Оновлено:</Trans>{' '}
                      <span className="font-medium text-foreground">
                        {formatDate(active.createdAt, locale, 'short')}
                      </span>
                    </p>
                  </div>
                ) : (
                  <p className="text-sm text-amber-500">{t`Шаблон не налаштовано`}</p>
                )}

                <Button
                  asChild
                  variant="outline"
                  size="sm"
                  className="w-full gap-2"
                  data-testid={`contract-template-edit-${role.toLowerCase()}`}
                >
                  <Link to="/admin/contracts/$role" params={{ role: role.toLowerCase() }}>
                    <Pencil className="h-3.5 w-3.5" />
                    <Trans>Редагувати</Trans>
                  </Link>
                </Button>
              </CardContent>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
