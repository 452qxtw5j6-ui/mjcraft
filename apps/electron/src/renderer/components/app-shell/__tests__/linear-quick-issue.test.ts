import { describe, expect, it } from 'bun:test'
import type { LoadedSource, LlmConnectionWithStatus } from '../../../../shared/types'
import {
  buildLinearQuickIssuePrompt,
  resolveLinearQuickIssueConnection,
  resolveLinearQuickIssueDefaults,
  resolveLinearQuickIssueSourceSlug,
} from '../linear-quick-issue'

function createSource(overrides: Partial<LoadedSource> & { config?: Record<string, unknown> } = {}): LoadedSource {
  return {
    config: {
      id: 'source-1',
      slug: 'linear-cli',
      name: 'Linear CLI',
      enabled: true,
      provider: 'linear',
      type: 'cli',
      ...(overrides.config ?? {}),
    },
    folderPath: '/tmp/linear-cli',
    workspaceRootPath: '/tmp',
    workspaceId: 'ws-1',
    guide: null,
    manifest: null,
    ...overrides,
  } as LoadedSource
}

function createConnection(overrides: Partial<LlmConnectionWithStatus> = {}): LlmConnectionWithStatus {
  return {
    slug: 'chatgpt-plus',
    name: 'ChatGPT Plus',
    providerType: 'pi',
    authType: 'oauth',
    createdAt: 0,
    isAuthenticated: true,
    piAuthProvider: 'openai-codex',
    defaultModel: 'pi/gpt-5.4',
    models: [
      {
        id: 'pi/gpt-5.4',
        name: 'GPT-5.4',
        shortName: 'GPT-5.4',
        description: 'OpenAI model',
        provider: 'pi',
        contextWindow: 272000,
        supportsThinking: true,
      },
    ],
    ...overrides,
  } as LlmConnectionWithStatus
}

describe('linear quick issue helpers', () => {
  it('prefers the dedicated linear-cli source slug', () => {
    const slug = resolveLinearQuickIssueSourceSlug([
      createSource({
        config: {
          id: 'source-2',
          slug: 'something-else',
          name: 'Other',
          enabled: true,
          provider: 'notion',
          type: 'cli',
        },
      }),
      createSource(),
    ])

    expect(slug).toBe('linear-cli')
  })

  it('prefers the chatgpt-plus connection when GPT-5.4 is available', () => {
    const result = resolveLinearQuickIssueConnection([
      createConnection({ slug: 'claude-max', providerType: 'anthropic', piAuthProvider: undefined, defaultModel: 'claude-opus-4-6' }),
      createConnection(),
    ])

    expect(result).toEqual({
      llmConnection: 'chatgpt-plus',
      model: 'pi/gpt-5.4',
    })
  })

  it('prefers haiku over spark when both are available somewhere', () => {
    const result = resolveLinearQuickIssueConnection([
      createConnection({
        models: [
          {
            id: 'pi/gpt-5.4',
            name: 'GPT-5.4',
            shortName: 'GPT-5.4',
            description: 'OpenAI model',
            provider: 'pi',
            contextWindow: 272000,
            supportsThinking: true,
          },
          {
            id: 'pi/gpt-5.3-codex-spark',
            name: 'GPT-5.3 Codex Spark',
            shortName: 'Spark',
            description: 'Fast model',
            provider: 'pi',
            contextWindow: 272000,
            supportsThinking: true,
          },
        ],
      }),
      createConnection({
        slug: 'claude-max',
        providerType: 'anthropic',
        piAuthProvider: undefined,
        models: [
          {
            id: 'claude-haiku-4-5-20251001',
            name: 'Haiku 4.5',
            shortName: 'Haiku',
            description: 'Fast model',
            provider: 'anthropic',
            contextWindow: 200000,
            supportsThinking: true,
          },
        ],
        defaultModel: 'claude-haiku-4-5-20251001',
      }),
    ])

    expect(result).toEqual({
      llmConnection: 'claude-max',
      model: 'claude-haiku-4-5-20251001',
    })
  })

  it('falls back to a genuinely faster model when chatgpt-plus only exposes GPT-5.4', () => {
    const result = resolveLinearQuickIssueConnection([
      createConnection(),
      createConnection({
        slug: 'claude-max',
        providerType: 'anthropic',
        piAuthProvider: undefined,
        models: [
          {
            id: 'claude-haiku-4-5-20251001',
            name: 'Haiku 4.5',
            shortName: 'Haiku',
            description: 'Fast model',
            provider: 'anthropic',
            contextWindow: 200000,
            supportsThinking: true,
          },
        ],
        defaultModel: 'claude-haiku-4-5-20251001',
      }),
    ])

    expect(result).toEqual({
      llmConnection: 'claude-max',
      model: 'claude-haiku-4-5-20251001',
    })
  })

  it('builds defaults with low thinking and injected linear source', () => {
    const defaults = resolveLinearQuickIssueDefaults({
      llmConnections: [createConnection()],
      sources: [createSource()],
    })

    expect(defaults).toEqual({
      llmConnection: 'chatgpt-plus',
      model: 'pi/gpt-5.4',
      thinkingLevel: 'off',
      enabledSourceSlugs: ['linear-cli'],
    })
  })

  it('builds a hidden metadata prompt for Linear issue capture', () => {
    const result = buildLinearQuickIssuePrompt('Need a shortcut for instant issue capture', {
      sourceSlug: 'linear-cli',
    })

    expect(result.prompt).toContain('<linear_issue_request>')
    expect(result.prompt).toContain('<preferred_source>linear-cli</preferred_source>')
    expect(result.prompt).toContain('Need a shortcut for instant issue capture')
    expect(result.prompt).toContain('Prefer exactly one direct issues_create call')
    expect(result.prompt).toContain('Do not call help, read the CLI guide')
    expect(result.badges[0]?.label).toBe('Context')
  })
})
