import { describe, expect, it } from 'bun:test'
import { NotionTaskService, type NotionTaskConfig } from '../notion-task-service'

function createConfig(): NotionTaskConfig {
  return {
    enabled: true,
    pollCron: '*/5 * * * *',
    databaseId: 'db-1',
    notionSourceSlug: 'notion',
    slackSourceSlug: 'slack',
    slackChannelId: '#ops-ai',
    trigger: {
      property: 'AI',
      type: 'checkbox',
      value: true,
    },
    status: {
      property: 'Status',
      type: 'status',
      readyValues: ['Ready'],
      runningValue: 'In Progress',
      doneValue: 'Done',
      failedValue: 'Blocked',
    },
    properties: {
      claimedAt: 'AI Claimed At',
      processedAt: 'AI Processed At',
      sessionId: 'AI Session ID',
      slackUrl: 'AI Slack URL',
      summary: 'AI Summary',
    },
    session: {
      permissionMode: 'allow-all',
      labels: [],
      workingDirectory: 'user_default',
    },
    limits: {
      maxPageChars: 10000,
      maxConcurrent: 1,
    },
  }
}

function createService(overrides?: {
  createSlackGateway?: (_sourceSlug: string) => {
    postMessage: (args: { channel: string; text: string; threadTs?: string }) => Promise<{ ts: string; channel?: string }>
    updateMessage: (args: { channel: string; ts: string; text: string }) => Promise<void>
    getPermalink: (args: { channel: string; messageTs: string }) => Promise<string>
  }
  logger?: {
    info: (...args: unknown[]) => void
    warn: (...args: unknown[]) => void
    error: (...args: unknown[]) => void
  }
  sessionManager?: Record<string, unknown>
}): NotionTaskService {
  return new NotionTaskService({
    workspaceId: 'ws-1',
    workspaceRootPath: '/tmp/ws-1',
    sessionManager: {
      createSession: async () => ({ id: 'sess-1', messages: [] }),
      getSession: async () => ({ id: 'sess-1', messages: [] }),
      sendMessage: async () => {},
      ...overrides?.sessionManager,
    } as any,
    deps: {
      createSlackGateway: overrides?.createSlackGateway ?? ((_sourceSlug: string) => ({
        postMessage: async () => ({ ts: '1710000000.100' }),
        updateMessage: async () => {},
        getPermalink: async () => 'https://slack.example/permalink',
      })),
      logger: overrides?.logger ?? {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    },
  })
}

describe('NotionTaskService Slack kickoff', () => {
  it('uses the resolved Slack channel from postMessage for permalink lookup', async () => {
    const permalinkCalls: Array<{ channel: string; messageTs: string }> = []
    const service = createService({
      createSlackGateway: () => ({
        postMessage: async () => ({ ts: '1710000000.100', channel: 'C024BE91L' }),
        updateMessage: async () => {},
        getPermalink: async (args) => {
          permalinkCalls.push(args)
          return 'https://slack.example/permalink'
        },
      }),
    })

    const kickoff = await (service as any).createSlackKickoff(createConfig(), 'Task title', 'https://notion.so/page', 'sess-1')

    expect(permalinkCalls).toEqual([{ channel: 'C024BE91L', messageTs: '1710000000.100' }])
    expect(kickoff.slackRef.channelId).toBe('C024BE91L')
    expect(kickoff.slackRef.permalink).toBe('https://slack.example/permalink')
    expect(kickoff.permalinkError).toBeUndefined()
  })

  it('continues processing when permalink lookup fails', async () => {
    const warnings: unknown[][] = []
    let notifySessionCreatedCount = 0
    let sendMessageCount = 0
    const session = {
      id: 'sess-1',
      messages: [] as Array<{ id: string; role: string; content: string; isIntermediate?: boolean }>,
    }
    const service = createService({
      createSlackGateway: () => ({
        postMessage: async () => ({ ts: '1710000000.100', channel: 'C024BE91L' }),
        updateMessage: async () => {},
        getPermalink: async () => {
          throw new Error('Slack chat.getPermalink failed: invalid_arguments')
        },
      }),
      logger: {
        info: () => {},
        warn: (...args: unknown[]) => { warnings.push(args) },
        error: () => {},
      },
      sessionManager: {
        findSessionByNotionPage: async () => null,
        createSession: async () => session,
        getSession: async () => session,
        sendMessage: async () => {
          sendMessageCount += 1
          session.messages = [
            { id: 'user-1', role: 'user', content: 'prompt' },
            { id: 'assistant-1', role: 'assistant', content: 'final reply' },
          ]
        },
        notifySessionCreated: () => {
          notifySessionCreatedCount += 1
        },
        linkSessionToNotion: async () => {},
        linkSessionToSlack: async () => {},
      },
    })

    ;(service as any).loadRuntimeConfig = async () => ({
      config: createConfig(),
      sources: {
        notion: { config: { slug: 'notion' } },
        slack: { config: { slug: 'slack' } },
      },
      schema: {
        loadedAt: Date.now(),
        databaseId: 'db-1',
        titlePropertyName: 'Name',
        titlePropertyId: 'title',
        propertiesByName: new Map(),
        propertiesById: new Map(),
      },
    })
    ;(service as any).fetchPage = async () => ({
      id: 'page-1',
      url: 'https://notion.so/page-1',
      lastEditedTime: '2026-03-09T00:00:00.000Z',
      properties: {},
    })
    ;(service as any).extractPageTitle = () => 'Task title'
    ;(service as any).fetchPageContent = async () => ({
      markdown: 'Task body',
      source: 'markdown',
    })
    ;(service as any).readLedger = async () => ({ version: 1, pages: {} })
    ;(service as any).markRowClaimed = async () => {}
    ;(service as any).markRowDone = async () => {}
    ;(service as any).markRowFailed = async () => {
      throw new Error('markRowFailed should not be called')
    }
    ;(service as any).postSlackSuccess = async () => {}

    await (service as any).processCandidate('page-1', 'manual')

    expect(sendMessageCount).toBe(1)
    expect(notifySessionCreatedCount).toBe(1)
    expect(warnings).toHaveLength(1)
    expect(String(warnings[0]?.[0])).toContain('slack permalink lookup failed; continuing without permalink')
  })
})

describe('NotionTaskService scheduler', () => {
  it('honors the configured poll cron instead of the default cron', async () => {
    const service = createService()
    const now = new Date()
    const nextMinute = new Date(now.getTime() + 60_000)
    const matchingCron = `${now.getMinutes()} ${now.getHours()} ${now.getDate()} ${now.getMonth() + 1} *`
    const nonMatchingCron = `${nextMinute.getMinutes()} ${nextMinute.getHours()} ${nextMinute.getDate()} ${nextMinute.getMonth() + 1} *`

    let loadRuntimeCount = 0
    let drainQueueCount = 0

    ;(service as any).readConfig = async () => ({ ...createConfig(), pollCron: nonMatchingCron })
    ;(service as any).loadRuntimeConfig = async () => {
      loadRuntimeCount += 1
      return { config: createConfig() }
    }

    await (service as any).onSchedulerTick({} as any)
    expect(loadRuntimeCount).toBe(0)

    ;(service as any).readConfig = async () => ({ ...createConfig(), pollCron: matchingCron })
    ;(service as any).loadRuntimeConfig = async () => {
      loadRuntimeCount += 1
      return { config: createConfig() }
    }
    ;(service as any).findNextCandidate = async () => ({ id: 'page-1' })
    ;(service as any).drainQueue = async () => {
      drainQueueCount += 1
    }

    await (service as any).onSchedulerTick({} as any)

    expect(loadRuntimeCount).toBe(1)
    expect(drainQueueCount).toBe(1)
  })
})
