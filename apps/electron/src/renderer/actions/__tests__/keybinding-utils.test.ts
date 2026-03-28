import { describe, expect, it } from 'bun:test'
import { actions } from '../definitions'
import { matchesHotkey } from '../keybinding-utils'

function createKeyboardEvent(init: {
  key: string
  code: string
  metaKey?: boolean
  ctrlKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
}): KeyboardEvent {
  return init as KeyboardEvent
}

describe('action shortcut definitions', () => {
  it('keeps the Linear quick issue shortcut on C', () => {
    expect(actions['chat.openLinearQuickIssue'].defaultHotkey).toBe('c')
    expect(actions['chat.openLinearQuickIssue'].physicalKey).toBe('KeyC')
  })

  it('keeps Command+Delete for current-session deletion in chat and navigator', () => {
    expect(actions['chat.deleteCurrentSession'].defaultHotkey).toBe('mod+backspace')
    expect(actions['navigator.deleteSelectedSession'].defaultHotkey).toBe('mod+backspace')
  })
})

describe('matchesHotkey', () => {
  it('matches the Linear quick issue shortcut by logical key', () => {
    const event = createKeyboardEvent({
      key: 'c',
      code: 'KeyC',
    })

    expect(matchesHotkey(event, 'c', actions['chat.openLinearQuickIssue'])).toBe(true)
  })

  it('matches the Linear quick issue shortcut by physical key on non-Latin layouts', () => {
    const event = createKeyboardEvent({
      key: 'ㅊ',
      code: 'KeyC',
    })

    expect(matchesHotkey(event, 'c', actions['chat.openLinearQuickIssue'])).toBe(true)
  })

  it('matches Command+Delete on macOS keyboards', () => {
    const event = createKeyboardEvent({
      key: 'Backspace',
      code: 'Backspace',
      metaKey: true,
    })

    expect(matchesHotkey(event, 'mod+backspace', actions['chat.deleteCurrentSession'])).toBe(true)
  })

  it('matches Command+Delete when the runtime reports Delete instead of Backspace', () => {
    const event = createKeyboardEvent({
      key: 'Delete',
      code: 'Backspace',
      metaKey: true,
    })

    expect(matchesHotkey(event, 'mod+backspace', actions['chat.deleteCurrentSession'])).toBe(true)
    expect(matchesHotkey(event, 'mod+backspace', actions['navigator.deleteSelectedSession'])).toBe(true)
  })
})
