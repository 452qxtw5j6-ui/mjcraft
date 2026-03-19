import * as React from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { LoadedPersona } from '../../../shared/types'

const MENU_CONTAINER_STYLE = 'overflow-hidden rounded-[8px] bg-background text-foreground shadow-modal-small'
const MENU_LIST_STYLE = 'max-h-[240px] overflow-y-auto py-1'
const MENU_ITEM_STYLE = 'flex cursor-pointer select-none items-center gap-2.5 rounded-[6px] mx-1 px-2 py-1.5 text-[13px]'
const MENU_ITEM_SELECTED = 'bg-foreground/5'

export interface PersonaMenuInputElement {
  getBoundingClientRect: () => DOMRect
  getCaretRect?: () => DOMRect | null
  value: string
  selectionStart: number
}

export interface InlinePersonaMenuProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  personas: LoadedPersona[]
  currentPersonaId?: string
  onSelect: (personaId: string) => void
  filter?: string
  position: { x: number; y: number }
  className?: string
}

export interface UseInlinePersonaMenuOptions {
  inputRef: React.RefObject<PersonaMenuInputElement | null>
  personas: LoadedPersona[]
  enabled: boolean
  onSelect: (personaId: string) => Promise<void> | void
}

export interface UseInlinePersonaMenuReturn {
  isOpen: boolean
  filter: string
  position: { x: number; y: number }
  personas: LoadedPersona[]
  handleInputChange: (value: string, cursorPosition: number) => void
  close: () => void
  handleSelect: (personaId: string) => Promise<string>
}

function filterPersonas(personas: LoadedPersona[], filter: string): LoadedPersona[] {
  const query = filter.trim().toLowerCase()
  if (!query) return personas
  return personas.filter((persona) =>
    persona.name.toLowerCase().includes(query)
    || persona.id.toLowerCase().includes(query),
  )
}

export function InlinePersonaMenu({
  open,
  onOpenChange,
  personas,
  currentPersonaId,
  onSelect,
  filter = '',
  position,
  className,
}: InlinePersonaMenuProps) {
  const filteredPersonas = React.useMemo(() => filterPersonas(personas, filter), [personas, filter])
  const [selectedIndex, setSelectedIndex] = React.useState(0)
  const listRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    setSelectedIndex(0)
  }, [filter, open])

  React.useEffect(() => {
    if (!listRef.current) return
    const selectedEl = listRef.current.querySelector('[data-selected="true"]')
    if (selectedEl) {
      selectedEl.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex])

  React.useEffect(() => {
    if (!open || filteredPersonas.length === 0) return

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setSelectedIndex((prev) => (prev < filteredPersonas.length - 1 ? prev + 1 : 0))
          break
        case 'ArrowUp':
          e.preventDefault()
          setSelectedIndex((prev) => (prev > 0 ? prev - 1 : filteredPersonas.length - 1))
          break
        case 'Enter':
        case 'Tab':
          e.preventDefault()
          onSelect(filteredPersonas[selectedIndex]!.id)
          onOpenChange(false)
          break
        case 'Escape':
          e.preventDefault()
          onOpenChange(false)
          break
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, filteredPersonas, selectedIndex, onSelect, onOpenChange])

  if (!open) return null

  return (
    <div
      className={cn(MENU_CONTAINER_STYLE, className)}
      style={{
        position: 'fixed',
        left: position.x,
        top: position.y - 8,
        transform: 'translateY(-100%)',
        minWidth: 220,
        maxWidth: 320,
        zIndex: 1000,
      }}
    >
      <div className="px-3 py-2 text-[11px] uppercase tracking-[0.08em] text-muted-foreground border-b border-border/50">
        Personas
      </div>
      <div ref={listRef} className={MENU_LIST_STYLE}>
        {filteredPersonas.length === 0 ? (
          <div className="px-3 py-2 text-[13px] text-muted-foreground">No matching personas.</div>
        ) : (
          filteredPersonas.map((persona, index) => {
            const isSelected = index === selectedIndex
            const isActive = persona.id === currentPersonaId
            return (
              <div
                key={persona.id}
                data-selected={isSelected ? 'true' : 'false'}
                className={cn(MENU_ITEM_STYLE, isSelected && MENU_ITEM_SELECTED)}
                onMouseEnter={() => setSelectedIndex(index)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onSelect(persona.id)
                  onOpenChange(false)
                }}
              >
                <div className="flex-1 min-w-0">
                  <div className="truncate font-medium">{persona.name}</div>
                  <div className="truncate text-[11px] text-muted-foreground">{persona.id}</div>
                </div>
                <div className={cn('shrink-0', !isActive && 'opacity-0')}>
                  <Check className="h-3.5 w-3.5" />
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

export function useInlinePersonaMenu({
  inputRef,
  personas,
  enabled,
  onSelect,
}: UseInlinePersonaMenuOptions): UseInlinePersonaMenuReturn {
  const [isOpen, setIsOpen] = React.useState(false)
  const [filter, setFilter] = React.useState('')
  const [position, setPosition] = React.useState({ x: 0, y: 0 })
  const [percentStart, setPercentStart] = React.useState(-1)
  const currentInputRef = React.useRef({ value: '', cursorPosition: 0 })

  const handleInputChange = React.useCallback((value: string, cursorPosition: number) => {
    currentInputRef.current = { value, cursorPosition }

    if (!enabled) {
      setIsOpen(false)
      setFilter('')
      setPercentStart(-1)
      return
    }

    const textBeforeCursor = value.slice(0, cursorPosition)
    const textAfterCursor = value.slice(cursorPosition)
    const percentMatch = textBeforeCursor.match(/^\s*%([\w-]*)$/)
    const onlyPersonaDraft = value.trim().startsWith('%') && textAfterCursor.trim() === ''

    if (percentMatch && onlyPersonaDraft) {
      const filterText = percentMatch[1] || ''
      const matchStart = textBeforeCursor.lastIndexOf('%')
      setPercentStart(matchStart)
      setFilter(filterText)

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
      return
    }

    setIsOpen(false)
    setFilter('')
    setPercentStart(-1)
  }, [enabled, inputRef])

  const handleSelect = React.useCallback(async (personaId: string): Promise<string> => {
    let result = ''
    if (percentStart >= 0) {
      const { value: currentValue, cursorPosition } = currentInputRef.current
      const before = currentValue.slice(0, percentStart)
      const after = currentValue.slice(cursorPosition)
      result = (before + after).trim()
    }

    await onSelect(personaId)
    setIsOpen(false)
    setFilter('')
    setPercentStart(-1)
    return result
  }, [onSelect, percentStart])

  const close = React.useCallback(() => {
    setIsOpen(false)
    setFilter('')
    setPercentStart(-1)
  }, [])

  return {
    isOpen,
    filter,
    position,
    personas,
    handleInputChange,
    close,
    handleSelect,
  }
}
