import { describe, expect, it, mock } from 'bun:test'
import { SessionManager, createManagedSession } from './SessionManager.ts'

const workspace = {
  id: 'ws_test',
  name: 'Test Workspace',
  rootPath: '/tmp/test-workspace',
  createdAt: Date.now(),
}

function createMockAgent(provider: 'pi' | 'anthropic') {
  return {
    config: { provider },
    dispose: mock(() => {}),
    setSessionId: mock(() => {}),
  }
}

describe('SessionManager Pi agent cleanup', () => {
  it('disposes idle Pi agents when processing stops and no queue remains', async () => {
    const manager = new SessionManager()
    const managed = createManagedSession({
      id: 'session-pi',
      llmConnection: 'chatgpt-plus',
      isProcessing: true,
      messages: [],
    } as any, workspace as any, {
      messages: [],
      isProcessing: true,
      messageQueue: [],
    })

    const agent = createMockAgent('pi')
    managed.agent = agent as any

    ;(manager as any).sessions.set(managed.id, managed)
    ;(manager as any).sendEvent = () => {}
    ;(manager as any).persistSession = () => {}
    ;(manager as any).emitUnreadSummaryChanged = () => {}

    await (manager as any).onProcessingStopped(managed.id, 'complete')

    expect(agent.dispose).toHaveBeenCalledTimes(1)
    expect(managed.agent).toBeNull()
  })

  it('cleanup disposes any remaining live agents', () => {
    const manager = new SessionManager()
    const managed = createManagedSession({
      id: 'session-anthropic',
      llmConnection: 'claude-max',
      messages: [],
    } as any, workspace as any)

    const agent = createMockAgent('anthropic')
    managed.agent = agent as any

    ;(manager as any).sessions.set(managed.id, managed)

    manager.cleanup()

    expect(agent.dispose).toHaveBeenCalledTimes(1)
    expect(managed.agent).toBeNull()
  })
})
