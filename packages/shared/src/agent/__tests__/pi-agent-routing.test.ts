import { describe, expect, it } from 'bun:test'
import { PiAgent } from '../pi-agent.ts'
import type { BackendConfig } from '../backend/types.ts'

function createConfig(): BackendConfig {
  return {
    provider: 'pi',
    providerType: 'pi',
    workspace: {
      id: 'ws-test',
      name: 'Test Workspace',
      rootPath: '/tmp/ws-root',
    } as any,
    session: {
      id: 'session-test',
      workspaceRootPath: '/tmp/ws-root',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/ws-root',
    } as any,
    isHeadless: true,
  }
}

describe('PiAgent routeToolCall unknown tool guidance', () => {
  it('returns corrective MCP naming guidance for unknown MCP tools', async () => {
    const agent = new PiAgent(createConfig())
    const result = await (agent as any).routeToolCall('mcp__linear__list_issues', {})

    expect(result.isError).toBe(true)
    expect(result.content).toContain('[ERROR] Unknown proxy tool')
    expect(result.content).toContain('mcp__sources__{slug}__{tool}')
    expect(result.content).toContain('mcp__sources__{slug}__list_tools')

    agent.destroy()
  })

  it('returns generic guidance for unknown non-MCP tools', async () => {
    const agent = new PiAgent(createConfig())
    const result = await (agent as any).routeToolCall('mystery_tool', {})

    expect(result.isError).toBe(true)
    expect(result.content).toContain('[ERROR] Unknown proxy tool')
    expect(result.content).toContain('Check the available tool list')
    expect(result.content).not.toContain('mcp__sources__{slug}__{tool}')

    agent.destroy()
  })

  it('keeps session tools routable through the stripped mcp__session__ prefix', async () => {
    const agent = new PiAgent(createConfig())
    ;(agent as any).executeSessionTool = async (toolName: string) => ({
      content: `session:${toolName}`,
      isError: false,
    })

    const result = await (agent as any).routeToolCall('mcp__session__SubmitPlan', {})

    expect(result).toEqual({ content: 'session:SubmitPlan', isError: false })

    agent.destroy()
  })
})
