import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, FileText, Pencil, Wallet } from 'lucide-react'
import { toast } from 'sonner'
import { COMPANY_REQUISITES_MAX } from '@crm/shared'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { companyAccountApi } from '../finance/api'
import { ChangeWalletAddressDialog } from './ChangeWalletAddressDialog'

// /admin/wallet — ADMIN-only «Компания» configuration: the company USDT wallet
// (ERC-20) + the company requisites markdown that is auto-appended to NEW
// contracts. The whole /admin/* subtree is ADMIN-only (route-access +
// AdminTemplatesRoot guard), so this page needs no extra role gate.
export const Route = createFileRoute('/_authenticated/admin/wallet/')({
  component: CompanyWalletPage,
})

// Lazy-load CodeMirror + markdown extension + dark theme — heavy deps loaded
// only when ADMIN edits requisites. Mirrors the contracts editor loader.
const CodeMirrorEditor = lazy(async () => {
  const [{ default: CodeMirror }, { markdown }, { oneDark }] = await Promise.all([
    import('@uiw/react-codemirror'),
    import('@codemirror/lang-markdown'),
    import('@codemirror/theme-one-dark'),
  ])
  const mdExtension = markdown()
  function LazyEditor(props: React.ComponentProps<typeof CodeMirror>) {
    const extensions = [mdExtension, ...(props.extensions ?? [])]
    return <CodeMirror theme={oneDark} {...props} extensions={extensions} />
  }
  return { default: LazyEditor }
})

function CompanyWalletPage() {
  const qc = useQueryClient()
  const [walletOpen, setWalletOpen] = useState(false)

  const { data: account, isLoading } = useQuery({
    queryKey: ['company-account'],
    queryFn: companyAccountApi.getAccount,
  })

  const walletAddress = account?.walletAddress ?? null

  const copyAddr = () => {
    if (!walletAddress) return
    void navigator.clipboard.writeText(walletAddress)
    toast.success('Адрес скопирован')
  }

  // ── Requisites editor state ────────────────────────────────────────────────
  // `null` = not yet initialized from the server; once the account loads we seed
  // it once. `requisites` holds the in-progress edit; pristine = equals saved.
  const [requisites, setRequisites] = useState<string | null>(null)
  const seededRef = useRef(false)
  useEffect(() => {
    if (account && !seededRef.current) {
      seededRef.current = true
      setRequisites(account.requisitesMarkdown ?? '')
    }
  }, [account])

  const savedRequisites = account?.requisitesMarkdown ?? ''
  const currentRequisites = requisites ?? savedRequisites
  const isPristine = currentRequisites === savedRequisites
  const isTooLong = currentRequisites.length > COMPANY_REQUISITES_MAX

  const saveRequisites = useMutation({
    mutationFn: () => companyAccountApi.updateRequisites({ requisitesMarkdown: currentRequisites }),
    onSuccess: (updated) => {
      // Re-seed from the server value so the editor reflects the persisted state
      // (empty/whitespace is coerced to null server-side).
      setRequisites(updated.requisitesMarkdown ?? '')
      void qc.invalidateQueries({ queryKey: ['company-account'] })
      toast.success('Реквизиты сохранены')
    },
    onError: () => {
      toast.error('Не удалось сохранить реквизиты')
    },
  })

  return (
    <div className="flex flex-col gap-4" data-testid="admin-company-page">
      <p className="text-sm text-muted-foreground">
        Настройки компании: кошелёк для приёма USDT и реквизиты, которые автоматически добавляются в
        конец каждого нового контракта при подписании.
      </p>

      <Card className="max-w-2xl border-border" data-testid="admin-company-wallet-card">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base font-semibold">
            <Wallet className="h-4 w-4 text-primary" />
            Кошелёк компании (USDT ERC-20)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoading ? (
            <Skeleton className="h-9 w-full" />
          ) : (
            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground">Текущий адрес</p>
              {walletAddress ? (
                <div className="flex items-center gap-2 rounded-md border border-border bg-muted/20 px-3 py-2">
                  <code
                    className="flex-1 break-all font-mono text-xs text-foreground/90"
                    data-testid="admin-company-wallet-address"
                  >
                    {walletAddress}
                  </code>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 shrink-0 px-0"
                    onClick={copyAddr}
                    aria-label="Скопировать адрес кошелька"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ) : (
                <p className="text-sm text-amber-500" data-testid="admin-company-wallet-empty">
                  Адрес не настроен
                </p>
              )}
            </div>
          )}

          <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-3">
            <p className="text-xs text-muted-foreground">Сеть: Ethereum ERC-20</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setWalletOpen(true)}
              disabled={isLoading}
              data-testid="admin-company-wallet-edit"
            >
              <Pencil className="mr-1.5 h-3.5 w-3.5" />
              Изменить адрес
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Requisites editor — auto-appended «Реквизиты компании» section in NEW contracts */}
      <Card className="max-w-2xl border-border" data-testid="admin-company-requisites-card">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base font-semibold">
            <FileText className="h-4 w-4 text-primary" />
            Реквизиты компании
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Markdown. Этот блок добавляется в конец каждого нового контракта под заголовком
            «Реквизиты компании». Шаблоны контрактов менять не нужно. Изменения влияют только на
            будущие подписания — уже подписанные контракты не меняются.
          </p>

          {isLoading || requisites === null ? (
            <Skeleton className="h-[220px] w-full" />
          ) : (
            <div
              className="flex flex-col overflow-hidden rounded-lg border border-border/60"
              data-testid="admin-company-requisites-editor-wrapper"
            >
              <div className="border-b border-border/60 bg-muted/30 px-3 py-1.5 text-xs font-medium text-muted-foreground">
                Markdown редактор
              </div>
              <Suspense fallback={<Skeleton className="h-[220px] w-full" />}>
                <CodeMirrorEditor
                  value={currentRequisites}
                  onChange={(val) => setRequisites(val)}
                  basicSetup={{
                    lineNumbers: true,
                    foldGutter: false,
                    highlightActiveLine: true,
                    autocompletion: false,
                    bracketMatching: false,
                    closeBrackets: false,
                    searchKeymap: false,
                  }}
                  height="220px"
                  style={{ fontSize: '13px' }}
                  data-testid="admin-company-requisites-codemirror"
                />
              </Suspense>
            </div>
          )}

          <div className="flex flex-col gap-2 border-t border-border/60 pt-3 sm:flex-row sm:items-center sm:justify-between">
            <p
              className={`text-xs ${isTooLong ? 'text-destructive' : 'text-muted-foreground'}`}
              data-testid="admin-company-requisites-counter"
            >
              {currentRequisites.length} / {COMPANY_REQUISITES_MAX}
            </p>
            <Button
              size="sm"
              onClick={() => saveRequisites.mutate()}
              disabled={isPristine || isTooLong || saveRequisites.isPending || isLoading}
              data-testid="admin-company-requisites-save"
            >
              {saveRequisites.isPending ? 'Сохранение…' : 'Сохранить'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <ChangeWalletAddressDialog
        open={walletOpen}
        onClose={() => setWalletOpen(false)}
        currentAddress={walletAddress}
      />
    </div>
  )
}
