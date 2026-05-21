import { useState } from 'react'
import {
  Bitcoin,
  Building2,
  Check,
  Copy,
  Hash,
  IdCard,
  Landmark,
  Tag,
  User as UserIcon,
  Wallet,
} from 'lucide-react'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { UserProfileDto } from '@crm/shared'
import { RequisitesEditForm } from '../self-edit/RequisitesEditForm'
import { cn } from '@/lib/utils'

function FieldRow({
  icon,
  label,
  value,
  copyable,
  mono,
}: {
  icon: React.ReactNode
  label: string
  value: string | null | undefined
  copyable?: boolean
  mono?: boolean
}) {
  const [copied, setCopied] = useState(false)
  const empty = !value
  const display = value ?? 'не указано'

  function copy() {
    if (!value) return
    void navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/30 px-3.5 py-2.5">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground">
          {icon}
        </div>
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
          <p
            className={cn(
              'truncate text-sm',
              mono && !empty && 'font-mono',
              empty && 'italic text-muted-foreground',
            )}
          >
            {display}
          </p>
        </div>
      </div>
      {copyable && !empty && (
        <Button
          variant="ghost"
          size="sm"
          onClick={copy}
          aria-label={`Скопировать ${label}`}
          className="shrink-0"
        >
          {copied ? (
            <Check className="h-4 w-4 text-green-500" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
        </Button>
      )}
    </div>
  )
}

export function RequisitesTab({ user, mode }: { user: UserProfileDto; mode: 'self' | 'view' }) {
  if (mode === 'self') {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Реквизиты для выплат</CardTitle>
          <CardDescription>Выберите метод и заполните реквизиты для выплат</CardDescription>
        </CardHeader>
        <CardContent>
          <RequisitesEditForm user={user} />
        </CardContent>
      </Card>
    )
  }

  const isUsdt = user.paymentMethod === 'USDT_ERC20'
  const isBank = user.paymentMethod === 'BANK_UAH_FOP'

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            {isUsdt && <Bitcoin className="h-4 w-4 text-primary" />}
            {isBank && <Landmark className="h-4 w-4 text-primary" />}
            Реквизиты для выплат
          </CardTitle>
          {isUsdt && <CardDescription>USDT ERC-20 — Ethereum mainnet</CardDescription>}
          {isBank && <CardDescription>Банковский счёт в Украине (ФОП)</CardDescription>}
        </div>
        {user.paymentMethod && (
          <Badge variant="outline">
            {isUsdt ? 'USDT ERC-20' : 'Банк UAH (ФОП)'}
          </Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-2.5">
        {isUsdt && (
          <>
            <FieldRow
              icon={<Wallet className="h-4 w-4" />}
              label="USDT кошелёк"
              value={user.walletUsdtErc20}
              copyable
              mono
            />
            {user.walletUsdtLabel && (
              <FieldRow
                icon={<Tag className="h-4 w-4" />}
                label="Метка"
                value={user.walletUsdtLabel}
              />
            )}
          </>
        )}
        {isBank && (
          <>
            <FieldRow
              icon={<UserIcon className="h-4 w-4" />}
              label="Получатель"
              value={user.bankUahRecipient}
            />
            <FieldRow
              icon={<Hash className="h-4 w-4" />}
              label="IBAN"
              value={user.bankUahIban}
              copyable
              mono
            />
            <FieldRow
              icon={<IdCard className="h-4 w-4" />}
              label="РНОКПП"
              value={user.bankUahRnokpp}
              copyable
              mono
            />
            {user.bankUahBankName && (
              <FieldRow
                icon={<Building2 className="h-4 w-4" />}
                label="Банк"
                value={user.bankUahBankName}
              />
            )}
          </>
        )}
        {!user.paymentMethod && (
          <p className="text-sm text-muted-foreground">Реквизиты не указаны</p>
        )}
      </CardContent>
    </Card>
  )
}
