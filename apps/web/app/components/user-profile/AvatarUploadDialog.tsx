/**
 * AvatarUploadDialog — picks a source image (file / URL), crops to a circle,
 * uploads the result as an AVATAR-category document, and patches the user
 * profile to point at that document. Reverting (clearing back to the Google
 * fallback) sends a null update — old document rows are NOT auto-deleted;
 * ADMIN cleanup of orphans is handled out-of-band through /documents.
 *
 * Compared to the pre-PHASE 6 flow this dialog no longer stores the avatar
 * as a base64 blob on users.avatar_override. Instead the cropped JPEG is
 * POSTed through useUploadDocument({ category: 'AVATAR' }) which streams
 * the bytes into S3/MinIO, and the returned document id is persisted on
 * users.avatar_document_id.
 */
import { useCallback, useRef, useState } from 'react'
import Cropper, { type Area } from 'react-easy-crop'
import { ArrowLeft, ImagePlus, Link2, Trash2, Upload, ZoomIn, ZoomOut } from 'lucide-react'
import { toast } from 'sonner'
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
import { SegmentedToggle, type SegmentedToggleOption } from '@/components/ui/segmented-toggle'
import { useUpdateMe } from '@/hooks/use-user-profile'
import { useUploadDocument } from '@/hooks/use-documents'
import { cn } from '@/lib/utils'
import { getCroppedDataUrl } from './cropImage'

const MAX_FILE_BYTES = 5 * 1024 * 1024 // 5 MB raw input — the cropper re-encodes
const ALLOWED_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
])

const OUTPUT_SIZE = 512
const MIN_ZOOM = 1
const MAX_ZOOM = 5

export interface AvatarUploadDialogProps {
  open: boolean
  onClose: () => void
  userId: string
  avatarDocumentId: string | null
  avatarUrl?: string | null | undefined
}

type Step = 'source' | 'crop'

function dataUrlToFile(dataUrl: string, filename: string): File {
  const match = /^data:([^;]+);base64,(.*)$/.exec(dataUrl)
  if (!match) throw new Error('Invalid data URL')
  const mime = match[1] ?? 'application/octet-stream'
  const b64 = match[2] ?? ''
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new File([bytes], filename, { type: mime })
}

export function AvatarUploadDialog({
  open,
  onClose,
  userId,
  avatarDocumentId,
  avatarUrl,
}: AvatarUploadDialogProps) {
  const [step, setStep] = useState<Step>('source')
  const [tab, setTab] = useState<'file' | 'url'>('file')
  const [sourceImage, setSourceImage] = useState<string | null>(null)
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)

  const [crop, setCrop] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null)
  const [saving, setSaving] = useState(false)

  const fileRef = useRef<HTMLInputElement>(null)
  const updateMe = useUpdateMe()
  const uploadDoc = useUploadDocument()

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
      setError(`Файл ${(file.size / 1024).toFixed(0)} KB — максимум 5 MB`)
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
      const file = dataUrlToFile(dataUrl, `avatar-${Date.now()}.jpg`)
      const doc = await uploadDoc.mutateAsync({
        file,
        category: 'AVATAR',
        ownerId: userId,
      })
      updateMe.mutate(
        { avatarDocumentId: doc.id },
        {
          onSuccess: () => {
            toast.success('Аватар обновлён')
            handleClose()
          },
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
      { avatarDocumentId: null },
      {
        onSuccess: () => {
          toast.success('Аватар сброшен на стандартный')
          handleClose()
        },
        onError: () => setError('Не удалось очистить аватар'),
      },
    )
  }

  const isCropStep = step === 'crop'
  const isPending = updateMe.isPending || uploadDoc.isPending || saving
  const hasOverride = avatarDocumentId !== null

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) handleClose()
      }}
    >
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
              : 'Загрузите файл (PNG, JPEG, GIF, WebP, до 5 МБ) или укажите прямую https-ссылку.'}
          </DialogDescription>
        </DialogHeader>

        {!isCropStep &&
          (() => {
            type SourceTab = 'file' | 'url'
            const sourceTabs: ReadonlyArray<SegmentedToggleOption<SourceTab>> = [
              { value: 'file', label: 'Файл', icon: Upload },
              { value: 'url', label: 'Ссылка', icon: Link2 },
            ]
            return (
              <>
                <SegmentedToggle<SourceTab>
                  value={tab}
                  onChange={(v) => {
                    setTab(v)
                    setError(null)
                  }}
                  options={sourceTabs}
                  ariaLabel="Источник изображения"
                  variant="tabs"
                  size="sm"
                  layoutId="avatar-source-tabs"
                  testId="avatar-source-tabs"
                />

                {tab === 'file' && (
                  <div className="space-y-3 pt-3">
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
                  </div>
                )}

                {tab === 'url' && (
                  <div className="space-y-3 pt-3">
                    <Input
                      type="url"
                      placeholder="https://example.com/avatar.png"
                      value={url}
                      onChange={(e) => {
                        setUrl(e.target.value)
                        setError(null)
                      }}
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
                  </div>
                )}

                {avatarUrl && !hasOverride && (
                  <div className="flex justify-center rounded-md border bg-muted/20 p-3">
                    <img
                      src={avatarUrl}
                      alt="Текущий аватар"
                      className="max-h-32 w-auto rounded-full object-cover opacity-70"
                    />
                  </div>
                )}
              </>
            )
          })()}

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

        <DialogFooter
          className={cn('gap-2 sm:gap-2', hasOverride && !isCropStep && 'sm:justify-between')}
        >
          {!isCropStep && hasOverride && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={handleClear}
              disabled={isPending}
            >
              <Trash2 className="h-4 w-4" />
              Сбросить к стандартному
            </Button>
          )}
          <div className="flex gap-2 sm:ml-auto">
            {isCropStep ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setStep('source')
                    setSourceImage(null)
                  }}
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
              <Button type="button" variant="outline" onClick={handleClose} disabled={isPending}>
                Отмена
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
