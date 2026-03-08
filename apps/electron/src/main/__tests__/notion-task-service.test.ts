import { describe, it, expect, mock } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

const loggerModulePath = new URL('../logger.ts', import.meta.url).pathname
mock.module(loggerModulePath, () => ({
  default: {
    scope: () => ({
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    }),
  },
}))

const notionTaskModule = await import('../notion-task-service')
const {
  DEFAULT_NOTION_TASK_CONFIG,
  NotionTaskService,
  buildNotionPrompt,
  extractLatestAssistantReply,
  normalizeMarkdownForHash,
  truncateForPrompt,
} = notionTaskModule

interface SchedulerHarness {
  tick: (() => Promise<void>) | null
  started: boolean
  stopped: boolean
}

function createSchedulerHarness(): {
  harness: SchedulerHarness
  createScheduler: (onTick: (...args: any[]) => Promise<void>) => { start: () => void; stop: () => void }
} {
  const harness: SchedulerHarness = {
    tick: null,
    started: false,
    stopped: false,
  }

  return {
    harness,
    createScheduler: (onTick) => {
      harness.tick = onTick
      return {
        start: () => {
          harness.started = true
        },
        stop: () => {
          harness.stopped = true
        },
      }
    },
  }
}

function makeApiSource(workspaceRootPath: string, slug: string, baseUrl: string) {
  return {
    config: {
      id: slug,
      name: slug,
      slug,
      enabled: true,
      provider: slug,
      type: 'api',
      api: {
        baseUrl,
        authType: 'bearer',
        authScheme: 'Bearer',
      },
    },
    guide: null,
    folderPath: join(workspaceRootPath, 'sources', slug),
    workspaceRootPath,
    workspaceId: 'ws-1',
  } as any
}

function createCredentialManager() {
  return {
    getApiCredential: async (source: { config: { slug: string } }) =>
      source.config.slug === 'slack' ? 'slack-token' : 'notion-token',
    load: async (source: { config: { slug: string } }) => ({
      value: source.config.slug === 'slack' ? 'slack-token' : 'notion-token',
    }),
    isExpired: () => false,
    needsRefresh: () => false,
    refresh: async () => null,
    markSourceNeedsReauth: () => undefined,
  } as any
}

async function createWorkspaceRoot(configOverrides: Record<string, unknown> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'notion-task-service-'))
  const serviceDir = join(root, '.notion-ai')
  await mkdir(serviceDir, { recursive: true })
  await writeFile(
    join(serviceDir, 'config.json'),
    `${JSON.stringify({
      ...DEFAULT_NOTION_TASK_CONFIG,
      enabled: true,
      databaseId: 'db-123',
      slackChannelId: 'C123',
      ...configOverrides,
    }, null, 2)}\n`,
    'utf-8',
  )
  await writeFile(
    join(serviceDir, 'ledger.json'),
    `${JSON.stringify({ version: 1, pages: {} }, null, 2)}\n`,
    'utf-8',
  )
  return root
}

async function waitFor(assertion: () => boolean, timeoutMs = 200): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (assertion()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('Timed out waiting for condition')
}

describe('notion-task-service helpers', () => {
  it('normalizes markdown for hashing', () => {
    expect(normalizeMarkdownForHash('hello  \r\n\r\n\r\nworld\n')).toBe('hello\n\nworld')
  })

  it('truncates prompt text with ellipsis', () => {
    expect(truncateForPrompt('abcdef', 4)).toBe('abc…')
  })

  it('extracts the latest final assistant reply', () => {
    expect(extractLatestAssistantReply({
      id: 'session-1',
      messages: [
        { id: 'u1', role: 'user', content: 'hello' },
        { id: 'a1', role: 'assistant', content: 'draft', isIntermediate: true },
        { id: 'a2', role: 'assistant', content: 'final' },
      ],
    })).toBe('final')

    expect(extractLatestAssistantReply({
      id: 'session-1',
      messages: [
        { id: 'a2', role: 'assistant', content: 'final' },
      ],
    }, 'a2')).toBeNull()
  })

  it('builds a prompt with fixed output sections', () => {
    const prompt = buildNotionPrompt({
      title: 'Launch checklist',
      pageUrl: 'https://notion.so/page',
      propertiesText: '- Priority: High',
      bodyText: 'Ship it',
    })

    expect(prompt).toContain('Launch checklist')
    expect(prompt).toContain('Document properties:')
    expect(prompt).toContain('Summary')
    expect(prompt).toContain('Next Steps')
  })
})

describe('NotionTaskService polling', () => {
  it('does not fetch page details when the detector query returns no candidate', async () => {
    const workspaceRoot = await createWorkspaceRoot()
    const { harness, createScheduler } = createSchedulerHarness()
    const fetchCalls: string[] = []

    const service = new NotionTaskService({
      workspaceId: 'ws-1',
      workspaceRootPath: workspaceRoot,
      sessionManager: {
        createSession: async () => ({ id: 'unused' }),
        getSession: async () => null,
        sendMessage: async () => undefined,
      },
      deps: {
        createScheduler: createScheduler as any,
        loadSources: () => [
          makeApiSource(workspaceRoot, 'notion-api', 'https://api.notion.com/v1'),
          makeApiSource(workspaceRoot, 'slack', 'https://slack.com/api'),
        ],
        credentialManager: createCredentialManager(),
        rawCredentialManager: { get: async () => null } as any,
        fetchImpl: (async (input) => {
          const url = String(input)
          fetchCalls.push(url)

          if (url.includes('/data_sources/db-123') && !url.includes('/query')) {
            return new Response(JSON.stringify({
              properties: {
                Name: { id: 'title', type: 'title' },
                AI: { id: 'ai', type: 'checkbox' },
                'AI Status': { id: 'status', type: 'status' },
              },
            }), { status: 200 })
          }

          if (url.includes('/data_sources/db-123/query')) {
            return new Response(JSON.stringify({ results: [] }), { status: 200 })
          }

          throw new Error(`Unexpected URL: ${url}`)
        }) as typeof fetch,
      },
    })

    try {
      await service.start()
      expect(harness.started).toBe(true)
      await harness.tick?.()
      await waitFor(() => fetchCalls.some(url => url.includes('/query')))

      expect(fetchCalls.filter(url => url.includes('/data_sources/db-123/query')).length).toBe(1)
      expect(fetchCalls.some(url => url.includes('/pages/page-1'))).toBe(false)
    } finally {
      await service.stop()
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('claims a candidate, creates a session, posts to Slack, and writes ledger state', async () => {
    const workspaceRoot = await createWorkspaceRoot()
    const { harness, createScheduler } = createSchedulerHarness()
    const fetchCalls: string[] = []
    const pageUpdates: Array<Record<string, unknown>> = []
    const slackBodies: Array<Record<string, unknown>> = []
    const createdSessions: Array<Record<string, unknown> | undefined> = []
    let sendCount = 0

    const service = new NotionTaskService({
      workspaceId: 'ws-1',
      workspaceRootPath: workspaceRoot,
      sessionManager: {
        createSession: async (_workspaceId, options) => {
          createdSessions.push(options)
          return { id: 'session-1', messages: [] }
        },
        getSession: async () => ({
          id: 'session-1',
          messages: [
            { id: 'a1', role: 'assistant', content: 'Summary\nWork Performed\nRisks\nNext Steps' },
          ],
        }),
        sendMessage: async () => {
          sendCount += 1
        },
      },
      deps: {
        createScheduler: createScheduler as any,
        loadSources: () => [
          makeApiSource(workspaceRoot, 'notion-api', 'https://api.notion.com/v1'),
          makeApiSource(workspaceRoot, 'slack', 'https://slack.com/api'),
        ],
        credentialManager: createCredentialManager(),
        rawCredentialManager: { get: async () => null } as any,
        fetchImpl: (async (input, init) => {
          const url = String(input)
          fetchCalls.push(url)

          if (url.includes('/data_sources/db-123') && !url.includes('/query')) {
            return new Response(JSON.stringify({
              properties: {
                Name: { id: 'title', type: 'title' },
                Priority: { id: 'priority', type: 'select' },
                AI: { id: 'ai', type: 'checkbox' },
                'AI Status': { id: 'status', type: 'status' },
                'Claimed At': { id: 'claimed', type: 'date' },
                'Processed At': { id: 'processed', type: 'date' },
                'Craft Session ID': { id: 'session', type: 'rich_text' },
                'Slack Report URL': { id: 'slack_url', type: 'url' },
                'AI Summary': { id: 'summary', type: 'rich_text' },
              },
            }), { status: 200 })
          }

          if (url.includes('/data_sources/db-123/query')) {
            return new Response(JSON.stringify({
              results: [
                { id: 'page-1', last_edited_time: '2026-03-06T12:00:00.000Z' },
              ],
            }), { status: 200 })
          }

          if (url.includes('/pages/page-1/markdown')) {
            return new Response(JSON.stringify({ markdown: 'Main body from Notion' }), { status: 200 })
          }

          if (url.includes('/pages/page-1') && init?.method === 'GET') {
            return new Response(JSON.stringify({
              id: 'page-1',
              url: 'https://notion.so/page-1',
              last_edited_time: '2026-03-06T12:00:00.000Z',
              properties: {
                Name: { id: 'title', type: 'title', title: [{ plain_text: 'Quarterly review' }] },
                Priority: { id: 'priority', type: 'select', select: { name: 'High' } },
                AI: { id: 'ai', type: 'checkbox', checkbox: true },
                'AI Status': { id: 'status', type: 'status', status: { name: 'Queued' } },
                'Claimed At': { id: 'claimed', type: 'date', date: null },
                'Processed At': { id: 'processed', type: 'date', date: null },
                'Craft Session ID': { id: 'session', type: 'rich_text', rich_text: [] },
                'Slack Report URL': { id: 'slack_url', type: 'url', url: null },
                'AI Summary': { id: 'summary', type: 'rich_text', rich_text: [] },
              },
            }), { status: 200 })
          }

          if (url.includes('/pages/page-1') && init?.method === 'PATCH') {
            const body = JSON.parse(String(init.body))
            pageUpdates.push(body)
            return new Response(JSON.stringify({ ok: true }), { status: 200 })
          }

          if (url.includes('/chat.postMessage')) {
            slackBodies.push(JSON.parse(String(init?.body)))
            return new Response(JSON.stringify({ ok: true, ts: '1700.01' }), { status: 200 })
          }

          if (url.includes('/chat.getPermalink')) {
            return new Response(JSON.stringify({ ok: true, permalink: 'https://slack.example/message' }), { status: 200 })
          }

          throw new Error(`Unexpected URL: ${url}`)
        }) as typeof fetch,
      },
    })

    try {
      await service.start()
      await harness.tick?.()
      await waitFor(() => pageUpdates.length >= 2)

      expect(sendCount).toBe(1)
      expect(createdSessions[0]).toMatchObject({
        name: 'Notion AI: Quarterly review',
        permissionMode: 'allow-all',
        labels: ['project::notion-ai'],
        sessionOrigin: 'notion',
        notionRef: {
          pageId: 'page-1',
          dataSourceId: 'db-123',
          pageUrl: 'https://notion.so/page-1',
        },
      })
      expect(fetchCalls.filter(url => url.includes('/data_sources/db-123/query')).length).toBe(1)
      expect(fetchCalls.some(url => url.includes('/pages/page-1/markdown'))).toBe(true)
      expect(slackBodies[0]).toMatchObject({
        channel: 'C123',
        text: expect.stringContaining('*Notion AI Task Started*'),
      })
      expect(slackBodies[0]?.thread_ts).toBeUndefined()
      expect(slackBodies[1]).toMatchObject({
        channel: 'C123',
        thread_ts: '1700.01',
        text: expect.stringContaining('*Notion AI Task Update*'),
      })
      expect(pageUpdates[0]).toMatchObject({
        properties: {
          'AI Status': { status: { name: 'Running' } },
          'Craft Session ID': {
            rich_text: [{ type: 'text', text: { content: 'session-1' } }],
          },
          'Slack Report URL': { url: 'https://slack.example/message' },
        },
      })
      expect(pageUpdates[1]).toMatchObject({
        properties: {
          'AI Status': { status: { name: 'Done' } },
          'Craft Session ID': {
            rich_text: [{ type: 'text', text: { content: 'session-1' } }],
          },
          'Slack Report URL': { url: 'https://slack.example/message' },
        },
      })

      const ledgerRaw = await readFile(join(workspaceRoot, '.notion-ai', 'ledger.json'), 'utf-8')
      const ledger = JSON.parse(ledgerRaw) as { pages: Record<string, { sessionId?: string; status?: string }> }
      expect(ledger.pages['page-1']).toMatchObject({
        sessionId: 'session-1',
        status: 'done',
      })
    } finally {
      await service.stop()
      expect(harness.stopped).toBe(true)
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('reuses an existing active notion-linked session and replies in its slack thread', async () => {
    const workspaceRoot = await createWorkspaceRoot()
    const { harness, createScheduler } = createSchedulerHarness()
    const slackBodies: Array<Record<string, unknown>> = []
    let createCount = 0
    let sendCount = 0

    const service = new NotionTaskService({
      workspaceId: 'ws-1',
      workspaceRootPath: workspaceRoot,
      sessionManager: {
        createSession: async () => {
          createCount += 1
          return { id: 'session-new', messages: [] }
        },
        findSessionByNotionPage: async () => ({
          id: 'session-existing',
          sessionOrigin: 'notion',
          notionRef: { pageId: 'page-1', dataSourceId: 'db-123', pageUrl: 'https://notion.so/page-1' },
          slackRef: { channelId: 'C123', threadTs: 'thread-1', rootMessageTs: 'thread-1', permalink: 'https://slack.example/thread-1' },
          messages: [],
        }),
        getSession: async () => ({
          id: 'session-existing',
          sessionOrigin: 'notion',
          notionRef: { pageId: 'page-1', dataSourceId: 'db-123', pageUrl: 'https://notion.so/page-1' },
          slackRef: { channelId: 'C123', threadTs: 'thread-1', rootMessageTs: 'thread-1', permalink: 'https://slack.example/thread-1' },
          messages: [{ id: 'a1', role: 'assistant', content: 'Summary\nWork Performed\nRisks\nNext Steps' }],
        }),
        sendMessage: async () => {
          sendCount += 1
        },
      },
      deps: {
        createScheduler: createScheduler as any,
        loadSources: () => [
          makeApiSource(workspaceRoot, 'notion-api', 'https://api.notion.com/v1'),
          makeApiSource(workspaceRoot, 'slack', 'https://slack.com/api'),
        ],
        credentialManager: createCredentialManager(),
        rawCredentialManager: { get: async () => null } as any,
        fetchImpl: (async (input, init) => {
          const url = String(input)
          if (url.includes('/data_sources/db-123') && !url.includes('/query')) {
            return new Response(JSON.stringify({
              properties: {
                Name: { id: 'title', type: 'title' },
                AI: { id: 'ai', type: 'checkbox' },
                'AI Status': { id: 'status', type: 'status' },
                'Claimed At': { id: 'claimed', type: 'date' },
                'Processed At': { id: 'processed', type: 'date' },
                'Craft Session ID': { id: 'session', type: 'rich_text' },
                'Slack Report URL': { id: 'slack_url', type: 'url' },
                'AI Summary': { id: 'summary', type: 'rich_text' },
              },
            }), { status: 200 })
          }
          if (url.includes('/data_sources/db-123/query')) {
            return new Response(JSON.stringify({
              results: [{ id: 'page-1', last_edited_time: '2026-03-06T12:00:00.000Z' }],
            }), { status: 200 })
          }
          if (url.includes('/pages/page-1/markdown')) {
            return new Response(JSON.stringify({ markdown: 'Body content' }), { status: 200 })
          }
          if (url.includes('/pages/page-1') && init?.method === 'GET') {
            return new Response(JSON.stringify({
              id: 'page-1',
              url: 'https://notion.so/page-1',
              last_edited_time: '2026-03-06T12:00:00.000Z',
              properties: {
                Name: { id: 'title', type: 'title', title: [{ plain_text: 'Reuse me' }] },
                AI: { id: 'ai', type: 'checkbox', checkbox: true },
                'AI Status': { id: 'status', type: 'status', status: { name: 'Queued' } },
                'Claimed At': { id: 'claimed', type: 'date', date: null },
                'Processed At': { id: 'processed', type: 'date', date: null },
                'Craft Session ID': { id: 'session', type: 'rich_text', rich_text: [] },
                'Slack Report URL': { id: 'slack_url', type: 'url', url: null },
                'AI Summary': { id: 'summary', type: 'rich_text', rich_text: [] },
              },
            }), { status: 200 })
          }
          if (url.includes('/pages/page-1') && init?.method === 'PATCH') {
            return new Response(JSON.stringify({ ok: true }), { status: 200 })
          }
          if (url.includes('/chat.postMessage')) {
            slackBodies.push(JSON.parse(String(init?.body)))
            return new Response(JSON.stringify({ ok: true, ts: 'reply-1' }), { status: 200 })
          }
          throw new Error(`Unexpected URL: ${url}`)
        }) as typeof fetch,
      },
    })

    try {
      await service.start()
      await harness.tick?.()
      await waitFor(() => slackBodies.length === 1)

      expect(createCount).toBe(0)
      expect(sendCount).toBe(1)
      expect(slackBodies[0]).toMatchObject({
        channel: 'C123',
        thread_ts: 'thread-1',
        text: expect.stringContaining('*Notion AI Task Update*'),
      })
    } finally {
      await service.stop()
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('reuses an existing notion-linked session even when slackRef must be created during kickoff', async () => {
    const workspaceRoot = await createWorkspaceRoot()
    const { harness, createScheduler } = createSchedulerHarness()
    const slackBodies: Array<Record<string, unknown>> = []
    let createCount = 0
    let linkedSlackRef: Record<string, unknown> | null = null

    const service = new NotionTaskService({
      workspaceId: 'ws-1',
      workspaceRootPath: workspaceRoot,
      sessionManager: {
        createSession: async () => {
          createCount += 1
          return { id: 'session-new', messages: [] }
        },
        findSessionByNotionPage: async () => ({
          id: 'session-existing',
          sessionOrigin: 'notion',
          notionRef: { pageId: 'page-1', dataSourceId: 'db-123', pageUrl: 'https://notion.so/page-1' },
          messages: [],
        }),
        linkSessionToSlack: async (_sessionId, slackRef) => {
          linkedSlackRef = slackRef as Record<string, unknown>
        },
        getSession: async () => ({
          id: 'session-existing',
          sessionOrigin: 'notion',
          notionRef: { pageId: 'page-1', dataSourceId: 'db-123', pageUrl: 'https://notion.so/page-1' },
          slackRef: { channelId: 'C123', threadTs: '1700.01', rootMessageTs: '1700.01', permalink: 'https://slack.example/thread' },
          messages: [{ id: 'a1', role: 'assistant', content: 'Summary\nWork Performed\nRisks\nNext Steps' }],
        }),
        sendMessage: async () => undefined,
      },
      deps: {
        createScheduler: createScheduler as any,
        loadSources: () => [
          makeApiSource(workspaceRoot, 'notion-api', 'https://api.notion.com/v1'),
          makeApiSource(workspaceRoot, 'slack', 'https://slack.com/api'),
        ],
        credentialManager: createCredentialManager(),
        rawCredentialManager: { get: async () => null } as any,
        fetchImpl: (async (input, init) => {
          const url = String(input)
          if (url.includes('/data_sources/db-123') && !url.includes('/query')) {
            return new Response(JSON.stringify({
              properties: {
                Name: { id: 'title', type: 'title' },
                AI: { id: 'ai', type: 'checkbox' },
                'AI Status': { id: 'status', type: 'status' },
                'Claimed At': { id: 'claimed', type: 'date' },
                'Processed At': { id: 'processed', type: 'date' },
                'Craft Session ID': { id: 'session', type: 'rich_text' },
                'Slack Report URL': { id: 'slack_url', type: 'url' },
                'AI Summary': { id: 'summary', type: 'rich_text' },
              },
            }), { status: 200 })
          }
          if (url.includes('/data_sources/db-123/query')) {
            return new Response(JSON.stringify({
              results: [{ id: 'page-1', last_edited_time: '2026-03-06T12:00:00.000Z' }],
            }), { status: 200 })
          }
          if (url.includes('/pages/page-1/markdown')) {
            return new Response(JSON.stringify({ markdown: 'Body content' }), { status: 200 })
          }
          if (url.includes('/pages/page-1') && init?.method === 'GET') {
            return new Response(JSON.stringify({
              id: 'page-1',
              url: 'https://notion.so/page-1',
              last_edited_time: '2026-03-06T12:00:00.000Z',
              properties: {
                Name: { id: 'title', type: 'title', title: [{ plain_text: 'Reuse kickoff' }] },
                AI: { id: 'ai', type: 'checkbox', checkbox: true },
                'AI Status': { id: 'status', type: 'status', status: { name: 'Queued' } },
                'Claimed At': { id: 'claimed', type: 'date', date: null },
                'Processed At': { id: 'processed', type: 'date', date: null },
                'Craft Session ID': { id: 'session', type: 'rich_text', rich_text: [] },
                'Slack Report URL': { id: 'slack_url', type: 'url', url: null },
                'AI Summary': { id: 'summary', type: 'rich_text', rich_text: [] },
              },
            }), { status: 200 })
          }
          if (url.includes('/pages/page-1') && init?.method === 'PATCH') {
            return new Response(JSON.stringify({ ok: true }), { status: 200 })
          }
          if (url.includes('/chat.postMessage')) {
            slackBodies.push(JSON.parse(String(init?.body)))
            return new Response(JSON.stringify({ ok: true, ts: '1700.01' }), { status: 200 })
          }
          if (url.includes('/chat.getPermalink')) {
            return new Response(JSON.stringify({ ok: true, permalink: 'https://slack.example/thread' }), { status: 200 })
          }
          throw new Error(`Unexpected URL: ${url}`)
        }) as typeof fetch,
      },
    })

    try {
      await service.start()
      await harness.tick?.()
      await waitFor(() => slackBodies.length >= 1)

      expect(createCount).toBe(0)
      expect(linkedSlackRef).toMatchObject({
        channelId: 'C123',
        threadTs: '1700.01',
        rootMessageTs: '1700.01',
      })
      expect(slackBodies[0]).toMatchObject({
        channel: 'C123',
        text: expect.stringContaining('*Notion AI Task Started*'),
      })
    } finally {
      await service.stop()
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('marks the Notion row failed when kickoff slack permalink creation fails before agent execution', async () => {
    const workspaceRoot = await createWorkspaceRoot()
    const { harness, createScheduler } = createSchedulerHarness()
    const pageUpdates: Array<Record<string, unknown>> = []
    let sendCount = 0

    const service = new NotionTaskService({
      workspaceId: 'ws-1',
      workspaceRootPath: workspaceRoot,
      sessionManager: {
        createSession: async () => ({ id: 'session-1', messages: [] }),
        getSession: async () => null,
        sendMessage: async () => {
          sendCount += 1
        },
        linkSessionToSlack: async () => undefined,
        linkSessionToNotion: async () => undefined,
      },
      deps: {
        createScheduler: createScheduler as any,
        loadSources: () => [
          makeApiSource(workspaceRoot, 'notion-api', 'https://api.notion.com/v1'),
          makeApiSource(workspaceRoot, 'slack', 'https://slack.com/api'),
        ],
        credentialManager: createCredentialManager(),
        rawCredentialManager: { get: async () => null } as any,
        fetchImpl: (async (input, init) => {
          const url = String(input)
          if (url.includes('/data_sources/db-123') && !url.includes('/query')) {
            return new Response(JSON.stringify({
              properties: {
                Name: { id: 'title', type: 'title' },
                AI: { id: 'ai', type: 'checkbox' },
                'AI Status': { id: 'status', type: 'status' },
                'Claimed At': { id: 'claimed', type: 'date' },
                'Processed At': { id: 'processed', type: 'date' },
                'Craft Session ID': { id: 'session', type: 'rich_text' },
                'Slack Report URL': { id: 'slack_url', type: 'url' },
                'AI Summary': { id: 'summary', type: 'rich_text' },
              },
            }), { status: 200 })
          }
          if (url.includes('/data_sources/db-123/query')) {
            return new Response(JSON.stringify({
              results: [{ id: 'page-1', last_edited_time: '2026-03-06T12:00:00.000Z' }],
            }), { status: 200 })
          }
          if (url.includes('/pages/page-1/markdown')) {
            return new Response(JSON.stringify({ markdown: 'Body content' }), { status: 200 })
          }
          if (url.includes('/pages/page-1') && init?.method === 'GET') {
            return new Response(JSON.stringify({
              id: 'page-1',
              url: 'https://notion.so/page-1',
              last_edited_time: '2026-03-06T12:00:00.000Z',
              properties: {
                Name: { id: 'title', type: 'title', title: [{ plain_text: 'Kickoff failure' }] },
                AI: { id: 'ai', type: 'checkbox', checkbox: true },
                'AI Status': { id: 'status', type: 'status', status: { name: 'Queued' } },
                'Claimed At': { id: 'claimed', type: 'date', date: null },
                'Processed At': { id: 'processed', type: 'date', date: null },
                'Craft Session ID': { id: 'session', type: 'rich_text', rich_text: [] },
                'Slack Report URL': { id: 'slack_url', type: 'url', url: null },
                'AI Summary': { id: 'summary', type: 'rich_text', rich_text: [] },
              },
            }), { status: 200 })
          }
          if (url.includes('/pages/page-1') && init?.method === 'PATCH') {
            pageUpdates.push(JSON.parse(String(init.body)))
            return new Response(JSON.stringify({ ok: true }), { status: 200 })
          }
          if (url.includes('/chat.postMessage')) {
            return new Response(JSON.stringify({ ok: true, ts: '1700.01' }), { status: 200 })
          }
          if (url.includes('/chat.getPermalink')) {
            return new Response(JSON.stringify({ ok: false, error: 'invalid_arguments' }), { status: 200 })
          }
          throw new Error(`Unexpected URL: ${url}`)
        }) as typeof fetch,
      },
    })

    try {
      await service.start()
      await harness.tick?.()
      await waitFor(() => pageUpdates.length >= 1)

      expect(sendCount).toBe(0)
      expect(pageUpdates[0]).toMatchObject({
        properties: {
          'AI Status': { status: { name: 'Failed' } },
        },
      })
    } finally {
      await service.stop()
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('skips reprocessing when the ledger already contains the same last_edited_time', async () => {
    const workspaceRoot = await createWorkspaceRoot()
    const { harness, createScheduler } = createSchedulerHarness()
    const pageUpdates: Array<Record<string, unknown>> = []
    let sendCount = 0

    await writeFile(
      join(workspaceRoot, '.notion-ai', 'ledger.json'),
      `${JSON.stringify({
        version: 1,
        pages: {
          'page-1': {
            lastProcessedEditedTime: '2026-03-06T12:00:00.000Z',
            contentHash: 'existing-hash',
            sessionId: 'session-existing',
            status: 'done',
            processedAt: '2026-03-06T12:30:00.000Z',
          },
        },
      }, null, 2)}\n`,
      'utf-8',
    )

    const service = new NotionTaskService({
      workspaceId: 'ws-1',
      workspaceRootPath: workspaceRoot,
      sessionManager: {
        createSession: async () => ({ id: 'session-new' }),
        getSession: async () => null,
        sendMessage: async () => {
          sendCount += 1
        },
      },
      deps: {
        createScheduler: createScheduler as any,
        loadSources: () => [
          makeApiSource(workspaceRoot, 'notion-api', 'https://api.notion.com/v1'),
          makeApiSource(workspaceRoot, 'slack', 'https://slack.com/api'),
        ],
        credentialManager: createCredentialManager(),
        rawCredentialManager: { get: async () => null } as any,
        fetchImpl: (async (input, init) => {
          const url = String(input)

          if (url.includes('/data_sources/db-123') && !url.includes('/query')) {
            return new Response(JSON.stringify({
              properties: {
                Name: { id: 'title', type: 'title' },
                AI: { id: 'ai', type: 'checkbox' },
                'AI Status': { id: 'status', type: 'status' },
                'Processed At': { id: 'processed', type: 'date' },
                'Craft Session ID': { id: 'session', type: 'rich_text' },
                'AI Summary': { id: 'summary', type: 'rich_text' },
              },
            }), { status: 200 })
          }

          if (url.includes('/data_sources/db-123/query')) {
            return new Response(JSON.stringify({
              results: [
                { id: 'page-1', last_edited_time: '2026-03-06T12:00:00.000Z' },
              ],
            }), { status: 200 })
          }

          if (url.includes('/pages/page-1/markdown')) {
            return new Response(JSON.stringify({ markdown: 'Body content' }), { status: 200 })
          }

          if (url.includes('/pages/page-1') && init?.method === 'GET') {
            return new Response(JSON.stringify({
              id: 'page-1',
              url: 'https://notion.so/page-1',
              last_edited_time: '2026-03-06T12:00:00.000Z',
              properties: {
                Name: { id: 'title', type: 'title', title: [{ plain_text: 'Repeat me' }] },
                AI: { id: 'ai', type: 'checkbox', checkbox: true },
                'AI Status': { id: 'status', type: 'status', status: { name: 'Queued' } },
                'Processed At': { id: 'processed', type: 'date', date: null },
                'Craft Session ID': { id: 'session', type: 'rich_text', rich_text: [] },
                'AI Summary': { id: 'summary', type: 'rich_text', rich_text: [] },
              },
            }), { status: 200 })
          }

          if (url.includes('/pages/page-1') && init?.method === 'PATCH') {
            const body = JSON.parse(String(init.body))
            pageUpdates.push(body)
            return new Response(JSON.stringify({ ok: true }), { status: 200 })
          }

          throw new Error(`Unexpected URL: ${url}`)
        }) as typeof fetch,
      },
    })

    try {
      await service.start()
      await harness.tick?.()
      await waitFor(() => pageUpdates.length === 1)

      expect(sendCount).toBe(0)
      expect(pageUpdates[0]).toMatchObject({
        properties: {
          'AI Status': { status: { name: 'Done' } },
          'Craft Session ID': {
            rich_text: [{ type: 'text', text: { content: 'session-existing' } }],
          },
        },
      })
    } finally {
      await service.stop()
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })
})
