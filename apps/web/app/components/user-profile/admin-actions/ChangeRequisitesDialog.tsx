import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { paymentRequisitesSchema, type PaymentRequisites, type UserProfileDto } from '@crm/shared'
import { useAdminChangeRequisites } from '@/hooks/use-user-profile'

export function ChangeRequisitesDialog({
  userId,
  user,
  onClose,
}: {
  userId: string
  user: UserProfileDto
  onClose: () => void
}) {
  const mutation = useAdminChangeRequisites(userId)
  const isUsdtOnlyRole = user.role === 'SENIOR' || user.role === 'ADMIN'
  const [method, setMethod] = useState<'USDT_ERC20' | 'BANK_UAH_FOP'>(
    user.paymentMethod ?? 'USDT_ERC20',
  )
  const [walletUsdtErc20, setWalletUsdtErc20] = useState(user.walletUsdtErc20 ?? '')
  const [bankRecipient, setBankRecipient] = useState(user.bankUahRecipient ?? '')
  const [bankIban, setBankIban] = useState(user.bankUahIban ?? '')
  const [bankRnokpp, setBankRnokpp] = useState(user.bankUahRnokpp ?? '')
  const [errors, setErrors] = useState<string[]>([])

  async function save() {
    const payload: PaymentRequisites =
      method === 'USDT_ERC20'
        ? { paymentMethod: 'USDT_ERC20', walletUsdtErc20 }
        : {
            paymentMethod: 'BANK_UAH_FOP',
            bankUahRecipient: bankRecipient,
            bankUahIban: bankIban,
            bankUahRnokpp: bankRnokpp,
          }
    const parsed = paymentRequisitesSchema.safeParse(payload)
    if (!parsed.success) {
      setErrors(parsed.error.issues.map((i) => i.message))
      return
    }
    setErrors([])
    await mutation.mutateAsync(parsed.data)
    onClose()
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Изменить реквизиты</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {!isUsdtOnlyRole && (
            <div className="space-y-2">
              <Label>Способ оплаты</Label>
              <RadioGroup
                value={method}
                onValueChange={(v) => setMethod(v as 'USDT_ERC20' | 'BANK_UAH_FOP')}
                className="flex flex-col gap-2"
              >
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="USDT_ERC20" id="d-m-usdt" />
                  <Label htmlFor="d-m-usdt">USDT ERC-20</Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="BANK_UAH_FOP" id="d-m-bank" />
                  <Label htmlFor="d-m-bank">Банк UAH (ФОП)</Label>
                </div>
              </RadioGroup>
            </div>
          )}
          {method === 'USDT_ERC20' ? (
            <div>
              <Label>USDT ERC-20 адрес</Label>
              <Input
                value={walletUsdtErc20}
                onChange={(e) => setWalletUsdtErc20(e.target.value)}
                placeholder="0x..."
              />
            </div>
          ) : (
            <>
              <div>
                <Label>Получатель (ФИО)</Label>
                <Input
                  value={bankRecipient}
                  onChange={(e) => setBankRecipient(e.target.value)}
                />
              </div>
              <div>
                <Label>IBAN</Label>
                <Input
                  value={bankIban}
                  onChange={(e) => setBankIban(e.target.value)}
                  placeholder="UA..."
                />
              </div>
              <div>
                <Label>РНОКПП</Label>
                <Input
                  value={bankRnokpp}
                  onChange={(e) => setBankRnokpp(e.target.value)}
                  placeholder="10 цифр"
                />
              </div>
            </>
          )}
          {errors.length > 0 && (
            <div className="text-sm text-destructive space-y-1">
              {errors.map((e, i) => (
                <p key={i}>{e}</p>
              ))}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button disabled={mutation.isPending} onClick={save}>
            Сохранить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
