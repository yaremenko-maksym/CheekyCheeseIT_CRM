import { useState } from 'react'
import { Copy, Check } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { UserProfileDto } from '@crm/shared'
import { RequisitesEditForm } from '../self-edit/RequisitesEditForm'

function CopyableField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)

  function copy() {
    void navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="flex items-center justify-between gap-3 rounded border bg-muted/30 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="truncate font-mono text-sm">{value}</p>
      </div>
      <Button variant="ghost" size="sm" onClick={copy} className="shrink-0">
        {copied ? (
          <Check className="h-4 w-4 text-green-500" />
        ) : (
          <Copy className="h-4 w-4" />
        )}
      </Button>
    </div>
  )
}

function PlainField({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border bg-muted/30 px-4 py-3">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-sm">{value}</p>
    </div>
  )
}

export function RequisitesTab({ user, mode }: { user: UserProfileDto; mode: 'self' | 'view' }) {
  if (mode === 'self') {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Реквизиты для выплат</CardTitle>
        </CardHeader>
        <CardContent>
          <RequisitesEditForm user={user} />
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Реквизиты для выплат</CardTitle>
        {user.paymentMethod && (
          <Badge variant="outline">
            {user.paymentMethod === 'USDT_ERC20' ? 'USDT ERC-20' : 'Банк UAH (ФОП)'}
          </Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {user.paymentMethod === 'USDT_ERC20' && (
          <>
            <CopyableField label="USDT кошелёк" value={user.walletUsdtErc20 ?? '—'} />
            {user.walletUsdtLabel && <PlainField label="Метка" value={user.walletUsdtLabel} />}
          </>
        )}
        {user.paymentMethod === 'BANK_UAH_FOP' && (
          <>
            <PlainField label="Получатель" value={user.bankUahRecipient ?? '—'} />
            <CopyableField label="IBAN" value={user.bankUahIban ?? '—'} />
            <CopyableField label="РНОКПП" value={user.bankUahRnokpp ?? '—'} />
            {user.bankUahBankName && <PlainField label="Банк" value={user.bankUahBankName} />}
          </>
        )}
        {!user.paymentMethod && (
          <p className="text-sm text-muted-foreground">Реквизиты не указаны</p>
        )}
      </CardContent>
    </Card>
  )
}
