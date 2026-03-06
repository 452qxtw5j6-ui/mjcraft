import { describe, it, expect, mock } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

mock.module('@slack/bolt', () => ({
  App: class {
    event(): void {}
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
  },
}))
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

const slackBotModule = await import('../slack-bot')
const {
  computeThreadRootTs,
  buildSlackSessionKey,
  isPlainUserMessage,
  toSlackMessageEvent,
  SlackBotService,
  SLACK_PROCESSING_MESSAGES,
  stripAppMentionText,
  splitSlackMessage,
  getLatestAssistantReply,
} = slackBotModule

const DEFAULT_SLACK_CONFIG = {
  enabled: true,
  testerUserIds: ['U1'],
  permissionModeForTester: 'allow-all',
  maxReplyChars: 4000,
  chunkLongReplies: true,
  placeholderText: 'Processing your message...',
  denyMessage: 'Denied',
  modelGuardMessage: 'Guarded',
}

interface TestSessionMessage {
  id: string
  role: string
  content: string
  timestamp?: number
  isIntermediate?: boolean
}

interface TestSession {
  id: string
  workspaceId: string
  workspaceName: string
  lastMessageAt: number
  messages: TestSessionMessage[]
  isProcessing: boolean
  permissionMode?: 'safe' | 'ask' | 'allow-all'
  model?: string
  llmConnection?: string
}

function makeSession(
  messages: TestSession['messages'],
  overrides: Partial<TestSession> = {},
): TestSession {
  return {
    id: overrides.id ?? 'session-1',
    workspaceId: overrides.workspaceId ?? 'ws-1',
    workspaceName: overrides.workspaceName ?? 'My Workspace',
    lastMessageAt: Date.now(),
    messages,
    isProcessing: false,
    permissionMode: overrides.permissionMode ?? 'allow-all',
    model: overrides.model ?? 'pi/gpt-5.4',
    llmConnection: overrides.llmConnection ?? 'chatgpt-plus',
    ...overrides,
  }
}

function makeClient() {
  const posts: Array<{ channel: string, text: string, thread_ts?: string }> = []
  const updates: Array<{ channel: string, ts: string, text: string }> = []

  const client = {
    chat: {
      postMessage: async (args: { channel: string, text: string, thread_ts?: string }) => {
        posts.push(args)
        return { ts: `post-${posts.length}` }
      },
      update: async (args: { channel: string, ts: string, text: string }) => {
        updates.push(args)
        return {}
      },
    },
  }

  return { client, posts, updates }
}

async function createWorkspaceRoot(
  overrides: Partial<typeof DEFAULT_SLACK_CONFIG> = {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'slack-bot-test-'))
  const slackDir = join(root, '.slack')
  await mkdir(slackDir, { recursive: true })
  await writeFile(
    join(slackDir, 'config.json'),
    `${JSON.stringify({ ...DEFAULT_SLACK_CONFIG, ...overrides }, null, 2)}\n`,
    'utf-8',
  )
  await writeFile(
    join(slackDir, 'session-map.json'),
    `${JSON.stringify({ version: 1, mappings: {}, updatedAt: Date.now() }, null, 2)}\n`,
    'utf-8',
  )
  return root
}

describe('slack-bot helpers', () => {
  it('computes thread root ts from threadTs first', () => {
    expect(computeThreadRootTs({ ts: '100', threadTs: '80' })).toBe('80')
    expect(computeThreadRootTs({ ts: '100' })).toBe('100')
    expect(computeThreadRootTs({ ts: '100', threadTs: '' })).toBe('100')
  })

  it('builds stable session key with channel/thread', () => {
    expect(buildSlackSessionKey({
      channel: 'C999',
      threadRootTs: '171234.56',
    })).toBe('slack:C999:171234.56')
  })

  it('strips app mention tokens and normalizes whitespace', () => {
    expect(stripAppMentionText('<@U123> hello')).toBe('hello')
    expect(stripAppMentionText('hi <@U123> there <@U456>')).toBe('hi there')
  })

  it('splits long message into chunks under max size', () => {
    const text = 'A'.repeat(4100)
    const chunks = splitSlackMessage(text, 4000)

    expect(chunks.length).toBe(2)
    expect(chunks[0].length).toBeLessThanOrEqual(4000)
    expect(chunks[1].length).toBeLessThanOrEqual(4000)
    expect(chunks.join('')).toBe(text)
  })

  it('prefers paragraph/word boundaries when splitting', () => {
    const text = 'first paragraph\n\nsecond paragraph\n\nthird paragraph'
    const chunks = splitSlackMessage(text, 30)

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every(chunk => chunk.length <= 30)).toBe(true)
    expect(chunks.join('')).toBe(text)
  })

  it('coerces invalid split size to a safe minimum', () => {
    expect(splitSlackMessage('abc', 0)).toEqual(['a', 'b', 'c'])
  })

  it('splits multibyte text conservatively for Slack payload limits', () => {
    const text = '가'.repeat(2000)
    const chunks = splitSlackMessage(text, 4000)

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('')).toBe(text)
  })

  it('returns latest non-intermediate assistant reply', () => {
    const session = makeSession([
      { id: 'u1', role: 'user', content: 'hello', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: 'draft', timestamp: 2, isIntermediate: true },
      { id: 'a2', role: 'assistant', content: 'final', timestamp: 3 },
    ])

    expect(getLatestAssistantReply(session)).toBe('final')
  })

  it('returns null when assistant reply is unchanged from previous id', () => {
    const session = makeSession([
      { id: 'u1', role: 'user', content: 'hello', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: 'same', timestamp: 2 },
    ])

    expect(getLatestAssistantReply(session, 'a1')).toBeNull()
  })

  it('returns null when no final assistant response exists', () => {
    const session = makeSession([
      { id: 'u1', role: 'user', content: 'hello', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: 'intermediate', timestamp: 2, isIntermediate: true },
    ])

    expect(getLatestAssistantReply(session)).toBeNull()
  })

  it('filters out bot/subtype/empty events', () => {
    expect(isPlainUserMessage({ user: 'U1', text: 'hello', subtype: 'thread_broadcast' })).toBe(false)
    expect(isPlainUserMessage({ user: 'U1', text: 'hello', bot_id: 'B1' })).toBe(false)
    expect(isPlainUserMessage({ user: 'U1', text: '   ' })).toBe(false)
    expect(isPlainUserMessage({ user: 'U1', text: 'hello' })).toBe(true)
  })

  it('builds DM/app_mention payloads with routing-safe fields', () => {
    const dm = toSlackMessageEvent('message.im', {
      user: 'U1',
      text: ' hello ',
      channel: 'D1',
      channel_type: 'im',
      ts: '101',
    })
    expect(dm).toEqual({
      type: 'message.im',
      channel: 'D1',
      channelType: 'im',
      userId: 'U1',
      text: 'hello',
      ts: '101',
      threadTs: undefined,
    })

    const mention = toSlackMessageEvent('app_mention', {
      user: 'U1',
      text: '<@APP> hi there',
      channel: 'C1',
      channel_type: 'channel',
      ts: '201',
      thread_ts: '200',
    })
    expect(mention?.text).toBe('hi there')
    expect(mention?.threadTs).toBe('200')

    const unsupportedDm = toSlackMessageEvent('message.im', {
      user: 'U1',
      text: 'hello',
      channel: 'C1',
      channel_type: 'channel',
      ts: '300',
    })
    expect(unsupportedDm).toBeNull()

    const mentionOnly = toSlackMessageEvent('app_mention', {
      user: 'U1',
      text: '<@APP>',
      channel: 'C1',
      ts: '301',
    })
    expect(mentionOnly).toBeNull()
  })
})

describe('SlackBotService routing', () => {
  it('denies requests when allowlist is empty', async () => {
    const workspaceRoot = await createWorkspaceRoot({ testerUserIds: [] })
    let createCount = 0
    let sendCount = 0

    const service = new SlackBotService({
      workspaceId: 'ws-1',
      workspaceRootPath: workspaceRoot,
      sessionManager: {
        createSession: async () => {
          createCount += 1
          return makeSession([], { id: `session-${createCount}` })
        },
        getSession: async () => null,
        sendMessage: async () => {
          sendCount += 1
        },
      },
    })

    const { client, posts, updates } = makeClient()

    try {
      await service.handleIncomingEvent({
        type: 'message.im',
        channel: 'D1',
        userId: 'U1',
        text: 'hello',
        ts: '100',
      }, client)

      expect(createCount).toBe(0)
      expect(sendCount).toBe(0)
      expect(updates.length).toBe(0)
      expect(posts.length).toBe(1)
      expect(posts[0]?.text).toBe(DEFAULT_SLACK_CONFIG.denyMessage)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('reuses one session key for a thread root across users', async () => {
    const workspaceRoot = await createWorkspaceRoot({ testerUserIds: ['U1', 'U2'] })
    const sessions = new Map<string, TestSession>()
    const sendCalls: Array<{ sessionId: string, message: string }> = []
    let createdCount = 0

    const service = new SlackBotService({
      workspaceId: 'ws-1',
      workspaceRootPath: workspaceRoot,
      sessionManager: {
        createSession: async (_workspaceId: string, options?: {
          permissionMode?: 'safe' | 'ask' | 'allow-all'
          llmConnection?: string
          model?: string
        }) => {
          createdCount += 1
          const session = makeSession([], {
            id: `session-${createdCount}`,
            model: options?.model,
            llmConnection: options?.llmConnection,
            permissionMode: options?.permissionMode,
          })
          sessions.set(session.id, session)
          return session
        },
        getSession: async (id: string) => sessions.get(id) ?? null,
        sendMessage: async (sessionId: string, message: string) => {
          sendCalls.push({ sessionId, message })
          const session = sessions.get(sessionId)
          if (!session) throw new Error(`Missing session ${sessionId}`)
          const now = Date.now()
          session.messages.push({ id: `u-${sendCalls.length}`, role: 'user', content: message, timestamp: now })
          session.messages.push({ id: `a-${sendCalls.length}`, role: 'assistant', content: `reply-${sendCalls.length}`, timestamp: now + 1 })
        },
      },
    })

    const { client, posts, updates } = makeClient()

    try {
      await service.handleIncomingEvent({
        type: 'message.im',
        channel: 'D1',
        userId: 'U1',
        text: 'hello one',
        ts: '100',
      }, client)

      await service.handleIncomingEvent({
        type: 'message.im',
        channel: 'D1',
        userId: 'U2',
        text: 'hello two',
        ts: '101',
        threadTs: '100',
      }, client)

      expect(createdCount).toBe(1)
      expect(sendCalls.map(call => call.sessionId)).toEqual(['session-1', 'session-1'])
      expect(posts.every(post => SLACK_PROCESSING_MESSAGES.includes(post.text))).toBe(true)
      expect(posts[0]?.thread_ts).toBe('100')
      expect(posts[1]?.thread_ts).toBe('100')
      expect(updates.length).toBe(2)

      const mapRaw = await readFile(join(workspaceRoot, '.slack', 'session-map.json'), 'utf-8')
      const map = JSON.parse(mapRaw) as { mappings: Record<string, string> }
      expect(map.mappings['slack:D1:100']).toBe('session-1')
      expect(Object.keys(map.mappings).length).toBe(1)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('blocks model-mismatched sessions before sending placeholder', async () => {
    const workspaceRoot = await createWorkspaceRoot()
    const sessions = new Map<string, TestSession>()
    let sendCount = 0

    const service = new SlackBotService({
      workspaceId: 'ws-1',
      workspaceRootPath: workspaceRoot,
      sessionManager: {
        createSession: async () => {
          const session = makeSession([], {
            id: 'session-guard',
            model: 'claude-3',
            llmConnection: 'anthropic-api',
          })
          sessions.set(session.id, session)
          return session
        },
        getSession: async (id: string) => sessions.get(id) ?? null,
        sendMessage: async () => {
          sendCount += 1
        },
      },
    })

    const { client, posts, updates } = makeClient()

    try {
      await service.handleIncomingEvent({
        type: 'app_mention',
        channel: 'C1',
        userId: 'U1',
        text: 'hello',
        ts: '222',
      }, client)

      expect(sendCount).toBe(0)
      expect(updates.length).toBe(0)
      expect(posts.length).toBe(1)
      expect(posts[0]?.thread_ts).toBe('222')
      expect(posts[0]?.text).toBe(DEFAULT_SLACK_CONFIG.modelGuardMessage)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })
})
