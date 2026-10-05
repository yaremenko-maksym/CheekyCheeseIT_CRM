import { useQuery } from '@tanstack/react-query'
import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ProjectDetailDto, TransactionDto } from '@crm/shared'
import { financeApi } from '@/routes/_authenticated/finance/api'
import { TransactionDetailDialog } from '@/routes/_authenticated/finance/components/dialogs/TransactionDetailDialog'
import { TransactionRow } from '@/routes/_authenticated/finance/components/TransactionRow'
import { type ExchangeRates } from '@/routes/_authenticated/finance/constants'
import { useAuth } from '@/context/auth'
import { api } from '@/lib/axios'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { ProjectShareInfo } from './ProjectInfoRows'
import { ProjectDropDistribution } from './ProjectTeamCards'

export function ProjectTransactions({
  projectId,
  project,
}: {
  projectId: string
  project: ProjectDetailDto
}) {
  const { t } = useLingui()
  const { user } = useAuth()
  // task-648-fix-round-2 (UX-H-3(r2)): same ADMIN/ACCOUNTANT gate the page
  // computes for its own copy of this widget — the backend's cancel endpoint
  // allows exactly this pair. Derived here rather than threaded through a new
  // prop: this component already has the session it needs.
  const canEditOverride = user?.role === 'ADMIN' || user?.role === 'ACCOUNTANT'
  const [selected, setSelected] = useState<TransactionDto | null>(null)

  const { data: transactions, isLoading } = useQuery({
    queryKey: ['transactions', { projectId }],
    queryFn: () => financeApi.getTransactions({ projectId }),
    enabled: !!user,
    staleTime: 30_000,
  })

  const { data: rates } = useQuery<ExchangeRates>({
    queryKey: ['exchange-rate', 'today'],
    queryFn: () => api.get<ExchangeRates>('/finance/exchange-rate').then((r) => r.data),
    staleTime: 1000 * 60 * 60,
  })

  if (!user) return null

  // Drop role - phase 2 (AC3). Distribution panel visible to ADMIN /
  // ACCOUNTANT / SENIOR (the project's) / DROP (the project's). Other
  // roles never reach this tab (gated upstream by `canSeeProjectFinance`).
  const role = user.role
  const isProjectSenior = role === 'SENIOR' && project.seniorId === user.id
  const isProjectDrop = role === 'DROP' && project.dropId === user.id
  const canSeeDistribution =
    !!project.dropId &&
    (role === 'ADMIN' || role === 'ACCOUNTANT' || isProjectSenior || isProjectDrop)

  return (
    <>
      {canSeeDistribution && (
        <div className="mb-4">
          <ProjectDropDistribution project={project} />
        </div>
      )}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
              {t`Фінанси по проєкту`}
            </CardTitle>
            {/* Effective senior share — applies to every SENIOR_INCOME
                row in the table below. Mirrors the read-only marker in
                the Project info card so it's obvious which split was
                used at the moment each transaction was created. */}
            <div className="flex items-center" data-testid="project-transactions-share-row">
              <ProjectShareInfo
                project={project}
                variant="inline"
                testId="project-transactions-senior-share"
                badgeTestId="project-transactions-senior-share-override-badge"
                canCancelPendingShare={canEditOverride}
                viewerId={user?.id}
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : !transactions?.length ? (
            <p className="text-sm text-muted-foreground px-4 pb-4">
              <Trans>Транзакцій по проєкту ще немає</Trans>
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/60 text-xs text-muted-foreground">
                    <th className="py-2 px-4 text-left font-medium">{t`Тип`}</th>
                    <th className="py-2 px-4 text-left font-medium">{t`Сторони`}</th>
                    <th className="py-2 px-4 text-left font-medium">{t`Сума`}</th>
                    <th className="py-2 px-4 text-left font-medium">{t`Дата`}</th>
                    <th className="py-2 px-4 text-left font-medium">{t`Статус`}</th>
                    <th className="py-2 px-4" />
                  </tr>
                </thead>
                <tbody>
                  {transactions.map((tx) => (
                    <TransactionRow
                      key={tx.id}
                      tx={tx}
                      role={user.role}
                      rates={rates}
                      currentUserId={user.id}
                      onClick={setSelected}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <TransactionDetailDialog tx={selected} onClose={() => setSelected(null)} />
    </>
  )
}
