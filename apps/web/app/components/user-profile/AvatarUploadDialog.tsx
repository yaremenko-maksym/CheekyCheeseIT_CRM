import { useRef, useState } from 'react'
import { ImagePlus, Link2, Trash2, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useUpdateMe } from '@/hooks/use-user-profile'
import { cn } from '@/lib/utils'

const MAX_FILE_BYTES = 500 * 1024 // 500 KB — base64 inflates ~33%, end-result ≤ ~665 KB
const ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'])

export interface AvatarUploadDialogProps {
  open: boolean
  onClose: () => void
  /** Currently displayed avatar (override preferred, else Google avatar). Used as initial preview. */
  currentAvatarUrl?: string | null
  /** Whether the user has a custom override they could clear back to Google avatar. */
  hasOverride: boolean
}

export function AvatarUploadDialog({
  open,
  onClose,
  currentAvatarUrl,
  hasOverride,
}: AvatarUploadDialogProps) {
  const [tab, setTab] = useState<'file' | 'url'>('file')
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)

  const fileRef = useRef<HTMLInputElement>(null)
  const updateMe = useUpdateMe()

  function reset() {
    setTab('file')
    setDataUrl(null)
    setUrl('')
    setError(null)
    setDragOver(false)
  }

  function handleClose() {
    reset()
    onClose()
  }

  function handleFile(file: File) {
    if (!ALLOWED_MIME_TYPES.has(file.type)) {
      setError('Разрешены только PNG, JPEG, GIF, WebP')
      return
    }
    if (file.size > MAX_FILE_BYTES) {
      setError(`Файл ${(file.size / 1024).toFixed(0)} KB — максимум 500 KB`)
      return
    }
    const fr = new FileReader()
    fr.onload = () => {
      setDataUrl(fr.result as string)
      setError(null)
    }
    fr.onerror = () => setError('Не удалось прочитать файл')
    fr.readAsDataURL(file)
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }

  function handleDragOver(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    e.stopPropagation()
    if (!dragOver) setDragOver(true)
  }

  function handleDragLeave(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
  }

  function handleSave() {
    const value = tab === 'file' ? dataUrl : url.trim()
    if (!value) {
      setError('Сначала выберите изображение')
      return
    }
    if (tab === 'url') {
      try {
        const u = new URL(value)
        // Backend allowlist only accepts https — reject http/javascript/etc here
        // so the user gets a clean error instead of a 400 from the server.
        if (u.protocol !== 'https:') {
          setError('Ссылка должна быть https://')
          return
        }
      } catch {
        setError('Некорректный URL')
        return
      }
    }
    updateMe.mutate(
      { avatarOverride: value },
      {
        onSuccess: () => handleClose(),
        onError: () => setError('Не удалось сохранить аватар'),
      },
    )
  }

  function handleClear() {
    updateMe.mutate(
      { avatarOverride: null },
      {
        onSuccess: () => handleClose(),
        onError: () => setError('Не удалось очистить аватар'),
      },
    )
  }

  const previewSrc = tab === 'file' ? dataUrl : url || null

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) handleClose() }}>
      <DialogContent
        className="max-w-md"
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        {dragOver && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-primary/10 text-sm font-medium text-primary">
            Отпустите изображение
          </div>
        )}
        <DialogHeader>
          <DialogTitle>Аватар профиля</DialogTitle>
          <DialogDescription>
            Загрузите файл (PNG, JPEG, GIF, WebP, до 500 KB) или укажите прямую https-ссылку на изображение.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => { setTab(v as 'file' | 'url'); setError(null) }}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="file" className="gap-1.5">
              <Upload className="h-3.5 w-3.5" />
              Файл
            </TabsTrigger>
            <TabsTrigger value="url" className="gap-1.5">
              <Link2 className="h-3.5 w-3.5" />
              Ссылка
            </TabsTrigger>
          </TabsList>

          <TabsContent value="file" className="space-y-3 pt-3">
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) handleFile(file)
                e.target.value = ''
              }}
            />
            <Button
              type="button"
              variant="outline"
              className="w-full gap-2"
              onClick={() => fileRef.current?.click()}
            >
              <ImagePlus className="h-4 w-4" />
              Выбрать изображение
            </Button>
            <p className="text-xs text-muted-foreground">
              Перетащите файл в окно или нажмите кнопку выше.
            </p>
          </TabsContent>

          <TabsContent value="url" className="space-y-3 pt-3">
            <Input
              type="url"
              placeholder="https://example.com/avatar.png"
              value={url}
              onChange={(e) => { setUrl(e.target.value); setError(null) }}
            />
          </TabsContent>
        </Tabs>

        {previewSrc && (
          <div className="flex justify-center rounded-md border bg-muted/30 p-3">
            <img
              src={previewSrc}
              alt="Предпросмотр"
              className="max-h-48 w-auto rounded-full object-cover"
              onError={() => setError('Не удалось загрузить изображение')}
            />
          </div>
        )}

        {!previewSrc && currentAvatarUrl && (
          <div className="flex justify-center rounded-md border bg-muted/20 p-3">
            <img
              src={currentAvatarUrl}
              alt="Текущий аватар"
              className="max-h-32 w-auto rounded-full object-cover opacity-70"
            />
          </div>
        )}

        {error && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        <DialogFooter className={cn('gap-2 sm:gap-2', hasOverride && 'sm:justify-between')}>
          {hasOverride && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={handleClear}
              disabled={updateMe.isPending}
            >
              <Trash2 className="h-4 w-4" />
              Сбросить к Google
            </Button>
          )}
          <div className="flex gap-2 sm:ml-auto">
            <Button
              type="button"
              variant="outline"
              onClick={handleClose}
              disabled={updateMe.isPending}
            >
              Отмена
            </Button>
            <Button
              type="button"
              onClick={handleSave}
              disabled={updateMe.isPending || (tab === 'file' ? !dataUrl : !url.trim())}
            >
              {updateMe.isPending ? 'Сохранение…' : 'Сохранить'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
