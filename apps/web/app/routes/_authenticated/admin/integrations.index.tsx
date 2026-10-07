import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Copy, MoreHorizontal, Plus } from 'lucide-react'
import { Trans, useLingui } from '@lingui/react/macro'
import { toast } from 'sonner'
import {
  createMeetingRecorderConnectionSchema,
  meetingRecorderSigningSecretSchema,
  type MeetingRecorderConnectionDto,
} from '@crm/shared'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  CrmDialogBody,
  CrmDialogContent,
  CrmDialogFooter,
  CrmDialogHeader,
  Dialog,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/crm-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  MEETING_RECORDER_CONNECTIONS_QUERY_KEY,
  meetingRecorderApi,
  useMeetingRecorderConnections,
} from '@/lib/meeting-recorder-api'

export const Route = createFileRoute('/_authenticated/admin/integrations/')({
  component: MeetingRecorderIntegrationsPage,
})

function MeetingRecorderIntegrationsPage() {
  const { t, i18n } = useLingui()
  const queryClient = useQueryClient()
  const connectionsQuery = useMeetingRecorderConnections()
  const [createOpen, setCreateOpen] = useState(false)
  const [renameConnection, setRenameConnection] = useState<MeetingRecorderConnectionDto | null>(
    null,
  )
  const [secretConnection, setSecretConnection] = useState<MeetingRecorderConnectionDto | null>(
    null,
  )
  const [resetConnection, setResetConnection] = useState<MeetingRecorderConnectionDto | null>(null)

  const enableMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      meetingRecorderApi.updateConnection(id, { enabled }),
    onSuccess: async (_data, variables) => {
      await queryClient.invalidateQueries({ queryKey: MEETING_RECORDER_CONNECTIONS_QUERY_KEY })
      toast.success(variables.enabled ? t`Підключення увімкнено` : t`Підключення вимкнено`)
    },
    onError: () => toast.error(t`Не вдалося змінити стан підключення`),
  })

  const resetMutation = useMutation({
    mutationFn: (id: string) => meetingRecorderApi.resetConnectionPairing(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: MEETING_RECORDER_CONNECTIONS_QUERY_KEY })
      setResetConnection(null)
      toast.success(t`Прив'язку скинуто. Налаштуйте новий секрет.`)
    },
    onError: () => toast.error(t`Не вдалося скинути прив'язку`),
  })

  function formatDate(value: string | null) {
    if (!value) return '—'
    return new Intl.DateTimeFormat(i18n.locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value))
  }

  function connectionStatus(connection: MeetingRecorderConnectionDto) {
    if (!connection.enabled) return { variant: 'secondary' as const, label: t`Вимкнено` }
    if (!connection.secretSet) return { variant: 'pending' as const, label: t`Потрібен секрет` }
    if (!connection.lastVerifiedAt)
      return { variant: 'pending' as const, label: t`Очікує перевірки` }
    return { variant: 'status-active' as const, label: t`Підключено` }
  }

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          <Trans>
            Підключення приймають події Meeting Recorder та створюють записи для співбесід.
          </Trans>
        </p>
        <Button size="sm" className="w-full shrink-0 sm:w-auto" onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          <Trans>Додати підключення</Trans>
        </Button>
      </div>

      {connectionsQuery.isLoading ? (
        <div className="space-y-3">
          {[0, 1].map((item) => (
            <Card key={item}>
              <CardHeader className="space-y-2 p-4 pb-2">
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-4 w-24" />
              </CardHeader>
              <CardContent className="space-y-3 p-4 pt-1">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-4 w-2/3" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : connectionsQuery.isError ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <span>
              <Trans>Не вдалося завантажити підключення Meeting Recorder.</Trans>
            </span>
            <Button size="sm" variant="outline" onClick={() => void connectionsQuery.refetch()}>
              <Trans>Повторити</Trans>
            </Button>
          </AlertDescription>
        </Alert>
      ) : !connectionsQuery.data?.length ? (
        <div className="flex flex-col items-start gap-3 rounded-md border border-dashed border-border px-4 py-8">
          <p className="text-sm text-muted-foreground">
            <Trans>Підключень Meeting Recorder поки немає</Trans>
          </p>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            <Trans>Додати підключення</Trans>
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {connectionsQuery.data.map((connection) => {
            const status = connectionStatus(connection)
            const webhookUrl = new URL(connection.webhookPath, window.location.origin).toString()
            const cardPending =
              (enableMutation.isPending && enableMutation.variables?.id === connection.id) ||
              (resetMutation.isPending && resetMutation.variables === connection.id)

            return (
              <Card key={connection.id} className="border-border">
                <CardHeader className="p-4 pb-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <CardTitle className="break-words text-base">{connection.name}</CardTitle>
                      <Badge variant={status.variant}>{status.label}</Badge>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 shrink-0"
                          disabled={cardPending}
                          aria-label={t`Дії з підключенням`}
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => setRenameConnection(connection)}>
                          <Trans>Перейменувати</Trans>
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() =>
                            enableMutation.mutate({
                              id: connection.id,
                              enabled: !connection.enabled,
                            })
                          }
                        >
                          {connection.enabled ? t`Вимкнути` : t`Увімкнути`}
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => setSecretConnection(connection)}>
                          {connection.secretSet ? t`Замінити секрет` : t`Налаштувати секрет`}
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => setResetConnection(connection)}>
                          <Trans>Скинути прив'язку</Trans>
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </CardHeader>

                <CardContent className="space-y-4 p-4 pt-2">
                  <div className="space-y-1.5">
                    <p className="text-xs text-muted-foreground">
                      <Trans>Webhook URL</Trans>
                    </p>
                    <div className="flex items-center gap-2 rounded-md border border-border bg-muted/20 px-3 py-2">
                      <code className="min-w-0 flex-1 break-all font-mono text-xs">
                        {webhookUrl}
                      </code>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 shrink-0"
                        aria-label={t`Скопіювати Webhook URL`}
                        onClick={() => {
                          void navigator.clipboard
                            .writeText(webhookUrl)
                            .then(() => toast.success(t`Webhook URL скопійовано`))
                            .catch(() => toast.error(t`Не вдалося скопіювати Webhook URL`))
                        }}
                      >
                        <Copy className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>

                  <div className="grid gap-3 text-xs sm:grid-cols-2">
                    <div>
                      <p className="text-muted-foreground">
                        <Trans>Секрет</Trans>
                      </p>
                      <p className="mt-0.5">
                        {connection.secretSet ? t`Секрет налаштовано` : t`Секрет не налаштовано`}
                      </p>
                      {connection.signingSecretUpdatedAt && (
                        <p className="mt-0.5 text-muted-foreground">
                          <Trans>Оновлено: {formatDate(connection.signingSecretUpdatedAt)}</Trans>
                        </p>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <p className="text-muted-foreground">
                          <Trans>Остання перевірка</Trans>
                        </p>
                        <p className="mt-0.5">{formatDate(connection.lastVerifiedAt)}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">
                          <Trans>Остання подія</Trans>
                        </p>
                        <p className="mt-0.5">{formatDate(connection.lastEventAt)}</p>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      <CreateConnectionDialog open={createOpen} onOpenChange={setCreateOpen} />
      <RenameConnectionDialog connection={renameConnection} onOpenChange={setRenameConnection} />
      <SecretConnectionDialog connection={secretConnection} onOpenChange={setSecretConnection} />

      <AlertDialog
        open={resetConnection !== null}
        onOpenChange={(open) => !open && setResetConnection(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Скинути прив'язку?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>
                Закріплену ідентичність рекордера буде очищено. Перед підключенням нового джерела
                потрібно буде налаштувати новий signing secret.
              </Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant="outline"
              data-testid="cancel-button"
              onClick={() => setResetConnection(null)}
            >
              <Trans>Скасувати</Trans>
            </Button>
            <Button
              variant="destructive"
              disabled={resetMutation.isPending}
              onClick={() => resetConnection && resetMutation.mutate(resetConnection.id)}
            >
              {resetMutation.isPending ? t`Скидання…` : t`Скинути прив'язку`}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function CreateConnectionDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useLingui()
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [secret, setSecret] = useState('')
  const [nameError, setNameError] = useState<string | null>(null)
  const [secretError, setSecretError] = useState<string | null>(null)

  function closeDialog() {
    setName('')
    setSecret('')
    setNameError(null)
    setSecretError(null)
    onOpenChange(false)
  }

  const createMutation = useMutation({
    mutationFn: async ({
      connectionName,
      signingSecret,
    }: {
      connectionName: string
      signingSecret: string
    }) => {
      const created = await meetingRecorderApi.createConnection({ name: connectionName })
      try {
        await meetingRecorderApi.setConnectionSecret(created.id, { secret: signingSecret })
        return { secretSaved: true }
      } catch {
        return { secretSaved: false }
      }
    },
    onSuccess: async ({ secretSaved }) => {
      await queryClient.invalidateQueries({ queryKey: MEETING_RECORDER_CONNECTIONS_QUERY_KEY })
      closeDialog()
      if (secretSaved) toast.success(t`Підключення створено`)
      else toast.error(t`Підключення створено, але секрет не вдалося зберегти`)
    },
    onError: () => toast.error(t`Не вдалося створити підключення`),
    onSettled: () => setSecret(''),
  })

  function submit() {
    const parsedName = createMeetingRecorderConnectionSchema.safeParse({ name })
    const parsedSecret = meetingRecorderSigningSecretSchema.safeParse(secret)
    setNameError(parsedName.success ? null : t`Введіть назву підключення`)
    setSecretError(
      parsedSecret.success ? null : t`Секрет має починатися з whsec_ і містити 24–64 байти Base64`,
    )
    if (!parsedName.success || !parsedSecret.success) return
    createMutation.mutate({
      connectionName: parsedName.data.name,
      signingSecret: parsedSecret.data,
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !createMutation.isPending) {
          closeDialog()
        } else if (nextOpen) {
          onOpenChange(true)
        }
      }}
    >
      <CrmDialogContent>
        <CrmDialogHeader>
          <DialogTitle>
            <Trans>Додати підключення</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>Створіть підключення та одразу задайте write-only signing secret.</Trans>
          </DialogDescription>
        </CrmDialogHeader>
        <CrmDialogBody className="space-y-4 pb-4">
          <div className="space-y-1.5">
            <Label htmlFor="meeting-recorder-name">
              <Trans>Назва</Trans>
            </Label>
            <Input
              id="meeting-recorder-name"
              value={name}
              onChange={(event) => {
                setName(event.target.value)
                setNameError(null)
              }}
              aria-invalid={!!nameError}
              aria-describedby={nameError ? 'meeting-recorder-name-error' : undefined}
            />
            {nameError && (
              <p id="meeting-recorder-name-error" className="text-xs text-destructive">
                {nameError}
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="meeting-recorder-secret">
              <Trans>Signing secret</Trans>
            </Label>
            <Input
              id="meeting-recorder-secret"
              type="password"
              autoComplete="new-password"
              value={secret}
              onChange={(event) => {
                setSecret(event.target.value)
                setSecretError(null)
              }}
              aria-invalid={!!secretError}
              aria-describedby={secretError ? 'meeting-recorder-secret-error' : undefined}
            />
            {secretError && (
              <p id="meeting-recorder-secret-error" className="text-xs text-destructive">
                {secretError}
              </p>
            )}
          </div>
        </CrmDialogBody>
        <CrmDialogFooter>
          <Button
            variant="outline"
            data-testid="cancel-button"
            onClick={closeDialog}
            disabled={createMutation.isPending}
          >
            <Trans>Скасувати</Trans>
          </Button>
          <Button onClick={submit} disabled={createMutation.isPending}>
            {createMutation.isPending ? t`Створення…` : t`Створити`}
          </Button>
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}

function RenameConnectionDialog({
  connection,
  onOpenChange,
}: {
  connection: MeetingRecorderConnectionDto | null
  onOpenChange: (connection: MeetingRecorderConnectionDto | null) => void
}) {
  const { t } = useLingui()
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setName(connection?.name ?? '')
    setError(null)
  }, [connection])

  const renameMutation = useMutation({
    mutationFn: ({ id, nextName }: { id: string; nextName: string }) =>
      meetingRecorderApi.updateConnection(id, { name: nextName }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: MEETING_RECORDER_CONNECTIONS_QUERY_KEY })
      onOpenChange(null)
      toast.success(t`Підключення перейменовано`)
    },
    onError: () => toast.error(t`Не вдалося перейменувати підключення`),
  })

  return (
    <Dialog
      open={connection !== null}
      onOpenChange={(open) => {
        if (!open && !renameMutation.isPending) {
          setName('')
          setError(null)
          onOpenChange(null)
        }
      }}
    >
      <CrmDialogContent>
        <CrmDialogHeader>
          <DialogTitle>
            <Trans>Перейменувати підключення</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>Назва використовується лише для розрізнення підключень у CRM.</Trans>
          </DialogDescription>
        </CrmDialogHeader>
        <CrmDialogBody className="space-y-1.5 pb-4">
          <Label htmlFor="meeting-recorder-rename">
            <Trans>Назва</Trans>
          </Label>
          <Input
            id="meeting-recorder-rename"
            value={name}
            onChange={(event) => {
              setName(event.target.value)
              setError(null)
            }}
            aria-invalid={!!error}
            aria-describedby={error ? 'meeting-recorder-rename-error' : undefined}
          />
          {error && (
            <p id="meeting-recorder-rename-error" className="text-xs text-destructive">
              {error}
            </p>
          )}
        </CrmDialogBody>
        <CrmDialogFooter>
          <Button
            variant="outline"
            data-testid="cancel-button"
            onClick={() => onOpenChange(null)}
            disabled={renameMutation.isPending}
          >
            <Trans>Скасувати</Trans>
          </Button>
          <Button
            disabled={renameMutation.isPending || !connection}
            onClick={() => {
              if (!connection) return
              const parsed = createMeetingRecorderConnectionSchema.safeParse({ name })
              if (!parsed.success) {
                setError(t`Введіть назву підключення`)
                return
              }
              renameMutation.mutate({ id: connection.id, nextName: parsed.data.name })
            }}
          >
            {renameMutation.isPending ? t`Збереження…` : t`Зберегти`}
          </Button>
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}

function SecretConnectionDialog({
  connection,
  onOpenChange,
}: {
  connection: MeetingRecorderConnectionDto | null
  onOpenChange: (connection: MeetingRecorderConnectionDto | null) => void
}) {
  const { t } = useLingui()
  const queryClient = useQueryClient()
  const [secret, setSecret] = useState('')
  const [error, setError] = useState<string | null>(null)

  function closeDialog() {
    setSecret('')
    setError(null)
    onOpenChange(null)
  }

  const secretMutation = useMutation({
    mutationFn: ({ id, nextSecret }: { id: string; nextSecret: string }) =>
      meetingRecorderApi.setConnectionSecret(id, { secret: nextSecret }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: MEETING_RECORDER_CONNECTIONS_QUERY_KEY })
      onOpenChange(null)
      toast.success(t`Signing secret оновлено`)
    },
    onError: () => toast.error(t`Не вдалося оновити signing secret`),
    onSettled: () => setSecret(''),
  })

  return (
    <Dialog
      open={connection !== null}
      onOpenChange={(open) => {
        if (!open && !secretMutation.isPending) {
          closeDialog()
        }
      }}
    >
      <CrmDialogContent>
        <CrmDialogHeader>
          <DialogTitle>
            {connection?.secretSet ? t`Замінити signing secret` : t`Налаштувати signing secret`}
          </DialogTitle>
          <DialogDescription>
            <Trans>Після збереження значення секрету більше не відображається в CRM.</Trans>
          </DialogDescription>
        </CrmDialogHeader>
        <CrmDialogBody className="space-y-1.5 pb-4">
          <Label htmlFor="meeting-recorder-replace-secret">
            <Trans>Новий signing secret</Trans>
          </Label>
          <Input
            id="meeting-recorder-replace-secret"
            type="password"
            autoComplete="new-password"
            value={secret}
            onChange={(event) => {
              setSecret(event.target.value)
              setError(null)
            }}
            aria-invalid={!!error}
            aria-describedby={error ? 'meeting-recorder-replace-secret-error' : undefined}
          />
          {error && (
            <p id="meeting-recorder-replace-secret-error" className="text-xs text-destructive">
              {error}
            </p>
          )}
        </CrmDialogBody>
        <CrmDialogFooter>
          <Button
            variant="outline"
            data-testid="cancel-button"
            onClick={closeDialog}
            disabled={secretMutation.isPending}
          >
            <Trans>Скасувати</Trans>
          </Button>
          <Button
            disabled={secretMutation.isPending || !connection}
            onClick={() => {
              if (!connection) return
              const parsed = meetingRecorderSigningSecretSchema.safeParse(secret)
              if (!parsed.success) {
                setError(t`Секрет має починатися з whsec_ і містити 24–64 байти Base64`)
                return
              }
              secretMutation.mutate({ id: connection.id, nextSecret: parsed.data })
            }}
          >
            {secretMutation.isPending ? t`Збереження…` : t`Зберегти`}
          </Button>
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}
