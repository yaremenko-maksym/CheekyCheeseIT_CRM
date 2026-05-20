import type { Area } from 'react-easy-crop'

/**
 * Render the user-selected square crop of `imageSrc` into a canvas at `outputSize` px
 * and return a JPEG data URL.
 *
 * Output is JPEG (not PNG) — keeps base64 well under the 500KB backend cap even for
 * 512px crops of photographic content.
 */
export async function getCroppedDataUrl(
  imageSrc: string,
  pixelCrop: Area,
  outputSize = 512,
  quality = 0.9,
): Promise<string> {
  const image = await loadImage(imageSrc)

  const canvas = document.createElement('canvas')
  canvas.width = outputSize
  canvas.height = outputSize
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Не удалось создать canvas context')

  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'

  ctx.drawImage(
    image,
    pixelCrop.x,
    pixelCrop.y,
    pixelCrop.width,
    pixelCrop.height,
    0,
    0,
    outputSize,
    outputSize,
  )

  return canvas.toDataURL('image/jpeg', quality)
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.addEventListener('load', () => resolve(img))
    img.addEventListener('error', () => reject(new Error('Не удалось загрузить изображение')))
    // crossOrigin needed for canvas.toDataURL on remote URLs — silently dropped for data: URIs.
    img.crossOrigin = 'anonymous'
    img.src = src
  })
}
