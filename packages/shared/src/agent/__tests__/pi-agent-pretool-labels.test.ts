import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { PiAgent } from '../pi-agent.ts'
import type { BackendConfig } from '../backend/types.ts'
import type { LoadedSource } from '../../sources/types.ts'

let origFlag: string | undefined

beforeAll(() => {
  origFlag = process.env.CRAFT_FEATURE_CRAFT_AGENTS_CLI
  process.env.CRAFT_FEATURE_CRAFT_AGENTS_CLI = '1'
})

afterAll(() => {
  if (origFlag === undefined) {
    delete process.env.CRAFT_FEATURE_CRAFT_AGENTS_CLI
  } else {
    process.env.CRAFT_FEATURE_CRAFT_AGENTS_CLI = origFlag
  }
})

function createConfig(overrides?: {
  workspaceRootPath?: string
  workingDirectory?: string
}): BackendConfig {
  const workspaceRootPath = overrides?.workspaceRootPath ?? '/tmp/ws-root'
  const workingDirectory = overrides?.workingDirectory ?? '/tmp/project-root'

  return {
    provider: 'pi',
    workspace: {
      id: 'ws-test',
      name: 'Test Workspace',
      rootPath: workspaceRootPath,
    } as any,
    session: {
      id: 'session-test',
      workspaceRootPath,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory,
    } as any,
    isHeadless: true,
  }
}

describe('PiAgent pre-tool labels guard', () => {
  it('blocks Read on workspace labels/config.json even when session workingDirectory is outside workspace root', async () => {
    const workspaceRootPath = '/tmp/ws-root'
    const workingDirectory = '/tmp/project-root'
    const agent = new PiAgent(createConfig({ workspaceRootPath, workingDirectory }))

    const sent: Array<Record<string, unknown>> = []
    ;(agent as any).send = (message: Record<string, unknown>) => {
      sent.push(message)
    }
    ;(agent as any).emitAutomationEvent = async () => {}

    await (agent as any).handlePreToolUseRequest({
      requestId: 'req-1',
      toolName: 'Read',
      input: { file_path: `${workspaceRootPath}/labels/config.json` },
    })

    expect(sent.length).toBeGreaterThan(0)

    const response = sent.at(-1)
    expect(response?.type).toBe('pre_tool_use_response')
    expect(response?.action).toBe('block')
    expect(String(response?.reason ?? '')).toContain('craft-agent label --help')

    agent.destroy()
  })

  it('preserves the current user message when auto-activating a source', async () => {
    const agent = new PiAgent(createConfig())

    const sent: Array<Record<string, unknown>> = []
    ;(agent as any).send = (message: Record<string, unknown>) => {
      sent.push(message)
    }
    ;(agent as any).emitAutomationEvent = async () => {}
    ;(agent as any).currentUserMessage = 'linear에서 열린 이슈 찾아줘'
    ;(agent as any).onSourceActivationRequest = async () => true

    const source: LoadedSource = {
      config: {
        id: 'linear-cli-test',
        slug: 'linear-cli',
        name: 'Linear CLI',
        enabled: true,
        provider: 'linear',
        type: 'cli',
      },
      guide: null,
      manifest: null,
      folderPath: '/tmp/ws-root/sources/linear-cli',
      workspaceRootPath: '/tmp/ws-root',
      workspaceId: 'ws-test',
    }

    agent.setAllSources([source])

    await (agent as any).handlePreToolUseRequest({
      requestId: 'req-2',
      toolName: 'mcp__linear-cli__issues_search',
      input: { query: 'open issues' },
    })

    const queued = ((agent as any).eventQueue as { queue?: Array<Record<string, unknown>> }).queue ?? []
    expect(queued.length).toBeGreaterThan(0)
    expect(queued[0]?.type).toBe('source_activated')
    expect(queued[0]?.originalMessage).toBe('linear에서 열린 이슈 찾아줘')

    const response = sent.at(-1)
    expect(response?.type).toBe('pre_tool_use_response')
    expect(response?.action).toBe('allow')

    agent.destroy()
  })
})
