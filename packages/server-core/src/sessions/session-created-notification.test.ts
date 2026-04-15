import { describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { SessionManager } from './SessionManager'

describe('SessionManager.notifySessionCreated', () => {
  it('emits a session_created event for existing sessions', () => {
    const manager = new SessionManager()
    const events: Array<{ channel: string; target: unknown; payload: unknown }> = []

    manager.setEventSink((channel, target, payload) => {
      events.push({ channel, target, payload })
    })

    ;(manager as any).sessions.set('session-1', {
      id: 'session-1',
      workspace: { id: 'ws-1' },
    })

    manager.notifySessionCreated('session-1')

    expect(events).toEqual([
      {
        channel: RPC_CHANNELS.sessions.EVENT,
        target: { to: 'workspace', workspaceId: 'ws-1' },
        payload: { type: 'session_created', sessionId: 'session-1' },
      },
    ])
  })

  it('is a no-op when the session is not registered', () => {
    const manager = new SessionManager()
    const events: unknown[] = []

    manager.setEventSink((_channel, _target, payload) => {
      events.push(payload)
    })

    manager.notifySessionCreated('missing-session')

    expect(events).toHaveLength(0)
  })
})
