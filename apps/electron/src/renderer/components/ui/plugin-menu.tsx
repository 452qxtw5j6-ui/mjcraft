import * as React from 'react'
import { cn } from '@/lib/utils'
import type { LoadedSkill } from '../../../shared/types'
import { AGENTS_PLUGIN_NAME } from '@craft-agent/shared/skills/types'

// ============================================================================
// Types
// ============================================================================

export type PluginMenuMode = 'plugins' | 'entries'

export interface PluginMenuEntry {
  id: string
  kind: 'command' | 'skill'
  label: string
  description?: string
  skillSlug: string
}

export interface PluginMenuPlugin {
  slug: string
  label: string
  commands: PluginMenuEntry[]
  skills: PluginMenuEntry[]
}

export interface PluginMenuItem {
  type: 'plugin' | 'entry'
  id: string
  label: string
  description?: string
  pluginSlug: string
  pluginLabel: string
  entryKind?: 'command' | 'skill'
  skillSlug?: string
}

export interface InlinePluginMenuProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: PluginMenuMode
  activePluginLabel?: string
  items: PluginMenuItem[]
  filter?: string
  position: { x: number; y: number }
  onSelect: (item: PluginMenuItem) => void
  className?: string
}

export interface PluginInputElement {
  getBoundingClientRect: () => DOMRect
  getCaretRect?: () => DOMRect | null
  value: string
  selectionStart: number
}

export interface UseInlinePluginMenuOptions {
  inputRef: React.RefObject<PluginInputElement | null>
  skills: LoadedSkill[]
  workspaceSlug?: string
}

export interface UseInlinePluginMenuReturn {
  isOpen: boolean
  mode: PluginMenuMode
  filter: string
  position: { x: number; y: number }
  items: PluginMenuItem[]
  activePluginLabel?: string
  handleInputChange: (value: string, cursorPosition: number) => void
  close: () => void
  handleSelect: (item: PluginMenuItem) => { value: string; cursorPosition: number; keepMenuOpen: boolean }
}

// ============================================================================
// Shared Styles
// ============================================================================

const MENU_CONTAINER_STYLE = 'overflow-hidden rounded-[8px] bg-background text-foreground shadow-modal-small'
const MENU_LIST_STYLE = 'max-h-[240px] overflow-y-auto py-1'
const MENU_ITEM_STYLE = 'flex cursor-pointer select-none items-center gap-3 rounded-[6px] mx-1 px-2 py-1.5 text-[13px]'
const MENU_ITEM_SELECTED = 'bg-foreground/5'
const MENU_KIND_BADGE = 'rounded-[4px] shadow-[0_0_0_1px_var(--shadow-tinted)] shadow-minimal bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground shrink-0'

function toLabel(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function getMatchScore(text: string, filter: string): number {
  const lowerText = text.toLowerCase()
  if (lowerText.startsWith(filter)) return 3

  const escapedFilter = filter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const wordBoundaryPattern = new RegExp(`[\\s\\-_]${escapedFilter}`)
  if (wordBoundaryPattern.test(lowerText)) return 2

  if (lowerText.includes(filter)) return 1
  return 0
}

function sortByRelevance(a: PluginMenuItem, b: PluginMenuItem, filter: string): number {
  if (!filter) return a.label.localeCompare(b.label)

  const aLabel = getMatchScore(a.label, filter)
  const bLabel = getMatchScore(b.label, filter)
  const aId = getMatchScore(a.id, filter)
  const bId = getMatchScore(b.id, filter)
  const aScore = Math.max(aLabel, aId)
  const bScore = Math.max(bLabel, bId)

  if (aScore !== bScore) return bScore - aScore
  return a.label.localeCompare(b.label)
}

function isValidPluginTrigger(textBeforeCursor: string, percentPosition: number): boolean {
  if (percentPosition < 0) return false
  if (percentPosition === 0) return true

  const charBefore = textBeforeCursor[percentPosition - 1]
  if (charBefore === undefined) return false
  return /\s/.test(charBefore) || /[("']/.test(charBefore)
}

interface ParsedPluginTrigger {
  mode: PluginMenuMode
  filterText: string
  triggerStart: number
  pluginSlug: string | null
}

function parsePluginTrigger(
  textBeforeCursor: string,
  pluginMap: Map<string, PluginMenuPlugin>,
): ParsedPluginTrigger | null {
  const commandMatch = textBeforeCursor.match(/%([\w-]+)\s+([\w-]*)$/)
  if (commandMatch) {
    const pluginSlug = commandMatch[1]
    const percentPos = textBeforeCursor.lastIndexOf('%')
    if (!isValidPluginTrigger(textBeforeCursor, percentPos) || !pluginMap.has(pluginSlug)) return null
    return {
      mode: 'entries',
      filterText: commandMatch[2] || '',
      triggerStart: percentPos,
      pluginSlug,
    }
  }

  const pluginMatch = textBeforeCursor.match(/%([\w-]*)$/)
  if (pluginMatch) {
    const percentPos = textBeforeCursor.lastIndexOf('%')
    if (!isValidPluginTrigger(textBeforeCursor, percentPos) || pluginMap.size === 0) return null
    return {
      mode: 'plugins',
      filterText: pluginMatch[1] || '',
      triggerStart: percentPos,
      pluginSlug: null,
    }
  }

  return null
}

function getInlineMenuPosition(input: PluginInputElement | null): { x: number; y: number } {
  if (!input) return { x: 0, y: 0 }
  const caretRect = input.getCaretRect?.()
  if (caretRect && caretRect.x > 0) return { x: caretRect.x, y: caretRect.y }
  const rect = input.getBoundingClientRect()
  return { x: rect.left, y: rect.top + 20 }
}

// ============================================================================
// Component
// ============================================================================

export function InlinePluginMenu({
  open,
  onOpenChange,
  mode,
  activePluginLabel,
  items,
  filter = '',
  position,
  onSelect,
  className,
}: InlinePluginMenuProps) {
  const menuRef = React.useRef<HTMLDivElement>(null)
  const listRef = React.useRef<HTMLDivElement>(null)
  const [selectedIndex, setSelectedIndex] = React.useState(0)

  React.useEffect(() => {
    setSelectedIndex(0)
  }, [filter, mode, activePluginLabel])

  React.useEffect(() => {
    if (!open || items.length === 0) return

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setSelectedIndex(prev => (prev < items.length - 1 ? prev + 1 : 0))
          break
        case 'ArrowUp':
          e.preventDefault()
          setSelectedIndex(prev => (prev > 0 ? prev - 1 : items.length - 1))
          break
        case 'Enter':
        case 'Tab':
          e.preventDefault()
          if (items[selectedIndex]) {
            onSelect(items[selectedIndex])
          }
          break
        case 'Escape':
          e.preventDefault()
          onOpenChange(false)
          break
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, items, selectedIndex, onSelect, onOpenChange])

  React.useEffect(() => {
    if (!open) return

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onOpenChange(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open, onOpenChange])

  React.useEffect(() => {
    if (!listRef.current) return
    const selectedEl = listRef.current.querySelector('[data-selected="true"]')
    if (selectedEl) {
      selectedEl.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex])

  if (!open) return null

  const bottomPosition = typeof window !== 'undefined'
    ? window.innerHeight - Math.round(position.y) + 8
    : 0

  const title = mode === 'plugins'
    ? 'Plugin'
    : `${activePluginLabel || 'Plugin'}: Commands & Skills`

  return (
    <div
      ref={menuRef}
      data-inline-menu
      className={cn('fixed z-dropdown', MENU_CONTAINER_STYLE, className)}
      style={{
        left: Math.round(position.x) - 10,
        bottom: bottomPosition,
        width: 320,
        maxWidth: 320,
      }}
    >
      <div className="px-3 py-1.5 text-[12px] font-medium text-muted-foreground border-b border-foreground/5">
        {title}
      </div>

      <div ref={listRef} className={MENU_LIST_STYLE}>
        {items.length === 0 ? (
          <div className="px-3 py-2 text-[12px] text-muted-foreground/60">No results</div>
        ) : (
          items.map((item, itemIndex) => {
            const isSelected = itemIndex === selectedIndex
            return (
              <div
                key={`${item.type}-${item.pluginSlug}-${item.id}-${item.skillSlug ?? ''}`}
                data-selected={isSelected}
                onClick={() => onSelect(item)}
                onMouseEnter={() => setSelectedIndex(itemIndex)}
                className={cn(MENU_ITEM_STYLE, isSelected && MENU_ITEM_SELECTED)}
              >
                <div className="flex-1 min-w-0">
                  <div className="truncate">{item.label}</div>
                  {item.description && (
                    <div className="truncate text-[11px] text-muted-foreground/80">{item.description}</div>
                  )}
                </div>
                <span className={MENU_KIND_BADGE}>
                  {item.type === 'plugin'
                    ? 'Plugin'
                    : item.entryKind === 'command'
                      ? 'Command'
                      : 'Skill'}
                </span>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

// ============================================================================
// Hook
// ============================================================================

export function useInlinePluginMenu({
  inputRef,
  skills,
  workspaceSlug,
}: UseInlinePluginMenuOptions): UseInlinePluginMenuReturn {
  const [isOpen, setIsOpen] = React.useState(false)
  const [mode, setMode] = React.useState<PluginMenuMode>('plugins')
  const [filter, setFilter] = React.useState('')
  const [position, setPosition] = React.useState({ x: 0, y: 0 })
  const [triggerStart, setTriggerStart] = React.useState(-1)
  const [activePluginSlug, setActivePluginSlug] = React.useState<string | null>(null)

  const currentInputRef = React.useRef({ value: '', cursorPosition: 0 })

  const skillsBySlug = React.useMemo(() => {
    const map = new Map<string, LoadedSkill>()
    for (const skill of skills) {
      map.set(skill.slug, skill)
    }
    return map
  }, [skills])

  const pluginMap = React.useMemo(() => {
    const map = new Map<string, PluginMenuPlugin>()

    for (const skill of skills) {
      const pluginSlug = skill.metadata.plugin
      if (!pluginSlug) continue

      const pluginLabel = skill.metadata.pluginLabel || toLabel(pluginSlug)
      const plugin = map.get(pluginSlug) || {
        slug: pluginSlug,
        label: pluginLabel,
        commands: [],
        skills: [],
      }

      const entryKind = skill.metadata.pluginType === 'command' ? 'command' : 'skill'
      const entryLabel = entryKind === 'command'
        ? (skill.metadata.pluginCommand || skill.slug)
        : skill.metadata.name

      const entry: PluginMenuEntry = {
        id: entryKind === 'command' ? (skill.metadata.pluginCommand || skill.slug) : skill.slug,
        kind: entryKind,
        label: entryLabel,
        description: skill.metadata.description,
        skillSlug: skill.slug,
      }

      if (entryKind === 'command') {
        plugin.commands.push(entry)
      } else {
        plugin.skills.push(entry)
      }

      map.set(pluginSlug, plugin)
    }

    for (const plugin of map.values()) {
      plugin.commands.sort((a, b) => a.label.localeCompare(b.label))
      plugin.skills.sort((a, b) => a.label.localeCompare(b.label))
    }

    return map
  }, [skills])

  const activePluginLabel = activePluginSlug ? pluginMap.get(activePluginSlug)?.label : undefined

  const items = React.useMemo((): PluginMenuItem[] => {
    const lowerFilter = filter.toLowerCase()

    if (mode === 'plugins') {
      const pluginItems: PluginMenuItem[] = Array.from(pluginMap.values()).map(plugin => ({
        type: 'plugin',
        id: plugin.slug,
        label: plugin.label,
        description: `${plugin.commands.length} commands, ${plugin.skills.length} skills`,
        pluginSlug: plugin.slug,
        pluginLabel: plugin.label,
      }))

      return pluginItems
        .filter(item => {
          if (!lowerFilter) return true
          return item.label.toLowerCase().includes(lowerFilter) || item.id.toLowerCase().includes(lowerFilter)
        })
        .sort((a, b) => sortByRelevance(a, b, lowerFilter))
    }

    if (!activePluginSlug) return []
    const plugin = pluginMap.get(activePluginSlug)
    if (!plugin) return []

    const entryItems: PluginMenuItem[] = [
      ...plugin.commands.map(entry => ({
        type: 'entry' as const,
        id: entry.id,
        label: entry.label,
        description: entry.description,
        pluginSlug: plugin.slug,
        pluginLabel: plugin.label,
        entryKind: 'command' as const,
        skillSlug: entry.skillSlug,
      })),
      ...plugin.skills.map(entry => ({
        type: 'entry' as const,
        id: entry.id,
        label: entry.label,
        description: entry.description,
        pluginSlug: plugin.slug,
        pluginLabel: plugin.label,
        entryKind: 'skill' as const,
        skillSlug: entry.skillSlug,
      })),
    ]

    return entryItems
      .filter(item => {
        if (!lowerFilter) return true
        return item.label.toLowerCase().includes(lowerFilter) || item.id.toLowerCase().includes(lowerFilter)
      })
      .sort((a, b) => {
        if (a.entryKind !== b.entryKind) {
          return a.entryKind === 'command' ? -1 : 1
        }
        return sortByRelevance(a, b, lowerFilter)
      })
  }, [mode, activePluginSlug, pluginMap, filter])

  const close = React.useCallback(() => {
    setIsOpen(false)
    setFilter('')
    setTriggerStart(-1)
    setActivePluginSlug(null)
    setMode('plugins')
  }, [])

  const handleInputChange = React.useCallback((value: string, cursorPosition: number) => {
    currentInputRef.current = { value, cursorPosition }

    const textBeforeCursor = value.slice(0, cursorPosition)
    const trigger = parsePluginTrigger(textBeforeCursor, pluginMap)
    if (!trigger) return close()

    setTriggerStart(trigger.triggerStart)
    setActivePluginSlug(trigger.pluginSlug)
    setMode(trigger.mode)
    setFilter(trigger.filterText)
    setPosition(getInlineMenuPosition(inputRef.current))
    setIsOpen(true)
  }, [close, inputRef, pluginMap])

  const handleSelect = React.useCallback((item: PluginMenuItem): { value: string; cursorPosition: number; keepMenuOpen: boolean } => {
    const { value: currentValue, cursorPosition } = currentInputRef.current

    if (triggerStart < 0) {
      return { value: currentValue, cursorPosition, keepMenuOpen: false }
    }

    const before = currentValue.slice(0, triggerStart)
    const after = currentValue.slice(cursorPosition)

    if (item.type === 'plugin') {
      const inserted = `%${item.id} `
      const nextValue = `${before}${inserted}${after}`
      const nextCursor = before.length + inserted.length

      setActivePluginSlug(item.id)
      setMode('entries')
      setFilter('')
      setIsOpen(true)

      return { value: nextValue, cursorPosition: nextCursor, keepMenuOpen: true }
    }

    const skillSlug = item.skillSlug || item.id
    const skill = skillsBySlug.get(skillSlug)
    const pluginName = skill?.source === 'workspace' ? workspaceSlug : AGENTS_PLUGIN_NAME
    const qualifiedSkill = pluginName ? `${pluginName}:${skillSlug}` : skillSlug
    const mentionText = `[skill:${qualifiedSkill}] `
    const nextValue = `${before}${mentionText}${after}`
    const nextCursor = before.length + mentionText.length

    close()
    return { value: nextValue, cursorPosition: nextCursor, keepMenuOpen: false }
  }, [triggerStart, skillsBySlug, workspaceSlug, close])

  return {
    isOpen,
    mode,
    filter,
    position,
    items,
    activePluginLabel,
    handleInputChange,
    close,
    handleSelect,
  }
}
