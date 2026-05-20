import { useState } from 'react'
import { paymentRequisitesSchema } from '@crm/shared'
import type { PaymentRequisites, UserProfileDto } from '@crm/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useUpdateMeRequisites } from '@/hooks/use-user-profile'

export function RequisitesEditForm({ user }: { user: UserProfileDto }) {
  const mutation = useUpdateMeRequisites()
  const [pending, setPending] = useState<PaymentRequisites | null>(null)

  const isUsdtOnlyRole = user.role === 'SENIOR' || user.role === 'ADMIN'

  const [method, setMethod] = useState<'USDT_ERC20' | 'BANK_UAH_FOP'>(
    user.paymentMethod ?? 'USDT_ERC20',
  )
  const [walletUsdtErc20, setWalletUsdtErc20] = useState(user.walletUsdtErc20 ?? '')
  const [walletUsdtLabel, setWalletUsdtLabel] = useState(user.walletUsdtLabel ?? '')
  const [bankRecipient, setBankRecipient] = useState(user.bankUahRecipient ?? '')
  const [bankIban, setBankIban] = useState(user.bankUahIban ?? '')
  const [bankRnokpp, setBankRnokpp] = useState(user.bankUahRnokpp ?? '')
  const [bankName, setBankName] = useState(user.bankUahBankName ?? '')
  const [errors, setErrors] = useState<string[]>([])

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    const payload =
      method === 'USDT_ERC20'
        ? {
            paymentMethod: method,
            walletUsdtErc20,
            walletUsdtLabel: walletUsdtLabel || null,
          }
        : {
            paymentMethod: method,
            bankUahRecipient: bankRecipient,
            bankUahIban: bankIban,
            bankUahRnokpp: bankRnokpp,
            bankUahBankName: bankName || null,
          }

    const parsed = paymentRequisitesSchema.safeParse(payload)
    if (!parsed.success) {
      setErrors(parsed.error.issues.map((i) => i.message))
      return
    }

    setErrors([])
    setPending(parsed.data)
  }

  function handleConfirm() {
    if (pending) {
      mutation.mutate(pending)
      setPending(null)
    }
  }

  return (
    <>
      <form onSubmit={handleSubmit} className="space-y-4">
        {!isUsdtOnlyRole && (
          <div className="space-y-2">
            <Label>Способ выплаты</Label>
            <RadioGroup
              value={method}
              onValueChange={(v) => setMethod(v as 'USDT_ERC20' | 'BANK_UAH_FOP')}
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem value="USDT_ERC20" id="m-usdt" />
                <Label htmlFor="m-usdt">USDT ERC-20</Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="BANK_UAH_FOP" id="m-bank" />
                <Label htmlFor="m-bank">Банк UAH (ФОП)</Label>
              </div>
            </RadioGroup>
          </div>
        )}

        {method === 'USDT_ERC20' ? (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="walletUsdtErc20">USDT ERC-20 кошелёк</Label>
              <Input
                id="walletUsdtErc20"
                value={walletUsdtErc20}
                onChange={(e) => setWalletUsdtErc20(e.target.value)}
                placeholder="0x..."
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="walletUsdtLabel">Метка (опц.)</Label>
              <Input
                id="walletUsdtLabel"
                value={walletUsdtLabel}
                onChange={(e) => setWalletUsdtLabel(e.target.value)}
                placeholder="например: основной"
              />
            </div>
          </>
        ) : (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="bankRecipient">ФИО получателя</Label>
              <Input
                id="bankRecipient"
                value={bankRecipient}
                onChange={(e) => setBankRecipient(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bankIban">IBAN (UA…)</Label>
              <Input
                id="bankIban"
                value={bankIban}
                onChange={(e) => setBankIban(e.target.value)}
                placeholder="UA21..."
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bankRnokpp">РНОКПП (10 цифр)</Label>
              <Input
                id="bankRnokpp"
                value={bankRnokpp}
                onChange={(e) => setBankRnokpp(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bankName">Название банка (опц.)</Label>
              <Input
                id="bankName"
                value={bankName}
                onChange={(e) => setBankName(e.target.value)}
              />
            </div>
          </>
        )}

        {errors.length > 0 && (
          <div className="space-y-1 text-sm text-destructive">
            {errors.map((err, i) => (
              <p key={i}>{err}</p>
            ))}
          </div>
        )}

        <Button type="submit" disabled={mutation.isPending}>
          Сохранить реквизиты
        </Button>
      </form>

      <AlertDialog open={!!pending} onOpenChange={(open) => { if (!open) setPending(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Изменение реквизитов</AlertDialogTitle>
            <AlertDialogDescription>
              На основе этих данных будут производиться следующие выплаты. Подтвердите изменение.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirm}>Подтвердить</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
