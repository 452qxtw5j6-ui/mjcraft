/**
 * ImagePreviewOverlay - In-app image preview for the link interceptor and markdown blocks.
 *
 * Loads image data URLs (from READ_FILE_DATA_URL IPC) and displays images with fit-to-container sizing.
 * Supports optional multiple items with arrow/dropdown navigation in the header.
 *
 * File path badge provides "Open" and "Reveal in {file manager}" via PlatformContext.
 */

import * as React from 'react'
import { useState, useEffect, useMemo } from 'react'
import { Image } from 'lucide-react'
import { PreviewOverlay } from './PreviewOverlay'
import { CopyButton } from './CopyButton'
import { ItemNavigator } from './ItemNavigator'

interface PreviewItem {
  src: string
  label?: string
}

export interface ImagePreviewOverlayProps {
  isOpen: boolean
  onClose: () => void
  /** Absolute file path for the image (single item / backward compatibility) */
  filePath: string
  /** Optional multiple items for arrow navigation */
  items?: PreviewItem[]
  /** Initial active item index (defaults to 0) */
  initialIndex?: number
  /** Optional overlay title (used by markdown block previews) */
  title?: string
  /** Async loader that returns a data URL (data:{mime};base64,...) */
  loadDataUrl: (path: string) => Promise<string>
  theme?: 'light' | 'dark'
}

export function ImagePreviewOverlay({
  isOpen,
  onClose,
  filePath,
  items,
  initialIndex = 0,
  title,
  loadDataUrl,
  theme = 'light',
}: ImagePreviewOverlayProps) {
  const resolvedItems = useMemo<PreviewItem[]>(() => {
    if (items && items.length > 0) return items
    return [{ src: filePath }]
  }, [items, filePath])

  const [activeIdx, setActiveIdx] = useState(initialIndex)

  // Content cache: src path → data URL
  const [contentCache, setContentCache] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  const activeItem = resolvedItems[activeIdx]
  const activeDataUrl = activeItem ? contentCache[activeItem.src] : null

  // Reset active item when overlay opens
  useEffect(() => {
    if (isOpen) {
      const bounded = Math.max(0, Math.min(initialIndex, resolvedItems.length - 1))
      setActiveIdx(bounded)
    }
  }, [isOpen, initialIndex, resolvedItems.length])

  // Load active item's image data URL when needed
  useEffect(() => {
    if (!isOpen || !activeItem?.src) return
    if (contentCache[activeItem.src]) {
      setError(null)
      return
    }

    let cancelled = false
    setIsLoading(true)
    setError(null)

    loadDataUrl(activeItem.src)
      .then((url) => {
        if (!cancelled) {
          setContentCache((prev) => ({ ...prev, [activeItem.src]: url }))
          setIsLoading(false)
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load image')
          setIsLoading(false)
        }
      })

    return () => { cancelled = true }
  }, [isOpen, activeItem?.src, loadDataUrl, contentCache])

  // Header actions: item navigation + copy path button
  const headerActions = (
    <div className="flex items-center gap-2">
      <ItemNavigator items={resolvedItems} activeIndex={activeIdx} onSelect={setActiveIdx} size="md" />
      <CopyButton content={activeItem?.src || filePath} title="Copy path" className="bg-background shadow-minimal" />
    </div>
  )

  return (
    <PreviewOverlay
      isOpen={isOpen}
      onClose={onClose}
      theme={theme}
      typeBadge={{
        icon: Image,
        label: 'Image',
        variant: 'purple',
      }}
      filePath={activeItem?.src || filePath}
      title={title}
      error={error ? { label: 'Load Failed', message: error } : undefined}
      headerActions={headerActions}
    >
      <div className="min-h-full flex items-center justify-center p-4">
        {!activeDataUrl && isLoading && (
          <div className="text-muted-foreground text-sm">Loading image...</div>
        )}
        {activeDataUrl && (
          <img
            src={activeDataUrl}
            alt={activeItem?.label || activeItem?.src.split('/').pop() || 'Image preview'}
            className="max-w-full max-h-full object-contain rounded-sm"
            draggable={false}
          />
        )}
      </div>
    </PreviewOverlay>
  )
}
