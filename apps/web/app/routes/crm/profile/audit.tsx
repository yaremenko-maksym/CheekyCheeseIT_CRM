import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { Download, FileText, ScrollText, ShieldCheck } from 'lucide-react'
import { auditTrailResponseSchema } from '@crm/shared'
import type { SignedContractItem, TosAcceptanceItem } from '@crm/shared'
import { api } from '@/lib/axios'
import { useAuth } from '@/context/auth'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'

export const Route = createFileRoute('/crm/profile/audit')({
  component: ProfileAuditPage,
})

const ROLE_LABELS: Record<string, string> = {
  HR: 'HR',
  SENIOR: 'Синьор',
  JUNIOR: 'Джуниор',
  DROP: 'Drop',
  ACCOUNTANT: 'Бухгалтер',
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function downloadMarkdown(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/markdown; charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

// ---------------------------------------------------------------------------
// Contract card
// ---------------------------------------------------------------------------

function ContractCard({ contract }: { contract: SignedContractItem }) {
  return (
    <div
      className="rounded-lg border border-border/60 bg-card p-4 space-y-3"
      data-testid="audit-contract-card"
    >
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-primary shrink-0" />
            <span className="font-mono text-sm font-medium">{contract.contractNumber}</span>
            <Badge variant="outline" className="text-xs">
              {ROLE_LABELS[contract.templateRole] ?? contract.templateRole} · v
              {contract.templateVersion}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            Подписано: {formatDate(contract.signedAt)}
          </p>
          <p className="text-sm text-muted-foreground">
            Подписал(а):{' '}
            <span className="font-medium text-foreground">{contract.signedTypedName}</span>
          </p>
          {contract.signedIp && (
            <p className="text-xs text-muted-foreground">IP: {contract.signedIp}</p>
          )}
        </div>
        <Button
          size="sm"
          variant="outline"
          className="gap-2 shrink-0"
          data-testid="audit-contract-download"
          onClick={() =>
            downloadMarkdown(`${contract.contractNumber}.md`, contract.bodyMarkdownSnapshot)
          }
        >
          <Download className="h-3.5 w-3.5" />
          Скачать
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ToS card
// ---------------------------------------------------------------------------

function TosCard({ tos }: { tos: TosAcceptanceItem }) {
  return (
    <div
      className="rounded-lg border border-border/60 bg-card p-4 space-y-1.5"
      data-testid="audit-tos-card"
    >
      <div className="flex items-center gap-2">
        <ScrollText className="h-4 w-4 text-primary shrink-0" />
        <span className="text-sm font-medium">Terms of Service · версия {tos.tosVersion}</span>
      </div>
      <p className="text-sm text-muted-foreground">Принято: {formatDate(tos.acceptedAt)}</p>
      {tos.acceptedIp && <p className="text-xs text-muted-foreground">IP: {tos.acceptedIp}</p>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function ProfileAuditPage() {
  const { user, isLoading: authLoading } = useAuth()
  const navigate = useNavigate()

  useEffect(() => {
    if (authLoading) return
    if (!user) void navigate({ to: '/crm/login' })
  }, [user, authLoading, navigate])

  const { data, isLoading } = useQuery({
    queryKey: ['audit', 'my-trail'],
    queryFn: async () => {
      const res = await api.get<unknown>('/me/audit-trail')
      return auditTrailResponseSchema.parse(res.data)
    },
    enabled: !!user,
    staleTime: 60_000,
  })

  if (authLoading || !user) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-32 w-full" />
      </div>
    )
  }

  return (
    <div className="space-y-6 max-w-3xl" data-testid="profile-audit-page">
      {/* Header */}
      <div className="flex items-center gap-3">
        <ShieldCheck className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Моя аудит-история</h1>
          <p className="text-sm text-muted-foreground">
            Подписанные контракты и принятые Terms of Service
          </p>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : (
        <>
          {/* Signed contracts */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <FileText className="h-4 w-4" />
                Подписанные контракты
                {data?.signedContracts.length !== undefined && (
                  <Badge variant="secondary" className="ml-1 text-xs">
                    {data.signedContracts.length}
                  </Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {!data?.signedContracts.length ? (
                <p className="text-sm text-muted-foreground py-4 text-center">
                  Нет подписанных контрактов
                </p>
              ) : (
                data.signedContracts.map((c) => <ContractCard key={c.id} contract={c} />)
              )}
            </CardContent>
          </Card>

          {/* ToS acceptances */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <ScrollText className="h-4 w-4" />
                Принятые Terms of Service
                {data?.tosAcceptances.length !== undefined && (
                  <Badge variant="secondary" className="ml-1 text-xs">
                    {data.tosAcceptances.length}
                  </Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {!data?.tosAcceptances.length ? (
                <p className="text-sm text-muted-foreground py-4 text-center">
                  Нет принятых Terms of Service
                </p>
              ) : (
                data.tosAcceptances.map((t) => <TosCard key={t.id} tos={t} />)
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
