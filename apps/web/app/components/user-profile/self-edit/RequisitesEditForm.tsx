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
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { paymentRequisitesSchema } from '@crm/shared'
import type { PaymentRequisites, UserProfileDto } from '@crm/shared'
import { AnimatedTabs } from '@/components/ui/animated-tabs'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { translateZodMessage } from '@/lib/axios-utils'
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useUpdateMeRequisites } from '@/hooks/use-user-profile'

type Method = 'USDT_ERC20' | 'BANK_UAH_FOP'

/**
 * task-i18n-stage3b (Task 1), Step 6 — same `msg` for both the disabled-tab
 * tooltip and the standalone `TooltipContent` copy below (COPY-M-11): a
 * SENIOR/ADMIN sees the identical sentence twice, so one catalog key keeps
 * them from drifting apart.
 */
const USDT_ONLY_HINT = msg`Ви отримуєте виплати лише в USDT (мережа Ethereum) — змінити спосіб не можна`

export function RequisitesEditForm({ user }: { user: UserProfileDto }) {
  const { t, i18n } = useLingui()
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
      setErrors(parsed.error.issues.map((i) => translateZodMessage(i.message) ?? i.message))
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
    { value: 'USDT_ERC20', label: 'USDT (ERC-20)', ariaLabel: 'USDT (ERC-20)' },
    {
      value: 'BANK_UAH_FOP',
      label: t`ФОП (UAH)`,
      ariaLabel: t`ФОП (UAH)`,
      ...(isUsdtOnlyRole ? { disabled: true, disabledTooltip: i18n._(USDT_ONLY_HINT) } : {}),
    },
  ]

  return (
    <TooltipProvider delayDuration={150}>
      <form onSubmit={handleSubmit} className="space-y-5" aria-label={t`Спосіб виплати`}>
        {/* ---------- Method switcher: AnimatedTabs with yellow pill ---------- */}
        <div className="space-y-2">
          <Label>
            <Trans>Спосіб виплати</Trans>
          </Label>
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
              <TooltipContent side="top">{i18n._(USDT_ONLY_HINT)}</TooltipContent>
            </Tooltip>
          ) : (
            <AnimatedTabs tabs={tabs} value={method} onChange={(v) => setMethod(v as Method)} />
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
                    <Trans>Гаманець USDT (ERC-20)</Trans>
                  </CardTitle>
                  <CardDescription>
                    <Trans>Адреса для отримання виплат у мережі Ethereum</Trans>
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="walletUsdtErc20">
                      <Trans>Гаманець USDT (ERC-20)</Trans>
                    </Label>
                    <div className="relative">
                      <Wallet className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        id="walletUsdtErc20"
                        value={walletUsdtErc20}
                        onChange={(e) => setWalletUsdtErc20(e.target.value)}
                        placeholder="0x1234…abcd"
                        autoCapitalize="off"
                        autoCorrect="off"
                        spellCheck={false}
                        autoComplete="off"
                        className="pl-9 font-mono"
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      <Trans>Починається з 0x, усього 42 символи</Trans>
                    </p>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="walletUsdtLabel">
                      <Trans>Мітка (необов’язково)</Trans>
                    </Label>
                    <div className="relative">
                      <Tag className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        id="walletUsdtLabel"
                        value={walletUsdtLabel}
                        onChange={(e) => setWalletUsdtLabel(e.target.value)}
                        placeholder={t`наприклад: основний`}
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
                    <Trans>Банківські реквізити ФОП</Trans>
                  </CardTitle>
                  <CardDescription>
                    <Trans>Для переказу в гривні на український ФОП</Trans>
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="bankRecipient">
                      <Trans>Ім’я та прізвище отримувача</Trans>
                    </Label>
                    <div className="relative">
                      <UserIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        id="bankRecipient"
                        value={bankRecipient}
                        onChange={(e) => setBankRecipient(e.target.value)}
                        placeholder={t`Іваненко Іван Іванович`}
                        autoCapitalize="words"
                        autoComplete="name"
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
                          autoCapitalize="characters"
                          autoCorrect="off"
                          spellCheck={false}
                          className="pl-9 font-mono uppercase"
                        />
                      </div>
                      <p className="text-xs text-muted-foreground">
                        <Trans>UA + 27 цифр</Trans>
                      </p>
                    </div>

                    <div className="space-y-1.5">
                      <Label htmlFor="bankRnokpp">
                        <Trans>РНОКПП (10 цифр)</Trans>
                      </Label>
                      <div className="relative">
                        <IdCard className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          id="bankRnokpp"
                          value={bankRnokpp}
                          onChange={(e) => setBankRnokpp(e.target.value)}
                          placeholder="1234567890"
                          inputMode="numeric"
                          pattern="[0-9]*"
                          maxLength={10}
                          className="pl-9 font-mono"
                        />
                      </div>
                      <p className="text-xs text-muted-foreground">
                        <Trans>10 цифр</Trans>
                      </p>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="bankName">
                      <Trans>Назва банку (необов’язково)</Trans>
                    </Label>
                    <div className="relative">
                      <Building2 className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        id="bankName"
                        value={bankName}
                        onChange={(e) => setBankName(e.target.value)}
                        placeholder={t`ПриватБанк`}
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
          <Trans>Зберегти реквізити</Trans>
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
            <AlertDialogTitle>
              <Trans>Зміна реквізитів</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>
                На основі цих даних відбуватимуться наступні виплати — підтвердіть зміну
              </Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <Trans>Скасувати</Trans>
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirm}>
              <Trans>Підтвердити</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  )
}
