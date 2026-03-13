import { describe, it, expect } from 'bun:test'
import { getSystemPrompt } from '../system'

describe('system prompt guidance', () => {
  it('uses backend-neutral debug log querying guidance (rg/grep via Bash)', () => {
    const prompt = getSystemPrompt(
      undefined,
      { enabled: true, logFilePath: '/tmp/main.log' },
      '/tmp/workspace',
      '/tmp/workspace'
    )

    expect(prompt).toContain('Use Bash with `rg`/`grep` to search logs efficiently:')
    expect(prompt).toContain('rg -n "session" "/tmp/main.log"')
    expect(prompt).not.toContain('Use the Grep tool (if available)')
    expect(prompt).not.toContain('Grep pattern=')
  })

  it('does not mention Grep in call_llm tool-dependency guidance', () => {
    const prompt = getSystemPrompt(undefined, undefined, '/tmp/workspace', '/tmp/workspace')

    expect(prompt).toContain('The subtask needs file/shell tools (for example, Read or Bash)')
    expect(prompt).not.toContain('The subtask needs tools (Read, Bash, Grep)')
  })

  it('gates prompt guidance sections independently', () => {
    const prompt = getSystemPrompt(
      undefined,
      undefined,
      '/tmp/workspace',
      '/tmp/workspace',
      'default',
      'Craft Agents Backend',
      {
        submitPlanGuide: true,
        mcpNamingGuide: false,
        sourceManagementGuide: false,
        livePlanningGuide: false,
      },
    )

    expect(prompt).toContain('### Planning Tools')
    expect(prompt).toContain('**`SubmitPlan`**')
    expect(prompt).not.toContain('**`update_plan`**')
    expect(prompt).not.toContain('## MCP Tool Naming')
    expect(prompt).not.toContain('## Source Management Tools')
  })

  it('keeps legacy Codex callers fully enabled by default', () => {
    const prompt = getSystemPrompt(
      undefined,
      undefined,
      '/tmp/workspace',
      '/tmp/workspace',
      'default',
      'Codex',
    )

    expect(prompt).toContain('**`SubmitPlan`**')
    expect(prompt).toContain('**`update_plan`**')
    expect(prompt).toContain('## MCP Tool Naming')
    expect(prompt).toContain('## Source Management Tools')
  })

  it('uses the GPT-5.4 Pi prompt profile without update_plan guidance', () => {
    const prompt = getSystemPrompt(
      undefined,
      undefined,
      '/tmp/workspace',
      '/tmp/workspace',
      'default',
      'Craft Agents Backend',
      {
        submitPlanGuide: true,
        mcpNamingGuide: true,
        sourceManagementGuide: true,
        livePlanningGuide: false,
      },
    )

    expect(prompt).toContain('**`SubmitPlan`**')
    expect(prompt).toContain('## MCP Tool Naming')
    expect(prompt).toContain('mcp__sources__{slug}__{tool}')
    expect(prompt).toContain('## Source Management Tools')
    expect(prompt).toContain('Do NOT keep running `source_test` to check')
    expect(prompt).not.toContain('**`update_plan`**')
    expect(prompt).not.toContain('Start multi-step work with `update_plan`.')
  })
})
