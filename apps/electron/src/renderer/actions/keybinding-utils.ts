import { isMac } from '@/lib/platform'
import type { ActionDefinition } from './types'

export function matchesHotkey(e: KeyboardEvent, hotkey: string, action?: ActionDefinition): boolean {
  const parts = hotkey.toLowerCase().split('+')
  const key = parts[parts.length - 1]
  const needsMod = parts.includes('mod')
  const needsShift = parts.includes('shift')
  const needsAlt = parts.includes('alt')

  const modPressed = isMac ? e.metaKey : e.ctrlKey
  const logicalKeyMatches = e.key.toLowerCase() === key
  const isDeleteAlias = key === 'backspace' || key === 'delete'
  const deleteAliasMatches = isDeleteAlias
    ? e.key.toLowerCase() === 'backspace' || e.key.toLowerCase() === 'delete'
    : false

  const specialKeys: Record<string, string> = {
    '[': 'BracketLeft',
    ']': 'BracketRight',
    ',': 'Comma',
    '.': 'Period',
    'backspace': 'Backspace',
    'delete': 'Backspace',
    'left': 'ArrowLeft',
    'right': 'ArrowRight',
    'up': 'ArrowUp',
    'down': 'ArrowDown',
    'escape': 'Escape',
    'tab': 'Tab',
  }

  const specialCode = specialKeys[key]
  const codeMatches = specialCode
    ? e.code === specialCode
    : logicalKeyMatches || deleteAliasMatches

  const physicalCodeMatches = action?.physicalKey
    ? e.code === action.physicalKey
    : false

  const modCorrect = needsMod ? modPressed : !modPressed
  const shiftCorrect = needsShift ? e.shiftKey : !e.shiftKey
  const altCorrect = needsAlt ? e.altKey : !e.altKey

  return (codeMatches || physicalCodeMatches) && modCorrect && shiftCorrect && altCorrect
}

export function formatHotkeyDisplay(hotkey: string): string {
  const parts = hotkey.toLowerCase().split('+')

  const symbols = parts.map(part => {
    if (part === 'mod') return isMac ? '⌘' : 'Ctrl'
    if (part === 'shift') return isMac ? '⇧' : 'Shift'
    if (part === 'alt') return isMac ? '⌥' : 'Alt'
    if (part === 'escape') return 'Esc'
    if (part === 'tab') return 'Tab'
    if (part === 'left') return '←'
    if (part === 'right') return '→'
    if (part === '[') return '['
    if (part === ']') return ']'
    return part.toUpperCase()
  })

  return isMac ? symbols.join('') : symbols.join('+')
}
