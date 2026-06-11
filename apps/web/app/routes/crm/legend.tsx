import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { motion } from 'framer-motion'
import { BookOpen, Loader2, Pencil, Plus, Save, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ProjectDto } from '@crm/shared'
import { useAuth } from '@/context/auth'
import { useRoleGuard } from '@/hooks/use-role-guard'
import { useLegend, useUpsertLegend, useAddLegendEntry } from '@/hooks/use-legend'
import { useForm } from '@tanstack/react-form'
import { upsertLegendSchema } from '@crm/shared'
import { api } from '@/lib/axios'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'

export const Route = createFileRoute('/crm/legend')({
  component: LegendPage,
})

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.06 } },
}

const card = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: [0.25, 0.1, 0.25, 1] as const } },
}

function getInitials(name: string | null): string {
  if (!name) return '?'
  const parts = name.trim().split(' ')
  const first = parts[0]?.[0] ?? ''
  const second = parts[1]?.[0] ?? ''
  return (first + second).toUpperCase() || '?'
}

function LegendPage() {
  const { denied } = useRoleGuard(['JUNIOR', 'ADMIN', 'HR'])
  const { user } = useAuth()
  const navigate = useNavigate()

  // Get the active project for the current user
  const { data: projects, isLoading: projectsLoading } = useQuery<ProjectDto[]>({
    queryKey: ['projects'],
    queryFn: () => api.get<ProjectDto[]>('/projects').then((r) => r.data),
    staleTime: 5 * 60_000,
    enabled: !denied,
  })

  const activeProject = projects?.[0] ?? null
  const projectId = activeProject?.id

  // Redirect subjects (senior/drop) away from this page
  useEffect(() => {
    if (!user) return
    if (user.role === 'SENIOR' || user.role === 'DROP') {
      void navigate({ to: '/crm/profile', replace: true })
    }
  }, [user, navigate])

  const { data: legend, isLoading: legendLoading } = useLegend(projectId, !denied && !!projectId)

  if (denied) return null

  const isLoading = projectsLoading || (!!projectId && legendLoading)

  return (
    <div className="space-y-6" data-testid="legend-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Легенда</h1>
        {activeProject && (
          <p className="text-sm text-muted-foreground">
            {activeProject.companyName}
            {activeProject.seniorName ? ` · ${activeProject.seniorName}` : ''}
          </p>
        )}
      </div>

      {isLoading && (
        <div className="space-y-4">
          <Skeleton className="h-40 w-full rounded-lg" />
          <Skeleton className="h-40 w-full rounded-lg" />
          <Skeleton className="h-32 w-full rounded-lg" />
        </div>
      )}

      {!isLoading && !projectId && (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <BookOpen className="h-10 w-10 mb-3 opacity-40" />
          <p className="text-sm">Вас ещё не добавили в проект.</p>
        </div>
      )}

      {!isLoading && projectId && (
        <motion.div className="space-y-4" variants={container} initial="hidden" animate="show">
          {/* Desktop ≥1024px: persona | cover story in 2-column grid (spec §4.2) */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <motion.div variants={card}>
              <LegendPersonaBlock projectId={projectId} legend={legend ?? null} />
            </motion.div>
            <motion.div variants={card}>
              <LegendCoverBlock projectId={projectId} legend={legend ?? null} />
            </motion.div>
          </div>
          {/* Journal — full width below the 2-col grid */}
          <motion.div variants={card}>
            <LegendJournalBlock projectId={projectId} legend={legend ?? null} />
          </motion.div>
        </motion.div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// LegendPersonaBlock — персона: ФИО · ДР · адрес · хобби + edit
// ---------------------------------------------------------------------------

interface LegendBlockProps {
  projectId: string
  legend: Awaited<ReturnType<typeof useLegend>>['data']
}

function LegendPersonaBlock({ projectId, legend }: LegendBlockProps) {
  const [editing, setEditing] = useState(false)
  const upsert = useUpsertLegend(projectId)
  const initials = getInitials(legend?.fullName ?? null)

  const form = useForm({
    defaultValues: {
      fullName: legend?.fullName ?? '',
      dateOfBirth: legend?.dateOfBirth ?? '',
      address: legend?.address ?? '',
      hobbies: legend?.hobbies ?? '',
      // keep cover story fields on upsert
      presentedRole: legend?.presentedRole ?? '',
      presentedStack: legend?.presentedStack ?? '',
      backstory: legend?.backstory ?? '',
      notes: legend?.notes ?? '',
    },
    onSubmit: async ({ value }) => {
      const dto = upsertLegendSchema.parse({
        fullName: value.fullName,
        dateOfBirth: value.dateOfBirth || null,
        address: value.address || null,
        hobbies: value.hobbies || null,
        presentedRole: value.presentedRole || null,
        presentedStack: value.presentedStack || null,
        backstory: value.backstory || null,
        notes: value.notes || null,
      })
      await upsert.mutateAsync(dto)
      setEditing(false)
    },
  })

  const handleEdit = () => {
    form.reset({
      fullName: legend?.fullName ?? '',
      dateOfBirth: legend?.dateOfBirth ?? '',
      address: legend?.address ?? '',
      hobbies: legend?.hobbies ?? '',
      presentedRole: legend?.presentedRole ?? '',
      presentedStack: legend?.presentedStack ?? '',
      backstory: legend?.backstory ?? '',
      notes: legend?.notes ?? '',
    })
    setEditing(true)
  }

  return (
    <Card className="border-border/40 bg-card" data-testid="legend-persona-block">
      <CardHeader className="flex flex-row items-start justify-between pb-3">
        <div className="flex items-center gap-3">
          <Avatar className="h-10 w-10 shrink-0">
            <AvatarFallback className="bg-yellow-subtle text-avatar-text font-semibold text-sm">
              {initials}
            </AvatarFallback>
          </Avatar>
          <CardTitle className="text-sm font-semibold">Персона</CardTitle>
        </div>
        {!editing && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleEdit}
            disabled={upsert.isPending}
            aria-label="Редактировать персону"
            className="h-7 text-xs gap-1.5 text-muted-foreground hover:text-foreground"
          >
            <Pencil className="h-3 w-3" />
            {legend ? 'Редактировать' : 'Создать'}
          </Button>
        )}
        {editing && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              form.reset()
              setEditing(false)
            }}
            className="h-7 text-xs gap-1.5 text-muted-foreground hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
            Отмена
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {!editing ? (
          !legend ? (
            <p className="text-sm text-muted-foreground/60 italic">
              Персона не заполнена. Нажмите «Создать».
            </p>
          ) : (
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
              {legend.fullName && (
                <div>
                  <dt className="text-xs text-muted-foreground mb-0.5">ФИО</dt>
                  <dd className="font-medium">{legend.fullName}</dd>
                </div>
              )}
              {legend.dateOfBirth && (
                <div>
                  <dt className="text-xs text-muted-foreground mb-0.5">Дата рождения</dt>
                  <dd>{legend.dateOfBirth}</dd>
                </div>
              )}
              {legend.address && (
                <div className="sm:col-span-2">
                  <dt className="text-xs text-muted-foreground mb-0.5">Адрес</dt>
                  <dd>{legend.address}</dd>
                </div>
              )}
              {legend.hobbies && (
                <div className="sm:col-span-2">
                  <dt className="text-xs text-muted-foreground mb-0.5">Хобби</dt>
                  <dd>{legend.hobbies}</dd>
                </div>
              )}
            </dl>
          )
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              e.stopPropagation()
              void form.handleSubmit()
            }}
            className="space-y-4"
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <form.Field name="fullName">
                {(field) => (
                  <div className="space-y-1">
                    <Label htmlFor="persona-fullName">ФИО *</Label>
                    <Input
                      id="persona-fullName"
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(e) => field.handleChange(e.target.value)}
                      placeholder="Иванов Иван Иванович"
                    />
                    {field.state.meta.errors.length > 0 && (
                      <p className="text-xs text-destructive">
                        {String(field.state.meta.errors[0])}
                      </p>
                    )}
                  </div>
                )}
              </form.Field>
              <form.Field name="dateOfBirth">
                {(field) => (
                  <div className="space-y-1">
                    <Label htmlFor="persona-dob">Дата рождения</Label>
                    <Input
                      id="persona-dob"
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(e) => field.handleChange(e.target.value)}
                      placeholder="1990-01-15"
                    />
                  </div>
                )}
              </form.Field>
            </div>
            <form.Field name="address">
              {(field) => (
                <div className="space-y-1">
                  <Label htmlFor="persona-address">Адрес</Label>
                  <Input
                    id="persona-address"
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                    placeholder="Киев, ул. Крещатик 1"
                  />
                </div>
              )}
            </form.Field>
            <form.Field name="hobbies">
              {(field) => (
                <div className="space-y-1">
                  <Label htmlFor="persona-hobbies">Хобби</Label>
                  <Input
                    id="persona-hobbies"
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                    placeholder="Чтение, плавание..."
                  />
                </div>
              )}
            </form.Field>
            <div className="flex justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  form.reset()
                  setEditing(false)
                }}
              >
                Отмена
              </Button>
              <Button type="submit" size="sm" disabled={upsert.isPending}>
                {upsert.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-1" />
                ) : (
                  <Save className="h-4 w-4 mr-1" />
                )}
                Сохранить
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// LegendCoverBlock — cover story: роль · стек · бэкграунд + edit
// ---------------------------------------------------------------------------

function LegendCoverBlock({ projectId, legend }: LegendBlockProps) {
  const [editing, setEditing] = useState(false)
  const upsert = useUpsertLegend(projectId)

  const form = useForm({
    defaultValues: {
      presentedRole: legend?.presentedRole ?? '',
      presentedStack: legend?.presentedStack ?? '',
      backstory: legend?.backstory ?? '',
      notes: legend?.notes ?? '',
      // keep persona fields on upsert
      fullName: legend?.fullName ?? '',
      dateOfBirth: legend?.dateOfBirth ?? '',
      address: legend?.address ?? '',
      hobbies: legend?.hobbies ?? '',
    },
    onSubmit: async ({ value }) => {
      const dto = upsertLegendSchema.parse({
        fullName: value.fullName || 'Персона',
        dateOfBirth: value.dateOfBirth || null,
        address: value.address || null,
        hobbies: value.hobbies || null,
        presentedRole: value.presentedRole || null,
        presentedStack: value.presentedStack || null,
        backstory: value.backstory || null,
        notes: value.notes || null,
      })
      await upsert.mutateAsync(dto)
      setEditing(false)
    },
  })

  const handleEdit = () => {
    form.reset({
      presentedRole: legend?.presentedRole ?? '',
      presentedStack: legend?.presentedStack ?? '',
      backstory: legend?.backstory ?? '',
      notes: legend?.notes ?? '',
      fullName: legend?.fullName ?? '',
      dateOfBirth: legend?.dateOfBirth ?? '',
      address: legend?.address ?? '',
      hobbies: legend?.hobbies ?? '',
    })
    setEditing(true)
  }

  return (
    <Card className="border-border/40 bg-card" data-testid="legend-cover-block">
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <CardTitle className="text-sm font-semibold">Кавер-стори</CardTitle>
        {!editing && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleEdit}
            disabled={upsert.isPending}
            aria-label="Редактировать cover story"
            className="h-7 text-xs gap-1.5 text-muted-foreground hover:text-foreground"
          >
            <Pencil className="h-3 w-3" />
            Редактировать
          </Button>
        )}
        {editing && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              form.reset()
              setEditing(false)
            }}
            className="h-7 text-xs gap-1.5 text-muted-foreground hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
            Отмена
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {!editing ? (
          !legend || (!legend.presentedRole && !legend.presentedStack && !legend.backstory) ? (
            <p className="text-sm text-muted-foreground/60 italic">Кавер-стори не заполнена.</p>
          ) : (
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
              {legend.presentedRole && (
                <div>
                  <dt className="text-xs text-muted-foreground mb-0.5">Позиция для клиента</dt>
                  <dd className="font-medium">{legend.presentedRole}</dd>
                </div>
              )}
              {legend.presentedStack && (
                <div>
                  <dt className="text-xs text-muted-foreground mb-0.5">Стек для клиента</dt>
                  <dd>{legend.presentedStack}</dd>
                </div>
              )}
              {legend.backstory && (
                <div className="sm:col-span-2">
                  <dt className="text-xs text-muted-foreground mb-0.5">Бэкстори</dt>
                  <dd className="whitespace-pre-wrap">{legend.backstory}</dd>
                </div>
              )}
            </dl>
          )
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              e.stopPropagation()
              void form.handleSubmit()
            }}
            className="space-y-4"
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <form.Field name="presentedRole">
                {(field) => (
                  <div className="space-y-1">
                    <Label htmlFor="cover-role">Позиция для клиента</Label>
                    <Input
                      id="cover-role"
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(e) => field.handleChange(e.target.value)}
                      placeholder="Senior Frontend Developer"
                    />
                  </div>
                )}
              </form.Field>
              <form.Field name="presentedStack">
                {(field) => (
                  <div className="space-y-1">
                    <Label htmlFor="cover-stack">Стек для клиента</Label>
                    <Input
                      id="cover-stack"
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(e) => field.handleChange(e.target.value)}
                      placeholder="React, TypeScript, Node.js"
                    />
                  </div>
                )}
              </form.Field>
            </div>
            <form.Field name="backstory">
              {(field) => (
                <div className="space-y-1">
                  <Label htmlFor="cover-backstory">Бэкстори</Label>
                  <Textarea
                    id="cover-backstory"
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                    placeholder="Краткая история для клиентской компании..."
                    rows={3}
                  />
                </div>
              )}
            </form.Field>
            <div className="flex justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  form.reset()
                  setEditing(false)
                }}
              >
                Отмена
              </Button>
              <Button type="submit" size="sm" disabled={upsert.isPending}>
                {upsert.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-1" />
                ) : (
                  <Save className="h-4 w-4 mr-1" />
                )}
                Сохранить
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// LegendJournalBlock — append-only журнал + добавление записи
// ---------------------------------------------------------------------------

function LegendJournalBlock({ projectId, legend }: LegendBlockProps) {
  const [showForm, setShowForm] = useState(false)
  const [entryText, setEntryText] = useState('')
  const addEntry = useAddLegendEntry(projectId)
  const charCount = entryText.length
  const MAX_CHARS = 2000

  const handleSubmit = async () => {
    if (!entryText.trim()) return
    await addEntry.mutateAsync({ text: entryText.trim() })
    setEntryText('')
    setShowForm(false)
  }

  const entries = legend?.entries ?? []

  return (
    <Card className="border-border/40 bg-card" data-testid="legend-journal-block">
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <CardTitle className="text-sm font-semibold">Журнал событий</CardTitle>
        {!showForm && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowForm(true)}
            aria-label="Добавить запись в журнал"
            data-testid="legend-entry-add-btn"
            className="h-7 text-xs gap-1.5 text-muted-foreground hover:text-foreground"
          >
            <Plus className="h-3 w-3" />
            Добавить запись
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {entries.length === 0 && !showForm && (
          <p className="text-sm text-muted-foreground/60 italic">
            Записей пока нет.{' '}
            <button
              onClick={() => setShowForm(true)}
              className="underline underline-offset-2 hover:text-foreground transition-colors"
            >
              Добавить первую запись
            </button>
          </p>
        )}

        {entries.length > 0 && (
          <ScrollArea className={entries.length > 5 ? 'max-h-80' : undefined}>
            <ol className="space-y-3">
              {entries.map((entry) => (
                <li key={entry.id} className="text-sm" data-testid="legend-entry-item">
                  <span className="text-muted-foreground text-xs mr-1.5">
                    {new Date(entry.createdAt).toLocaleDateString('ru-RU', {
                      day: '2-digit',
                      month: '2-digit',
                      year: 'numeric',
                    })}
                    {' · '}
                    {entry.authorName}:
                  </span>
                  <span className="whitespace-pre-wrap">{entry.text}</span>
                </li>
              ))}
            </ol>
          </ScrollArea>
        )}

        {showForm && (
          <>
            {entries.length > 0 && <Separator className="opacity-50" />}
            <div className="space-y-2">
              <Textarea
                value={entryText}
                onChange={(e) => setEntryText(e.target.value.slice(0, MAX_CHARS))}
                placeholder="Что произошло? (например: клиент спросил про образование, ответили — МГУ)"
                rows={3}
                data-testid="legend-entry-textarea"
                className="text-sm"
                maxLength={MAX_CHARS}
              />
              <p className="text-xs text-muted-foreground text-right">
                {charCount} / {MAX_CHARS}
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() => void handleSubmit()}
                  disabled={addEntry.isPending || !entryText.trim()}
                  data-testid="legend-entry-submit-btn"
                >
                  {addEntry.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                  ) : (
                    <Save className="h-3.5 w-3.5 mr-1" />
                  )}
                  Сохранить запись
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setShowForm(false)
                    setEntryText('')
                  }}
                  data-testid="legend-entry-cancel-btn"
                >
                  <X className="h-3.5 w-3.5 mr-1" />
                  Отмена
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
