import type { CompanyAccountDto } from '@crm/shared'
import { Copy } from 'lucide-react'
import { toast } from 'sonner'
import { Card, CardContent } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Button } from '@/components/ui/button'

interface CompanyBalanceKpiProps {
  account: CompanyAccountDto
  isAdmin: boolean
  onChangeWallet: () => void
}

function shortAddress(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr
}

function fmtUsdt(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/**
 * task-company-account-frontend — the company USDT balance as the page's
 * primary KPI (text-4xl, one hierarchy step above the standard KpiCard). Shows
 * the configured wallet (ADMIN) with copy + change affordances.
 */
export function CompanyBalanceKpi({ account, isAdmin, onChangeWallet }: CompanyBalanceKpiProps) {
  const { walletAddress, balance } = account
  const copyAddr = () => {
    if (!walletAddress) return
    void navigator.clipboard.writeText(walletAddress)
    toast.success('Адрес скопирован')
  }

  return (
    <Card className="border-border" data-testid="company-balance-kpi">
      <CardContent className="pb-5 pt-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[11px] uppercase tracking-widest text-muted-foreground">
              Баланс компании · USDT
            </p>
            <p
              className={`text-4xl font-bold tabular-nums ${balance > 0 ? 'text-foreground' : 'text-muted-foreground'}`}
            >
              {fmtUsdt(balance)}
              <span className="ml-1.5 text-sm font-medium text-muted-foreground">USDT</span>
            </p>
          </div>

          {isAdmin && (
            <div className="shrink-0 text-right">
              <p className="text-[10px] text-muted-foreground">Адрес кошелька</p>
              {walletAddress ? (
                <div className="flex items-center justify-end gap-1">
                  <span
                    className="font-mono text-xs text-foreground/80"
                    title={walletAddress}
                    data-testid="company-wallet-address"
                  >
                    {shortAddress(walletAddress)}
                  </span>
                  <button
                    type="button"
                    onClick={copyAddr}
                    className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                    aria-label="Скопировать адрес кошелька"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Не указан</p>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="mt-0.5 h-6 px-2 text-xs text-primary"
                onClick={onChangeWallet}
                data-testid="change-wallet-btn"
              >
                {walletAddress ? 'Изменить' : 'Добавить'}
              </Button>
            </div>
          )}
        </div>

        <Separator className="mb-3 mt-4" />
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" aria-hidden />
          <p className="text-xs text-muted-foreground">Сеть: Ethereum ERC-20</p>
        </div>
      </CardContent>
    </Card>
  )
}
