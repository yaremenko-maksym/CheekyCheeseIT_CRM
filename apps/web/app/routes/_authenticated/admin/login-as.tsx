import { createFileRoute } from '@tanstack/react-router'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { Search, UserCheck } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Trans, useLingui } from '@lingui/react/macro'
import type { UserProfileDto } from '@crm/shared'
import { useAuth } from '@/context/auth'
import { api } from '@/lib/axios'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { UserAvatar } from '@/components/users/UserAvatar'
import { ROLE_VARIANT } from '@/components/users/constants'
import { ROLE_LABEL_MESSAGES } from '@/components/ui/role-select'

export const Route = createFileRoute('/_authenticated/admin/login-as')({
  component: LoginAsPage,
})

async function fetchNonAdminUsers(): Promise<UserProfileDto[]> {
  const res = await api.get<UserProfileDto[]>('/users')
  // Filter out ADMINs and archived users client-side
  // (backend already returns all active users for ADMIN role)
  return res.data.filter((u) => u.role !== 'ADMIN' && !u.archivedAt)
}

function LoginAsPage() {
  const { user: me } = useAuth()

  // RBAC guard — should never render for non-ADMIN (parent route redirects),
  // but defensive null check keeps types clean.
  if (!me || me.role !== 'ADMIN') return null

  return <LoginAsPageContent meId={me.id} />
}

interface ConfirmState {
  user: UserProfileDto
}

function LoginAsPageContent({ meId }: { meId: string }) {
  const queryClient = useQueryClient()
  const [searchQuery, setSearchQuery] = useState('')
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const { t, i18n } = useLingui()

  const { data: users, isLoading } = useQuery({
    queryKey: ['login-as-users'],
    queryFn: fetchNonAdminUsers,
    placeholderData: keepPreviousData,
  })

  const impersonateMutation = useMutation({
    mutationFn: async (userId: string) => {
      await api.post('/auth/impersonate', { userId })
    },
    onSuccess: () => {
      // Hard reload to root — flushes all cached queries so the new session
      // starts fresh as the impersonated user.
      queryClient.clear()
      window.location.href = '/'
    },
    onError: (err: unknown) => {
      const errMessage = err instanceof Error ? err.message : String(err)
      toast.error(t`Не вдалося увійти: ${errMessage}`)
      setConfirm(null)
    },
  })

  const filtered = (users ?? []).filter((u) => {
    if (!searchQuery.trim()) return true
    const q = searchQuery.toLowerCase()
    return (
      u.displayName.toLowerCase().includes(q) ||
      u.email.toLowerCase().includes(q) ||
      (u.telegram ?? '').toLowerCase().includes(q)
    )
  })

  return (
    <>
      <div className="space-y-4" data-testid="login-as-page">
        {/* Toolbar */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.28, delay: 0.05 }}
        >
          <Card>
            <CardContent className="flex items-center gap-3 pt-4 pb-4">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  type="search"
                  enterKeyHint="search"
                  placeholder={t`Пошук за іменем, email, telegram…`}
                  className="pl-8"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  data-testid="login-as-search"
                />
              </div>
              {!isLoading && (
                <p className="shrink-0 text-sm text-muted-foreground">
                  <Trans>
                    {filtered.length} із {users?.length ?? 0}
                  </Trans>
                </p>
              )}
            </CardContent>
          </Card>
        </motion.div>

        {/* User list */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.28, delay: 0.1 }}
        >
          <Card>
            <CardContent className="p-3 space-y-1" data-testid="login-as-list">
              {isLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <div key={i} className="flex items-center gap-3 px-3 py-3 rounded-md">
                      <Skeleton className="h-9 w-9 rounded-full shrink-0" />
                      <div className="flex-1 space-y-1.5">
                        <Skeleton className="h-4 w-36" />
                        <Skeleton className="h-3 w-48" />
                      </div>
                      <Skeleton className="h-5 w-20 rounded-full" />
                      <Skeleton className="h-8 w-24 rounded-md" />
                    </div>
                  ))}
                </div>
              ) : filtered.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 gap-2 text-muted-foreground">
                  <Search className="h-8 w-8 opacity-30" />
                  <p className="text-sm">
                    <Trans>Користувачів не знайдено</Trans>
                  </p>
                </div>
              ) : (
                filtered.map((u) => (
                  <motion.div
                    key={u.id}
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.08, ease: 'easeOut' }}
                    className="flex items-center gap-3 rounded-md px-3 py-2.5 hover:bg-muted/50 transition-colors"
                    data-testid={`login-as-row-${u.id}`}
                  >
                    <UserAvatar
                      avatarDocumentId={u.avatarDocumentId}
                      avatarUrl={u.avatarUrl}
                      displayName={u.displayName}
                      className="h-9 w-9 shrink-0"
                    />

                    {/* Name + email */}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{u.displayName}</p>
                      <p className="text-xs text-muted-foreground truncate">{u.email}</p>
                    </div>

                    {/* Role badge */}
                    <Badge
                      variant={ROLE_VARIANT[u.role] ?? 'secondary'}
                      className="shrink-0 hidden sm:inline-flex"
                    >
                      {ROLE_LABEL_MESSAGES[u.role] ? i18n._(ROLE_LABEL_MESSAGES[u.role]) : u.role}
                    </Badge>

                    {/* Action button */}
                    <Button
                      variant="outline"
                      size="sm"
                      className="shrink-0 min-h-[44px] sm:min-h-0"
                      aria-label={t`Увійти як ${u.displayName}`}
                      data-testid={`login-as-btn-${u.id}`}
                      disabled={u.id === meId}
                      onClick={() => setConfirm({ user: u })}
                    >
                      <UserCheck className="h-3.5 w-3.5 mr-1.5 sm:hidden" aria-hidden />
                      <span className="hidden sm:inline">
                        <Trans>Увійти як</Trans>
                      </span>
                      <span className="sm:hidden">
                        <Trans>Увійти</Trans>
                      </span>
                    </Button>
                  </motion.div>
                ))
              )}
            </CardContent>
          </Card>
        </motion.div>
      </div>

      {/* Confirm dialog */}
      <Dialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open && !impersonateMutation.isPending) setConfirm(null)
        }}
      >
        <DialogContent
          className="sm:max-w-sm"
          data-testid="login-as-confirm-dialog"
          onInteractOutside={(e) => {
            if (impersonateMutation.isPending) e.preventDefault()
          }}
        >
          <DialogHeader>
            <DialogTitle>
              <Trans>Увійти як «{confirm?.user.displayName}»?</Trans>
            </DialogTitle>
            <DialogDescription>
              {/* COPY-M-core-12: references the impersonation banner's own
                  return-button label verbatim (ImpersonationBanner.tsx —
                  t`Повернутися до свого профілю`), not a generic paraphrase. */}
              <Trans>
                Ви будете діяти від його імені. Банер нагадає про активний сеанс — натисніть
                «Повернутися до свого профілю», щоб вийти.
              </Trans>
            </DialogDescription>
          </DialogHeader>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="ghost"
              disabled={impersonateMutation.isPending}
              data-testid="login-as-confirm-cancel"
              onClick={() => setConfirm(null)}
            >
              <Trans>Скасувати</Trans>
            </Button>
            <Button
              disabled={impersonateMutation.isPending}
              data-testid="login-as-confirm-ok"
              onClick={() => {
                if (confirm) impersonateMutation.mutate(confirm.user.id)
              }}
            >
              {impersonateMutation.isPending ? t`Входимо…` : t`Увійти як`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
