import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { UserProfileDto } from '@crm/shared'
import { RequisitesEditForm } from '../self-edit/RequisitesEditForm'

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
      <CardHeader>
        <CardTitle>Реквизиты для выплат</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <Row
          label="Способ"
          value={
            user.paymentMethod === 'USDT_ERC20'
              ? 'USDT ERC-20'
              : user.paymentMethod === 'BANK_UAH_FOP'
                ? 'Банк UAH (ФОП)'
                : '—'
          }
        />
        {user.paymentMethod === 'USDT_ERC20' && (
          <>
            <Row label="USDT кошелёк" value={user.walletUsdtErc20 ?? '—'} mono />
            {user.walletUsdtLabel && <Row label="Метка" value={user.walletUsdtLabel} />}
          </>
        )}
        {user.paymentMethod === 'BANK_UAH_FOP' && (
          <>
            <Row label="Получатель" value={user.bankUahRecipient ?? '—'} />
            <Row label="IBAN" value={user.bankUahIban ?? '—'} mono />
            <Row label="РНОКПП" value={user.bankUahRnokpp ?? '—'} mono />
            {user.bankUahBankName && <Row label="Банк" value={user.bankUahBankName} />}
          </>
        )}
      </CardContent>
    </Card>
  )
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between border-b pb-2 last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className={mono ? 'font-mono text-xs' : 'font-medium'}>{value}</span>
    </div>
  )
}
