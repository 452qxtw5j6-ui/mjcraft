import * as React from 'react'
import { Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { SkillAvatar } from '@/components/ui/skill-avatar'
import type { LoadedSkill } from '../../../shared/types'
import { AGENTS_PLUGIN_NAME } from '@craft-agent/shared/skills/types'

const MENU_CONTAINER_STYLE = 'overflow-hidden rounded-[10px] bg-background text-foreground shadow-modal-small border border-border/50'
const MENU_LIST_STYLE = 'max-h-[260px] overflow-y-auto py-1'
const MENU_ITEM_STYLE = 'flex cursor-pointer select-none items-center gap-3 rounded-[8px] mx-1 px-2.5 py-2 text-[13px]'
const MENU_ITEM_SELECTED = 'bg-foreground/6'

export interface SkillCommandItem {
  id: string
  label: string
  description?: string
  skill: LoadedSkill
}

export interface InlineSkillMenuProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  items: SkillCommandItem[]
  filter?: string
  position: { x: number; y: number }
  workspaceId?: string
  onSelectSkill: (item: SkillCommandItem) => void
}

export interface SkillInputElement {
  getBoundingClientRect: () => DOMRect
  getCaretRect?: () => DOMRect | null
  value: string
  selectionStart: number
}

export interface UseInlineSkillMenuOptions {
  inputRef: React.RefObject<SkillInputElement | null>
  skills: LoadedSkill[]
  workspaceId?: string
  onSelect: (item: SkillCommandItem) => void
}

export interface UseInlineSkillMenuReturn {
  isOpen: boolean
  filter: string
  position: { x: number; y: number }
  items: SkillCommandItem[]
  handleInputChange: (value: string, cursorPosition: number) => void
  close: () => void
  handleSelect: (item: SkillCommandItem) => { value: string; cursorPosition: number }
}

function isWhitespaceOrBracket(charBefore: string | undefined): boolean {
  if (charBefore === undefined) return false
  return /\s/.test(charBefore) || /[("']/.test(charBefore)
}

export function isValidSkillTrigger(textBeforeCursor: string, dollarPosition: number): boolean {
  if (dollarPosition < 0) return false
  if (dollarPosition === 0) return true
  return isWhitespaceOrBracket(textBeforeCursor[dollarPosition - 1])
}

function filterSkills(items: SkillCommandItem[], filter: string): SkillCommandItem[] {
  const normalized = filter.trim().toLowerCase()
  if (!normalized) return items

  return items.filter((item) =>
    item.label.toLowerCase().includes(normalized) ||
    item.id.toLowerCase().includes(normalized) ||
    item.description?.toLowerCase().includes(normalized)
  )
}

export function InlineSkillMenu({
  open,
  onOpenChange,
  items,
  filter = '',
  position,
  workspaceId,
  onSelectSkill,
}: InlineSkillMenuProps) {
  const { t } = useTranslation()
  const menuRef = React.useRef<HTMLDivElement>(null)
  const listRef = React.useRef<HTMLDivElement>(null)
  const [selectedIndex, setSelectedIndex] = React.useState(0)
  const filteredItems = React.useMemo(() => filterSkills(items, filter), [items, filter])

  React.useEffect(() => {
    setSelectedIndex(0)
  }, [filter, open])

  React.useEffect(() => {
    if (!open || filteredItems.length === 0) return

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setSelectedIndex((prev) => (prev < filteredItems.length - 1 ? prev + 1 : 0))
          break
        case 'ArrowUp':
          e.preventDefault()
          setSelectedIndex((prev) => (prev > 0 ? prev - 1 : filteredItems.length - 1))
          break
        case 'Enter':
        case 'Tab':
          e.preventDefault()
          if (filteredItems[selectedIndex]) {
            onSelectSkill(filteredItems[selectedIndex])
            onOpenChange(false)
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
  }, [filteredItems, onOpenChange, onSelectSkill, open, selectedIndex])

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
    if (selectedEl) selectedEl.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  if (!open) return null

  const bottomPosition = typeof window !== 'undefined'
    ? window.innerHeight - Math.round(position.y) + 8
    : 0

  return (
    <div
      ref={menuRef}
      data-inline-skill-menu
      className={cn('fixed z-dropdown', MENU_CONTAINER_STYLE)}
      style={{ left: Math.round(position.x) - 10, bottom: bottomPosition, width: 320 }}
    >
      <div className="px-3 py-1.5 text-[12px] font-medium text-muted-foreground border-b border-foreground/5">
        {t('sidebar.skills', { defaultValue: 'Skills' })}
      </div>
      <div ref={listRef} className={MENU_LIST_STYLE}>
        {filteredItems.length === 0 && (
          <div className="px-3 py-2 text-[12px] text-muted-foreground/60">{t('chat.noResults')}</div>
        )}
        {filteredItems.map((item, index) => {
          const isSelected = index === selectedIndex
          return (
            <div
              key={item.id}
              data-selected={isSelected}
              onMouseEnter={() => setSelectedIndex(index)}
              onClick={() => {
                onSelectSkill(item)
                onOpenChange(false)
              }}
              className={cn(MENU_ITEM_STYLE, isSelected && MENU_ITEM_SELECTED)}
            >
              {item.skill ? (
                <SkillAvatar skill={item.skill} size="sm" workspaceId={workspaceId} />
              ) : (
                <span className="flex h-5 w-5 items-center justify-center rounded-[6px] bg-foreground/6 text-muted-foreground">
                  <Sparkles className="h-3.5 w-3.5" />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate">{item.label}</div>
                {item.description && (
                  <div className="truncate text-[11px] text-muted-foreground">{item.description}</div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function useInlineSkillMenu({
  inputRef,
  skills,
  workspaceId,
  onSelect,
}: UseInlineSkillMenuOptions): UseInlineSkillMenuReturn {
  const [isOpen, setIsOpen] = React.useState(false)
  const [filter, setFilter] = React.useState('')
  const [position, setPosition] = React.useState({ x: 0, y: 0 })
  const [dollarStart, setDollarStart] = React.useState(-1)
  const currentInputRef = React.useRef({ value: '', cursorPosition: 0 })

  const items = React.useMemo(() => skills.map((skill) => ({
    id: skill.slug,
    label: skill.metadata.name,
    description: skill.metadata.description,
    skill,
  })), [skills])

  const handleInputChange = React.useCallback((value: string, cursorPosition: number) => {
    currentInputRef.current = { value, cursorPosition }
    const textBeforeCursor = value.slice(0, cursorPosition)
    const dollarMatch = textBeforeCursor.match(/\$([\w\-. ]{0,100})?$/)
    const matchStart = dollarMatch ? textBeforeCursor.lastIndexOf('$') : -1
    const isValidTrigger = dollarMatch && isValidSkillTrigger(textBeforeCursor, matchStart)

    if (!isValidTrigger || items.length === 0) {
      setIsOpen(false)
      setFilter('')
      setDollarStart(-1)
      return
    }

    setDollarStart(matchStart)
    setFilter(dollarMatch[1] || '')

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
  }, [inputRef, items.length])

  const handleSelect = React.useCallback((item: SkillCommandItem): { value: string; cursorPosition: number } => {
    let value = ''
    let cursorPosition = 0

    if (dollarStart >= 0) {
      const current = currentInputRef.current
      const before = current.value.slice(0, dollarStart)
      const after = current.value.slice(current.cursorPosition)
      const pluginName = item.skill.source === 'workspace' ? workspaceId : AGENTS_PLUGIN_NAME
      const qualifiedName = pluginName ? `${pluginName}:${item.id}` : item.id
      const mentionText = `[skill:${qualifiedName}] `
      value = before + mentionText + after
      cursorPosition = before.length + mentionText.length
    }

    onSelect(item)
    setIsOpen(false)
    setFilter('')
    setDollarStart(-1)
    return { value, cursorPosition }
  }, [dollarStart, onSelect, workspaceId])

  const close = React.useCallback(() => {
    setIsOpen(false)
    setFilter('')
    setDollarStart(-1)
  }, [])

  return {
    isOpen,
    filter,
    position,
    items,
    handleInputChange,
    close,
    handleSelect,
  }
}
