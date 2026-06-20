import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Copy, Pencil, Wallet } from 'lucide-react'
import { toast } from 'sonner'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { companyAccountApi } from '../../finance/api'
import { ChangeWalletAddressDialog } from './ChangeWalletAddressDialog'

// /crm/admin/templates/wallet — ADMIN-only management of the company USDT wallet
// (ERC-20). Moved here from the Финансы page CompanyAccountCard (Phase 8 v2).
// The whole /crm/admin/* subtree is ADMIN-only (route-access + AdminTemplatesRoot
// guard), so this page needs no extra role gate. The wallet is sensitive
// payment-routing config — edits go through ChangeWalletAddressDialog (warns
// about immediate effect + validates the ERC-20 format).
export const Route = createFileRoute('/crm/admin/templates/wallet/')({
  component: CompanyWalletPage,
})

function CompanyWalletPage() {
  const [walletOpen, setWalletOpen] = useState(false)

  const { data: account, isLoading } = useQuery({
    queryKey: ['company-account'],
    queryFn: companyAccountApi.getAccount,
  })

  const walletAddress = account?.walletAddress ?? null

  const copyAddr = () => {
    if (!walletAddress) return
    void navigator.clipboard.writeText(walletAddress)
    toast.success('Адрес скопирован')
  }

  return (
    <div className="flex flex-col gap-4" data-testid="admin-company-wallet-page">
      <p className="text-sm text-muted-foreground">
        Адрес кошелька компании для получения USDT (ERC-20). На него поступают подтверждённые
        выплаты синьоров и дропов.
      </p>

      <Card className="max-w-2xl border-border" data-testid="admin-company-wallet-card">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base font-semibold">
            <Wallet className="h-4 w-4 text-primary" />
            Кошелёк компании (USDT ERC-20)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoading ? (
            <Skeleton className="h-9 w-full" />
          ) : (
            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground">Текущий адрес</p>
              {walletAddress ? (
                <div className="flex items-center gap-2 rounded-md border border-border bg-muted/20 px-3 py-2">
                  <code
                    className="flex-1 break-all font-mono text-xs text-foreground/90"
                    data-testid="admin-company-wallet-address"
                  >
                    {walletAddress}
                  </code>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 shrink-0 px-0"
                    onClick={copyAddr}
                    aria-label="Скопировать адрес кошелька"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ) : (
                <p className="text-sm text-amber-500" data-testid="admin-company-wallet-empty">
                  Адрес не настроен
                </p>
              )}
            </div>
          )}

          <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-3">
            <p className="text-xs text-muted-foreground">Сеть: Ethereum ERC-20</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setWalletOpen(true)}
              disabled={isLoading}
              data-testid="admin-company-wallet-edit"
            >
              <Pencil className="mr-1.5 h-3.5 w-3.5" />
              Изменить адрес
            </Button>
          </div>
        </CardContent>
      </Card>

      <ChangeWalletAddressDialog
        open={walletOpen}
        onClose={() => setWalletOpen(false)}
        currentAddress={walletAddress}
      />
    </div>
  )
}
