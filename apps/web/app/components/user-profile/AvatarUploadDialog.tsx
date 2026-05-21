import { useCallback, useRef, useState } from 'react'
import Cropper, { type Area } from 'react-easy-crop'
import { ArrowLeft, ImagePlus, Link2, Trash2, Upload, ZoomIn, ZoomOut } from 'lucide-react'
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
import { getCroppedDataUrl } from './cropImage'

const MAX_FILE_BYTES = 500 * 1024 // 500 KB — base64 inflates ~33%, end-result ≤ ~665 KB
const ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'])

/** Final output edge length — 512×512 JPEG. Renders crisp at all CRM avatar sizes (h-32 max). */
const OUTPUT_SIZE = 512
const MIN_ZOOM = 1
const MAX_ZOOM = 5

export interface AvatarUploadDialogProps {
  open: boolean
  onClose: () => void
  /** Currently displayed avatar (override preferred, else Google avatar). Used as initial preview. */
  currentAvatarUrl?: string | null
  /** Whether the user has a custom override they could clear back to Google avatar. */
  hasOverride: boolean
}

type Step = 'source' | 'crop'

export function AvatarUploadDialog({
  open,
  onClose,
  currentAvatarUrl,
  hasOverride,
}: AvatarUploadDialogProps) {
  const [step, setStep] = useState<Step>('source')
  const [tab, setTab] = useState<'file' | 'url'>('file')
  /** Source image as data URL (file upload) or remote URL (URL tab). */
  const [sourceImage, setSourceImage] = useState<string | null>(null)
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)

  // Cropper state
  const [crop, setCrop] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null)
  const [saving, setSaving] = useState(false)

  const fileRef = useRef<HTMLInputElement>(null)
  const updateMe = useUpdateMe()

  function reset() {
    setStep('source')
    setTab('file')
    setSourceImage(null)
    setUrl('')
    setError(null)
    setDragOver(false)
    setCrop({ x: 0, y: 0 })
    setZoom(1)
    setCroppedAreaPixels(null)
    setSaving(false)
  }

  function handleClose() {
    reset()
    onClose()
  }

  function startCrop(imageSrc: string) {
    setSourceImage(imageSrc)
    setCrop({ x: 0, y: 0 })
    setZoom(1)
    setCroppedAreaPixels(null)
    setStep('crop')
    setError(null)
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
      startCrop(fr.result as string)
    }
    fr.onerror = () => setError('Не удалось прочитать файл')
    fr.readAsDataURL(file)
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    if (step !== 'source') return
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }

  function handleDragOver(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    e.stopPropagation()
    if (step !== 'source') return
    if (!dragOver) setDragOver(true)
  }

  function handleDragLeave(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
  }

  function handleUrlContinue() {
    const trimmed = url.trim()
    if (!trimmed) {
      setError('Введите ссылку на изображение')
      return
    }
    try {
      const u = new URL(trimmed)
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
    startCrop(trimmed)
  }

  const onCropComplete = useCallback((_: Area, areaPixels: Area) => {
    setCroppedAreaPixels(areaPixels)
  }, [])

  async function handleSaveCrop() {
    if (!sourceImage || !croppedAreaPixels) {
      setError('Сначала выберите область')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const dataUrl = await getCroppedDataUrl(sourceImage, croppedAreaPixels, OUTPUT_SIZE, 0.9)
      updateMe.mutate(
        { avatarOverride: dataUrl },
        {
          onSuccess: () => handleClose(),
          onError: () => {
            setSaving(false)
            setError('Не удалось сохранить аватар')
          },
        },
      )
    } catch (err) {
      setSaving(false)
      setError(err instanceof Error ? err.message : 'Не удалось обрезать изображение')
    }
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

  const isCropStep = step === 'crop'
  const isPending = updateMe.isPending || saving

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) handleClose() }}>
      <DialogContent
        className="max-w-md"
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        {dragOver && !isCropStep && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-primary/10 text-sm font-medium text-primary">
            Отпустите изображение
          </div>
        )}
        <DialogHeader>
          <DialogTitle>{isCropStep ? 'Кадрирование' : 'Аватар профиля'}</DialogTitle>
          <DialogDescription>
            {isCropStep
              ? 'Перетащите изображение и используйте слайдер для масштабирования. Кадр сохраняется кругом 512×512.'
              : 'Загрузите файл (PNG, JPEG, GIF, WebP, до 500 KB) или укажите прямую https-ссылку.'}
          </DialogDescription>
        </DialogHeader>

        {!isCropStep && (
          <>
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
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      handleUrlContinue()
                    }
                  }}
                />
                <Button
                  type="button"
                  className="w-full"
                  onClick={handleUrlContinue}
                  disabled={!url.trim()}
                >
                  Продолжить
                </Button>
              </TabsContent>
            </Tabs>

            {currentAvatarUrl && (
              <div className="flex justify-center rounded-md border bg-muted/20 p-3">
                <img
                  src={currentAvatarUrl}
                  alt="Текущий аватар"
                  className="max-h-32 w-auto rounded-full object-cover opacity-70"
                />
              </div>
            )}
          </>
        )}

        {isCropStep && sourceImage && (
          <div className="space-y-3">
            <div className="relative h-72 w-full overflow-hidden rounded-md border bg-muted/30">
              <Cropper
                image={sourceImage}
                crop={crop}
                zoom={zoom}
                aspect={1}
                cropShape="round"
                showGrid={false}
                minZoom={MIN_ZOOM}
                maxZoom={MAX_ZOOM}
                onCropChange={setCrop}
                onZoomChange={setZoom}
                onCropComplete={onCropComplete}
                onMediaLoaded={() => {
                  // Some browsers fire onCropComplete before onMediaLoaded — reset to ensure
                  // we have valid pixels even if user clicks "Сохранить" instantly.
                  setError(null)
                }}
                restrictPosition
              />
            </div>
            <div className="flex items-center gap-2">
              <ZoomOut className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <input
                type="range"
                min={MIN_ZOOM}
                max={MAX_ZOOM}
                step={0.01}
                value={zoom}
                onChange={(e) => setZoom(Number(e.target.value))}
                aria-label="Масштаб"
                className="h-2 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
              />
              <ZoomIn className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            </div>
          </div>
        )}

        {error && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        <DialogFooter className={cn('gap-2 sm:gap-2', hasOverride && !isCropStep && 'sm:justify-between')}>
          {!isCropStep && hasOverride && (
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
            {isCropStep ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => { setStep('source'); setSourceImage(null) }}
                  disabled={isPending}
                  className="gap-1.5"
                >
                  <ArrowLeft className="h-4 w-4" />
                  Назад
                </Button>
                <Button
                  type="button"
                  onClick={handleSaveCrop}
                  disabled={isPending || !croppedAreaPixels}
                >
                  {isPending ? 'Сохранение…' : 'Сохранить'}
                </Button>
              </>
            ) : (
              <Button
                type="button"
                variant="outline"
                onClick={handleClose}
                disabled={updateMe.isPending}
              >
                Отмена
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
