import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Banknote, Coins, Copy, Wallet } from 'lucide-react'
import { toast } from 'sonner'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { companyAccountApi } from '../api'
import { WithdrawDividendsDialog } from './WithdrawDividendsDialog'
import { ChangeWalletAddressDialog } from './ChangeWalletAddressDialog'

function fmtUsdt(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function shortAddress(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr
}

/**
 * task-company-account-page-to-finance — the company USDT account as a card on
 * the Финансы page (replaces the standalone /crm/finance/company-account route).
 * ADMIN/ACCOUNTANT see the balance + wallet; ADMIN additionally gets the
 * dividend-withdrawal and wallet-change actions. Deposits no longer happen here —
 * they flow through the payout settlement (Phase 8 v2).
 */
export function CompanyAccountCard({ isAdmin }: { isAdmin: boolean }) {
  const [dividendsOpen, setDividendsOpen] = useState(false)
  const [walletOpen, setWalletOpen] = useState(false)

  const { data: account } = useQuery({
    queryKey: ['company-account'],
    queryFn: companyAccountApi.getAccount,
  })

  if (!account) return null
  const { walletAddress, balance } = account

  const copyAddr = () => {
    if (!walletAddress) return
    void navigator.clipboard.writeText(walletAddress)
    toast.success('Адрес скопирован')
  }

  return (
    <Card className="border-border">
      <CardContent className="pb-4 pt-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-widest text-muted-foreground">
              <Coins className="h-3.5 w-3.5 text-primary" /> Счёт компании · USDT
            </p>
            <p
              className={`mt-1 text-3xl font-bold tabular-nums ${balance > 0 ? 'text-foreground' : 'text-muted-foreground'}`}
            >
              {fmtUsdt(balance)}
              <span className="ml-1.5 text-sm font-medium text-muted-foreground">USDT</span>
            </p>
          </div>

          <div className="flex flex-col items-end gap-2">
            <div className="text-right">
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
            </div>

            {isAdmin && (
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setWalletOpen(true)}
                  data-testid="change-wallet-btn"
                >
                  <Wallet className="mr-1.5 h-4 w-4" /> Кошелёк
                </Button>
                <Button
                  size="sm"
                  onClick={() => setDividendsOpen(true)}
                  disabled={balance <= 0}
                  data-testid="open-dividends-btn"
                >
                  <Banknote className="mr-1.5 h-4 w-4" /> Дивиденды
                </Button>
              </div>
            )}
          </div>
        </div>

        <Separator className="mb-2 mt-4" />
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" aria-hidden />
          <p className="text-xs text-muted-foreground">
            Сеть: Ethereum ERC-20 · приходы — через подтверждение выплат
          </p>
        </div>
      </CardContent>

      {isAdmin && (
        <>
          <WithdrawDividendsDialog
            open={dividendsOpen}
            onClose={() => setDividendsOpen(false)}
            balance={balance}
          />
          <ChangeWalletAddressDialog
            open={walletOpen}
            onClose={() => setWalletOpen(false)}
            currentAddress={walletAddress}
          />
        </>
      )}
    </Card>
  )
}
