import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Download, FileText, Loader2, ScrollText, ShieldCheck } from 'lucide-react'
import { auditTrailResponseSchema } from '@crm/shared'
import type { SignedContractItem, TosAcceptanceItem } from '@crm/shared'
import { api } from '@/lib/axios'
import { useAuth } from '@/context/auth'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

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
// Contract card with PDF accordion (PD-2 = Вариант C)
// ---------------------------------------------------------------------------

interface ContractCardProps {
  contract: SignedContractItem
  expanded: boolean
  blobUrl: string | null
  isLoadingPdf: boolean
  onToggle: () => void
}

function ContractCard({ contract, expanded, blobUrl, isLoadingPdf, onToggle }: ContractCardProps) {
  const panelId = `pdf-panel-${contract.id}`
  const toggleId = `pdf-toggle-${contract.id}`

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onToggle()
    }
  }

  return (
    <div className="rounded-lg border border-border/60 bg-card" data-testid="audit-contract-card">
      {/* Header row */}
      <div className="p-4 space-y-3">
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

          {/* Actions */}
          <div className="flex flex-col gap-2 shrink-0">
            {/* Accordion toggle */}
            <button
              id={toggleId}
              type="button"
              aria-expanded={expanded}
              aria-controls={panelId}
              data-testid="audit-contract-expand"
              onClick={onToggle}
              onKeyDown={handleKeyDown}
              className={cn(
                'flex items-center gap-1.5 rounded-md border border-border/60 px-3 py-1.5 text-xs font-medium transition-colors',
                'hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                expanded && 'bg-accent',
              )}
            >
              <FileText className="h-3.5 w-3.5" />
              PDF
              <ChevronDown
                className={cn(
                  'h-3 w-3 transition-transform duration-200',
                  expanded && 'rotate-180',
                )}
                aria-hidden="true"
              />
            </button>

            {/* Markdown download */}
            <Button
              size="sm"
              variant="outline"
              className="gap-2"
              data-testid="audit-contract-download"
              onClick={() =>
                downloadMarkdown(`${contract.contractNumber}.md`, contract.bodyMarkdownSnapshot)
              }
            >
              <Download className="h-3.5 w-3.5" />
              Markdown
            </Button>
          </div>
        </div>
      </div>

      {/* Accordion panel */}
      {expanded && (
        <div
          id={panelId}
          role="region"
          aria-labelledby={toggleId}
          data-testid="audit-contract-pdf-panel"
          className="border-t border-border/60 p-4"
        >
          <div
            className="relative w-full rounded-md border border-border bg-muted/20"
            style={{ height: '480px' }}
          >
            {/* Loading overlay */}
            {isLoadingPdf && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 rounded-md bg-muted/30">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                <p className="text-sm text-muted-foreground">Загрузка PDF…</p>
              </div>
            )}

            {/* PDF iframe (nested object — iOS progressive enhancement, from SignContractStep) */}
            {blobUrl && (
              <iframe
                src={blobUrl}
                title={`Контракт ${contract.contractNumber}`}
                aria-label={`Просмотр контракта ${contract.contractNumber}`}
                tabIndex={0}
                data-testid="audit-contract-iframe"
                className={cn('w-full h-full rounded-md border-0', isLoadingPdf && 'invisible')}
                style={{
                  // Mobile: reduce height
                  height: '100%',
                }}
              >
                {/* iOS Safari fallback */}
                <object data={blobUrl} type="application/pdf" className="w-full h-full">
                  <p className="p-4 text-sm text-muted-foreground">
                    Встроенный просмотр PDF недоступен.{' '}
                    <a
                      href={blobUrl}
                      download={`${contract.contractNumber}.pdf`}
                      className="underline hover:text-foreground"
                    >
                      Скачать PDF
                    </a>
                  </p>
                </object>
              </iframe>
            )}

            {/* No blob yet (shouldn't normally show — loading covers it) */}
            {!blobUrl && !isLoadingPdf && (
              <div className="flex h-full items-center justify-center">
                <FileText className="h-10 w-10 text-muted-foreground" />
              </div>
            )}
          </div>

          {/* SR-only note */}
          <p className="sr-only">
            PDF-документ контракта {contract.contractNumber}. Используйте кнопку Markdown для
            скачивания текстовой версии.
          </p>
        </div>
      )}
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

  // Accordion state: which contract ids are expanded
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  // Blob URLs per contractId — fetched on first expand
  const [blobs, setBlobs] = useState<Record<string, string>>({})
  // Loading state per contractId
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set())

  // Ref to track all blob URLs for cleanup
  const blobsRef = useRef(blobs)
  blobsRef.current = blobs

  // Cleanup: revoke all blob URLs on unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      const current = blobsRef.current
      Object.values(current).forEach((url) => URL.revokeObjectURL(url))
    }
  }, [])

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

  function handleToggle(contractId: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(contractId)) {
        // Collapse: revoke blob URL
        next.delete(contractId)
        const url = blobsRef.current[contractId]
        if (url) {
          URL.revokeObjectURL(url)
          setBlobs((b) => {
            const nb = { ...b }
            delete nb[contractId]
            return nb
          })
        }
      } else {
        // Expand: start loading PDF if not already loaded
        next.add(contractId)
        if (!blobsRef.current[contractId]) {
          setLoadingIds((l) => new Set(l).add(contractId))
          void api
            .get(`/contracts/${contractId}/pdf`, { responseType: 'blob' })
            .then((res) => {
              const url = URL.createObjectURL(res.data as Blob)
              setBlobs((b) => ({ ...b, [contractId]: url }))
            })
            .finally(() => {
              setLoadingIds((l) => {
                const nl = new Set(l)
                nl.delete(contractId)
                return nl
              })
            })
        }
      }
      return next
    })
  }

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
                data.signedContracts.map((c) => (
                  <ContractCard
                    key={c.id}
                    contract={c}
                    expanded={expandedIds.has(c.id)}
                    blobUrl={blobs[c.id] ?? null}
                    isLoadingPdf={loadingIds.has(c.id)}
                    onToggle={() => handleToggle(c.id)}
                  />
                ))
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
