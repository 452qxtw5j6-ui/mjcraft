import { nativeImage } from 'electron'
import { IMAGE_LIMITS } from '@craft-agent/shared/utils'

export interface ImageResizeResult {
  /** Resized image buffer */
  buffer: Buffer
  /** Output dimensions */
  width: number
  height: number
  /** Output format */
  format: 'png' | 'jpeg'
}

/**
 * Resize and/or compress an image buffer to fit within Claude API limits.
 * Uses Electron's nativeImage.
 *
 * Strategy:
 * 1. If dimensions exceed OPTIMAL_EDGE (1568px), resize down
 * 2. Output as PNG (or JPEG if isPhoto)
 * 3. If still over maxSizeBytes, try JPEG at 90 quality
 * 4. If still over, try JPEG at 75 quality
 * 5. If still over, return null (can't fix)
 *
 * @returns Resized image data, or null if image can't be made small enough
 */
export function resizeImageForAPI(
  buffer: Buffer,
  options?: {
    /** Max output size in bytes. Default: IMAGE_LIMITS.MAX_SIZE (5MB) */
    maxSizeBytes?: number
    /** Prefer JPEG output (for photos). Default: false */
    isPhoto?: boolean
  },
): ImageResizeResult | null {
  const maxSize = options?.maxSizeBytes ?? IMAGE_LIMITS.MAX_SIZE
  const isPhoto = options?.isPhoto ?? false

  const image = nativeImage.createFromBuffer(buffer)
  if (image.isEmpty()) return null

  const size = image.getSize()
  const maxEdge = Math.max(size.width, size.height)

  // Step 1: Resize if dimensions are large
  let resized = image
  let outWidth = size.width
  let outHeight = size.height

  if (maxEdge > IMAGE_LIMITS.OPTIMAL_EDGE) {
    const scale = IMAGE_LIMITS.OPTIMAL_EDGE / maxEdge
    outWidth = Math.round(size.width * scale)
    outHeight = Math.round(size.height * scale)
    resized = image.resize({ width: outWidth, height: outHeight, quality: 'best' })
  }

  // Step 2: Encode — try preferred format first
  let output = isPhoto ? resized.toJPEG(IMAGE_LIMITS.JPEG_QUALITY_HIGH) : resized.toPNG()
  let format: 'png' | 'jpeg' = isPhoto ? 'jpeg' : 'png'

  // Step 3-4: Fallback to JPEG compression if still too large
  if (output.length > maxSize) {
    output = resized.toJPEG(IMAGE_LIMITS.JPEG_QUALITY_HIGH)
    format = 'jpeg'
  }
  if (output.length > maxSize) {
    output = resized.toJPEG(IMAGE_LIMITS.JPEG_QUALITY_FALLBACK)
  }

  // Step 5: Give up
  if (output.length > maxSize) return null

  return { buffer: output, width: outWidth, height: outHeight, format }
}
