import { describe, expect, it } from 'bun:test'
import { mergeSessionOptions, normalizeSessionOptions, resolveSessionThinkingLevel } from './useSessionOptions'

describe('useSessionOptions helpers', () => {
  it('normalizes legacy think values to medium', () => {
    expect(resolveSessionThinkingLevel('think')).toBe('medium')
    expect(normalizeSessionOptions({ thinkingLevel: 'think' as any }).thinkingLevel).toBe('medium')
  })

  it('falls back to medium for invalid thinking levels', () => {
    expect(resolveSessionThinkingLevel('ultra')).toBe('medium')
  })

  it('keeps mergeSessionOptions output normalized', () => {
    expect(mergeSessionOptions(undefined, { thinkingLevel: 'think' as any }).thinkingLevel).toBe('medium')
  })
})
