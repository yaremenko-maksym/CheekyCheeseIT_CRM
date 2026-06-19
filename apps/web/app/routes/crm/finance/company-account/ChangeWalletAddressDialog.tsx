import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  CrmDialogContent,
  CrmDialogHeader,
  CrmDialogBody,
  CrmDialogFooter,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/crm-dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from 'sonner'
import { companyAccountApi } from '../api'

const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

/**
 * task-company-account-frontend — ADMIN-only company wallet change. The wallet
 * is sensitive payment-routing config, so the dialog warns about immediate
 * effect and validates the ERC-20 address format inline before submit.
 */
export function ChangeWalletAddressDialog({
  open,
  onClose,
  currentAddress,
}: {
  open: boolean
  onClose: () => void
  currentAddress: string | null
}) {
  const qc = useQueryClient()
  const [address, setAddress] = useState('')

  const mutation = useMutation({
    mutationFn: () => companyAccountApi.updateWallet({ walletAddress: address.trim() }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['company-account'] })
      toast.success('Адрес кошелька обновлён')
      handleClose()
    },
  })

  function handleClose() {
    onClose()
    setAddress('')
  }

  const trimmed = address.trim()
  const showValidity = trimmed.length >= 6
  const isValid = ETH_ADDRESS_RE.test(trimmed)
  const error = mutation.error instanceof Error ? mutation.error.message : null

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) handleClose()
      }}
    >
      <CrmDialogContent maxWidth="sm:max-w-md">
        <CrmDialogHeader>
          <DialogTitle>Изменить адрес кошелька компании</DialogTitle>
          <DialogDescription className="sr-only">
            Смена ERC-20 адреса для получения USDT-депозитов
          </DialogDescription>
        </CrmDialogHeader>

        <CrmDialogBody className="space-y-4 pb-4" data-testid="change-wallet-dialog">
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2.5">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
              <p className="text-xs text-amber-300/90">
                Смена адреса вступит в силу немедленно. Сообщите партнёрам новый адрес для
                пополнений.
              </p>
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Текущий адрес</Label>
            <Input
              readOnly
              value={currentAddress ?? 'Не указан'}
              className="h-8 bg-muted/30 font-mono text-xs"
            />
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Новый адрес (ERC-20)</Label>
            <div className="relative">
              <Input
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="0x…"
                className="h-9 pr-8 font-mono text-sm"
                aria-describedby="wallet-addr-hint"
              />
              {showValidity && (
                <span className="absolute right-2.5 top-1/2 -translate-y-1/2">
                  {isValid ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                  ) : (
                    <XCircle className="h-3.5 w-3.5 text-destructive" />
                  )}
                </span>
              )}
            </div>
            <p id="wallet-addr-hint" className="text-[10px] text-muted-foreground">
              Ethereum ERC-20, начинается с 0x, 42 символа
            </p>
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </CrmDialogBody>

        <CrmDialogFooter>
          <Button variant="outline" onClick={handleClose}>
            Отмена
          </Button>
          <Button onClick={() => mutation.mutate()} disabled={!isValid || mutation.isPending}>
            {mutation.isPending ? 'Сохранение…' : 'Сохранить адрес'}
          </Button>
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}
