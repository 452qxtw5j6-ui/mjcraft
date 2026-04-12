import * as React from 'react'
import { ChevronRight, Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { SkillAvatar } from '@/components/ui/skill-avatar'
import { SourceAvatar } from '@/components/ui/source-avatar'
import type { LoadedSkill, LoadedSource } from '../../../shared/types'
import { AGENTS_PLUGIN_NAME } from '@craft-agent/shared/skills/types'

const MENU_CONTAINER_STYLE = 'overflow-hidden rounded-[10px] bg-background text-foreground shadow-modal-small border border-border/50'
const MENU_LIST_STYLE = 'max-h-[260px] overflow-y-auto py-1'
const MENU_ITEM_STYLE = 'flex cursor-pointer select-none items-center gap-3 rounded-[8px] mx-1 px-2.5 py-2 text-[13px]'
const MENU_ITEM_SELECTED = 'bg-foreground/6'

export interface PluginCommandItem {
  id: string
  label: string
  description?: string
  skillSlug: string
  sourceSlug: string
  skill?: LoadedSkill
}

export interface PluginSourceItem {
  id: string
  label: string
  description?: string
  source: LoadedSource
  commands: PluginCommandItem[]
}

export interface InlinePluginMenuProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  plugins: PluginSourceItem[]
  filter?: string
  position: { x: number; y: number }
  workspaceId?: string
  onSelectCommand: (item: PluginCommandItem) => void
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
  sources: LoadedSource[]
  workspaceId?: string
  onSelect: (item: PluginCommandItem) => void
}

export interface UseInlinePluginMenuReturn {
  isOpen: boolean
  filter: string
  position: { x: number; y: number }
  plugins: PluginSourceItem[]
  handleInputChange: (value: string, cursorPosition: number) => void
  close: () => void
  handleSelect: (item: PluginCommandItem) => { value: string; cursorPosition: number }
}

function isWhitespaceOrBracket(charBefore: string | undefined): boolean {
  if (charBefore === undefined) return false
  return /\s/.test(charBefore) || /[("']/.test(charBefore)
}

export function isValidPluginTrigger(textBeforeCursor: string, percentPosition: number): boolean {
  if (percentPosition < 0) return false
  if (percentPosition === 0) return true
  return isWhitespaceOrBracket(textBeforeCursor[percentPosition - 1])
}

function filterPlugins(plugins: PluginSourceItem[], filter: string): PluginSourceItem[] {
  const normalized = filter.trim().toLowerCase()
  if (!normalized) return plugins

  return plugins.filter((plugin) =>
    plugin.label.toLowerCase().includes(normalized) ||
    plugin.description?.toLowerCase().includes(normalized)
  )
}

function buildPluginItems(sources: LoadedSource[], skills: LoadedSkill[]): PluginSourceItem[] {
  const skillsBySlug = new Map(skills.map((skill) => [skill.slug, skill]))

  return sources
    .filter((source) => source.config.plugin?.items?.length)
    .map((source) => ({
      id: source.config.slug,
      label: source.config.plugin?.name || source.config.name,
      description: source.config.plugin?.description || source.config.tagline,
      source,
      commands: (source.config.plugin?.items || []).map((item) => {
        const resolvedSkill = skillsBySlug.get(item.skill)
        return {
          id: item.id,
          label: item.label || resolvedSkill?.metadata.name || item.id,
          description: item.description || resolvedSkill?.metadata.description,
          skillSlug: item.skill,
          sourceSlug: source.config.slug,
          skill: resolvedSkill,
        }
      }),
    }))
}

export function InlinePluginMenu({
  open,
  onOpenChange,
  plugins,
  filter = '',
  position,
  workspaceId,
  onSelectCommand,
}: InlinePluginMenuProps) {
  const { t } = useTranslation()
  const menuRef = React.useRef<HTMLDivElement>(null)
  const pluginListRef = React.useRef<HTMLDivElement>(null)
  const commandListRef = React.useRef<HTMLDivElement>(null)
  const filteredPlugins = React.useMemo(() => filterPlugins(plugins, filter), [plugins, filter])
  const [selectedPluginIndex, setSelectedPluginIndex] = React.useState(0)
  const [expandedPluginId, setExpandedPluginId] = React.useState<string | null>(null)
  const [selectedCommandIndex, setSelectedCommandIndex] = React.useState(0)

  React.useEffect(() => {
    setSelectedPluginIndex(0)
    setSelectedCommandIndex(0)
    setExpandedPluginId(null)
  }, [filter, open])

  const selectedPlugin = filteredPlugins[selectedPluginIndex] ?? null
  const expandedPlugin = expandedPluginId
    ? filteredPlugins.find((plugin) => plugin.id === expandedPluginId) ?? null
    : null

  React.useEffect(() => {
    if (!open) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!expandedPlugin) {
        switch (e.key) {
          case 'ArrowDown':
            e.preventDefault()
            setSelectedPluginIndex((prev) => (prev < filteredPlugins.length - 1 ? prev + 1 : 0))
            break
          case 'ArrowUp':
            e.preventDefault()
            setSelectedPluginIndex((prev) => (prev > 0 ? prev - 1 : filteredPlugins.length - 1))
            break
          case 'ArrowRight':
          case 'Enter':
            if (!selectedPlugin || selectedPlugin.commands.length === 0) break
            e.preventDefault()
            setExpandedPluginId(selectedPlugin.id)
            setSelectedCommandIndex(0)
            break
          case 'Escape':
            e.preventDefault()
            onOpenChange(false)
            break
        }
        return
      }

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setSelectedCommandIndex((prev) => (prev < expandedPlugin.commands.length - 1 ? prev + 1 : 0))
          break
        case 'ArrowUp':
          e.preventDefault()
          setSelectedCommandIndex((prev) => (prev > 0 ? prev - 1 : expandedPlugin.commands.length - 1))
          break
        case 'ArrowLeft':
          e.preventDefault()
          setExpandedPluginId(null)
          break
        case 'Enter':
        case 'Tab': {
          const command = expandedPlugin.commands[selectedCommandIndex]
          if (!command) break
          e.preventDefault()
          onSelectCommand(command)
          onOpenChange(false)
          break
        }
        case 'Escape':
          e.preventDefault()
          onOpenChange(false)
          break
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [expandedPlugin, filteredPlugins.length, onOpenChange, onSelectCommand, selectedCommandIndex, selectedPlugin])

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
    const list = expandedPlugin ? commandListRef.current : pluginListRef.current
    if (!list) return
    const selectedEl = list.querySelector('[data-selected="true"]')
    if (selectedEl) selectedEl.scrollIntoView({ block: 'nearest' })
  }, [expandedPlugin, selectedPluginIndex, selectedCommandIndex])

  if (!open) return null

  const bottomPosition = typeof window !== 'undefined'
    ? window.innerHeight - Math.round(position.y) + 8
    : 0

  return (
    <div
      ref={menuRef}
      data-inline-plugin-menu
      className="fixed z-dropdown"
      style={{ left: Math.round(position.x) - 10, bottom: bottomPosition }}
    >
      <div className="relative w-[300px]">
      <div className={cn(MENU_CONTAINER_STYLE, 'w-[300px]')}>
        <div className="px-3 py-1.5 text-[12px] font-medium text-muted-foreground border-b border-foreground/5">
          {t('sidebar.plugins', { defaultValue: 'Plugins' })}
        </div>
        <div ref={pluginListRef} className={MENU_LIST_STYLE}>
          {filteredPlugins.length === 0 && (
            <div className="px-3 py-2 text-[12px] text-muted-foreground/60">
              {t('chat.noResults')}
            </div>
          )}
          {filteredPlugins.map((plugin, index) => {
            const isSelected = expandedPlugin ? expandedPlugin.id === plugin.id : index === selectedPluginIndex
            return (
              <div
                key={plugin.id}
                data-selected={isSelected}
                onMouseEnter={() => {
                  setSelectedPluginIndex(index)
                  setExpandedPluginId(plugin.id)
                  setSelectedCommandIndex(0)
                }}
                onClick={() => {
                  setSelectedPluginIndex(index)
                  setExpandedPluginId(plugin.id)
                  setSelectedCommandIndex(0)
                }}
                className={cn(MENU_ITEM_STYLE, isSelected && MENU_ITEM_SELECTED)}
              >
                <SourceAvatar source={plugin.source} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="truncate">{plugin.label}</div>
                  {plugin.description && (
                    <div className="truncate text-[11px] text-muted-foreground">{plugin.description}</div>
                  )}
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </div>
            )
          })}
        </div>
      </div>

      {expandedPlugin && (
        <div className={cn(MENU_CONTAINER_STYLE, 'absolute left-[calc(100%+8px)] top-0 w-[320px]')}>
          <div className="px-3 py-1.5 text-[12px] font-medium text-muted-foreground border-b border-foreground/5">
            {expandedPlugin.label}
          </div>
          <div ref={commandListRef} className={MENU_LIST_STYLE}>
            {expandedPlugin.commands.map((command, index) => {
              const isSelected = index === selectedCommandIndex
              return (
                <div
                  key={`${expandedPlugin.id}:${command.id}`}
                  data-selected={isSelected}
                  onMouseEnter={() => setSelectedCommandIndex(index)}
                  onClick={() => {
                    onSelectCommand(command)
                    onOpenChange(false)
                  }}
                  className={cn(MENU_ITEM_STYLE, isSelected && MENU_ITEM_SELECTED)}
                >
                  {command.skill ? (
                    <SkillAvatar skill={command.skill} size="sm" workspaceId={workspaceId} />
                  ) : (
                    <span className="flex h-5 w-5 items-center justify-center rounded-[6px] bg-foreground/6 text-muted-foreground">
                      <Sparkles className="h-3.5 w-3.5" />
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{command.label}</div>
                    {command.description && (
                      <div className="truncate text-[11px] text-muted-foreground">{command.description}</div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
      </div>
    </div>
  )
}

export function useInlinePluginMenu({
  inputRef,
  skills,
  sources,
  workspaceId,
  onSelect,
}: UseInlinePluginMenuOptions): UseInlinePluginMenuReturn {
  const [isOpen, setIsOpen] = React.useState(false)
  const [filter, setFilter] = React.useState('')
  const [position, setPosition] = React.useState({ x: 0, y: 0 })
  const [percentStart, setPercentStart] = React.useState(-1)
  const currentInputRef = React.useRef({ value: '', cursorPosition: 0 })
  const plugins = React.useMemo(() => buildPluginItems(sources, skills), [sources, skills])

  const handleInputChange = React.useCallback((value: string, cursorPosition: number) => {
    currentInputRef.current = { value, cursorPosition }
    const textBeforeCursor = value.slice(0, cursorPosition)
    const percentMatch = textBeforeCursor.match(/%([\w\-. ]{0,100})?$/)
    const matchStart = percentMatch ? textBeforeCursor.lastIndexOf('%') : -1
    const isValidTrigger = percentMatch && isValidPluginTrigger(textBeforeCursor, matchStart)

    if (!isValidTrigger || plugins.length === 0) {
      setIsOpen(false)
      setFilter('')
      setPercentStart(-1)
      return
    }

    setPercentStart(matchStart)
    setFilter(percentMatch[1] || '')

    if (inputRef.current) {
      const caretRect = inputRef.current.getCaretRect?.()
      if (caretRect && caretRect.x > 0) {
        setPosition({ x: caretRect.x, y: caretRect.y })
      } else {
        const rect = inputRef.current.getBoundingClientRect()
        setPosition({ x: rect.left, y: rect.top + 20 })
      }
    }

    setIsOpen(true)
  }, [inputRef, plugins.length])

  const handleSelect = React.useCallback((item: PluginCommandItem): { value: string; cursorPosition: number } => {
    let value = ''
    let cursorPosition = 0

    if (percentStart >= 0) {
      const current = currentInputRef.current
      const before = current.value.slice(0, percentStart)
      const after = current.value.slice(current.cursorPosition)
      const pluginName = item.skill?.source === 'workspace' ? workspaceId : AGENTS_PLUGIN_NAME
      const qualifiedName = pluginName ? `${pluginName}:${item.skillSlug}` : item.skillSlug
      const mentionText = `[skill:${qualifiedName}] `
      value = before + mentionText + after
      cursorPosition = before.length + mentionText.length
    }

    onSelect(item)
    setIsOpen(false)
    setFilter('')
    setPercentStart(-1)
    return { value, cursorPosition }
  }, [onSelect, percentStart, workspaceId])

  const close = React.useCallback(() => {
    setIsOpen(false)
    setFilter('')
    setPercentStart(-1)
  }, [])

  return {
    isOpen,
    filter,
    position,
    plugins,
    handleInputChange,
    close,
    handleSelect,
  }
}
