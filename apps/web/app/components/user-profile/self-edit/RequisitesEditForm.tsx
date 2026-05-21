import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Bitcoin,
  Building2,
  Hash,
  IdCard,
  Landmark,
  Tag,
  User as UserIcon,
  Wallet,
} from 'lucide-react'
import { paymentRequisitesSchema } from '@crm/shared'
import type { PaymentRequisites, UserProfileDto } from '@crm/shared'
import { AnimatedTabs } from '@/components/ui/animated-tabs'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useUpdateMeRequisites } from '@/hooks/use-user-profile'

type Method = 'USDT_ERC20' | 'BANK_UAH_FOP'

export function RequisitesEditForm({ user }: { user: UserProfileDto }) {
  const mutation = useUpdateMeRequisites()
  const [pending, setPending] = useState<PaymentRequisites | null>(null)

  const isUsdtOnlyRole = user.role === 'SENIOR' || user.role === 'ADMIN'

  const [method, setMethod] = useState<Method>(user.paymentMethod ?? 'USDT_ERC20')
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

  // Tabs with the same animated yellow pill as the profile tabs.
  // For SENIOR/ADMIN the BANK_UAH_FOP tab is rendered disabled with a lock icon.
  const tabs = [
    { value: 'USDT_ERC20', label: 'USDT ERC-20', ariaLabel: 'USDT ERC-20' },
    {
      value: 'BANK_UAH_FOP',
      label: 'UAH ФОП',
      ariaLabel: 'Банк UAH (ФОП)',
      ...(isUsdtOnlyRole
        ? { disabled: true, disabledTooltip: 'SENIOR и ADMIN получают только в USDT ERC-20' }
        : {}),
    },
  ]

  return (
    <TooltipProvider delayDuration={150}>
      <form onSubmit={handleSubmit} className="space-y-5" aria-label="Способ выплаты">
        {/* ---------- Method switcher: AnimatedTabs with yellow pill ---------- */}
        <div className="space-y-2">
          <Label>Способ выплаты</Label>
          {isUsdtOnlyRole ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="inline-block">
                  <AnimatedTabs
                    tabs={tabs}
                    value={method}
                    onChange={(v) => setMethod(v as Method)}
                  />
                </div>
              </TooltipTrigger>
              <TooltipContent side="top">
                SENIOR и ADMIN получают только в USDT ERC-20
              </TooltipContent>
            </Tooltip>
          ) : (
            <AnimatedTabs
              tabs={tabs}
              value={method}
              onChange={(v) => setMethod(v as Method)}
            />
          )}
        </div>

        {/* ---------- Animated card switch ---------- */}
        <AnimatePresence mode="wait" initial={false}>
          {method === 'USDT_ERC20' ? (
            <motion.div
              key="usdt"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
            >
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Bitcoin className="h-4 w-4 text-primary" />
                    USDT ERC-20 кошелёк
                  </CardTitle>
                  <CardDescription>
                    Адрес для получения выплат в сети Ethereum
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="walletUsdtErc20">USDT ERC-20 кошелёк</Label>
                    <div className="relative">
                      <Wallet className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        id="walletUsdtErc20"
                        value={walletUsdtErc20}
                        onChange={(e) => setWalletUsdtErc20(e.target.value)}
                        placeholder="0x1234…abcd"
                        className="pl-9 font-mono"
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Начинается с 0x, всего 42 символа
                    </p>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="walletUsdtLabel">Метка (необязательно)</Label>
                    <div className="relative">
                      <Tag className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        id="walletUsdtLabel"
                        value={walletUsdtLabel}
                        onChange={(e) => setWalletUsdtLabel(e.target.value)}
                        placeholder="например: основной"
                        className="pl-9"
                      />
                    </div>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          ) : (
            <motion.div
              key="bank"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
            >
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Landmark className="h-4 w-4 text-primary" />
                    Банковские реквизиты ФОП
                  </CardTitle>
                  <CardDescription>
                    Для перевода в гривне на украинский ФОП
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="bankRecipient">ФИО получателя</Label>
                    <div className="relative">
                      <UserIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        id="bankRecipient"
                        value={bankRecipient}
                        onChange={(e) => setBankRecipient(e.target.value)}
                        placeholder="Иванов Иван Иванович"
                        className="pl-9"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="bankIban">IBAN (UA…)</Label>
                      <div className="relative">
                        <Hash className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          id="bankIban"
                          value={bankIban}
                          onChange={(e) => setBankIban(e.target.value)}
                          placeholder="UA21 3223 1300 0002 6007 2335 6600 1"
                          className="pl-9 font-mono uppercase"
                        />
                      </div>
                      <p className="text-xs text-muted-foreground">UA + 27 цифр</p>
                    </div>

                    <div className="space-y-1.5">
                      <Label htmlFor="bankRnokpp">РНОКПП (10 цифр)</Label>
                      <div className="relative">
                        <IdCard className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          id="bankRnokpp"
                          value={bankRnokpp}
                          onChange={(e) => setBankRnokpp(e.target.value)}
                          placeholder="1234567890"
                          inputMode="numeric"
                          maxLength={10}
                          className="pl-9 font-mono"
                        />
                      </div>
                      <p className="text-xs text-muted-foreground">10 цифр</p>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="bankName">Название банка (необязательно)</Label>
                    <div className="relative">
                      <Building2 className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        id="bankName"
                        value={bankName}
                        onChange={(e) => setBankName(e.target.value)}
                        placeholder="ПриватБанк"
                        className="pl-9"
                      />
                    </div>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          )}
        </AnimatePresence>

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

      <AlertDialog
        open={!!pending}
        onOpenChange={(open) => {
          if (!open) setPending(null)
        }}
      >
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
    </TooltipProvider>
  )
}
