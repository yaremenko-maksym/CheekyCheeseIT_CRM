import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Banknote } from 'lucide-react'
import { StickyPageHeader } from '@/components/crm/StickyPageHeader'
import { useAuth } from '@/context/auth'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { companyAccountApi } from '../api'
import { CompanyBalanceKpi } from './CompanyBalanceKpi'
import { DepositConfirmCard } from './BlockConfirmationProgress'
import { WithdrawDividendsDialog } from './WithdrawDividendsDialog'
import { ChangeWalletAddressDialog } from './ChangeWalletAddressDialog'

export const Route = createFileRoute('/crm/finance/company-account/')({
  component: CompanyAccountPage,
})

function CompanyAccountPage() {
  const { user } = useAuth()
  const role = user?.role
  const isAdmin = role === 'ADMIN'
  // Only ADMIN/ACCOUNTANT may read the account (balance + wallet); SENIOR/DROP
  // get 403 server-side, so we never fire the query for them.
  const canSeeAccount = role === 'ADMIN' || role === 'ACCOUNTANT'
  // Only SENIOR/DROP submit deposits (POST /deposits is SENIOR/DROP server-side).
  const canDeposit = role === 'SENIOR' || role === 'DROP'

  const [dividendsOpen, setDividendsOpen] = useState(false)
  const [walletOpen, setWalletOpen] = useState(false)

  const accountQuery = useQuery({
    queryKey: ['company-account'],
    queryFn: companyAccountApi.getAccount,
    enabled: canSeeAccount,
  })
  const account = accountQuery.data

  return (
    <div className="flex h-full flex-col">
      <StickyPageHeader>
        <div className="flex items-start justify-between">
          <div className="text-sm font-medium text-muted-foreground">Счёт компании</div>
          <div className="flex gap-2">
            {isAdmin && account && (
              <Button
                size="sm"
                onClick={() => setDividendsOpen(true)}
                disabled={account.balance <= 0}
                data-testid="open-dividends-btn"
              >
                <Banknote className="mr-1.5 h-4 w-4" /> Вывести дивиденды
              </Button>
            )}
          </div>
        </div>
      </StickyPageHeader>

      <div className="flex-1 space-y-4 overflow-y-auto px-6 pb-6 pt-4">
        <div className="mx-auto max-w-3xl space-y-4">
          {/* Balance (ADMIN/ACCOUNTANT only). */}
          {canSeeAccount &&
            (accountQuery.isLoading ? (
              <Skeleton className="h-32 w-full" />
            ) : account ? (
              <CompanyBalanceKpi
                account={account}
                isAdmin={isAdmin}
                onChangeWallet={() => setWalletOpen(true)}
              />
            ) : null)}

          {/* Wallet-not-set notice (ADMIN/ACCOUNTANT). */}
          {canSeeAccount && account && !account.walletAddress && (
            <Card className="border-border bg-muted/20">
              <CardContent className="py-6 text-center text-sm text-muted-foreground">
                Адрес кошелька компании ещё не настроен.
                {isAdmin
                  ? ' Добавьте его выше, чтобы принимать депозиты.'
                  : ' Обратитесь к администратору.'}
              </CardContent>
            </Card>
          )}

          {/* Deposit submission + block-confirmation progress — SENIOR/DROP. */}
          {canDeposit && <DepositConfirmCard />}

          {/* Roles that are neither depositors nor account-readers. */}
          {!canSeeAccount && !canDeposit && (
            <Card className="border-border bg-muted/20">
              <CardContent className="py-8 text-center text-sm text-muted-foreground">
                Счёт компании доступен администраторам, бухгалтеру и контракторам.
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {isAdmin && account && (
        <>
          <WithdrawDividendsDialog
            open={dividendsOpen}
            onClose={() => setDividendsOpen(false)}
            balance={account.balance}
          />
          <ChangeWalletAddressDialog
            open={walletOpen}
            onClose={() => setWalletOpen(false)}
            currentAddress={account.walletAddress}
          />
        </>
      )}
    </div>
  )
}
