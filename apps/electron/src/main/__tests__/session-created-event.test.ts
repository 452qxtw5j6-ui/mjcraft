import { describe, expect, it } from 'bun:test'
import type { SessionEvent } from '../../shared/types'

describe('session_created event contract', () => {
  it('uses the explicit session_created event shape for renderer refresh', () => {
    const event: SessionEvent = {
      type: 'session_created',
      sessionId: 'session-1',
    }

    expect(event.type).toBe('session_created')
    expect(event.sessionId).toBe('session-1')
  })
})
