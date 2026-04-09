import { afterEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  buildTelegramSessionName,
  formatTelegramMessageText,
  normalizeTelegramUpdate,
  TelegramAgentBridgeService,
} from '../telegram-agent-bridge'

const tempDirs: string[] = []
const originalCraftConfigDir = process.env.CRAFT_CONFIG_DIR

afterEach(async () => {
  if (originalCraftConfigDir === undefined) {
    delete process.env.CRAFT_CONFIG_DIR
  } else {
    process.env.CRAFT_CONFIG_DIR = originalCraftConfigDir
  }

  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('telegram-agent bridge helpers', () => {
  it('normalizes telegram message updates', () => {
    const event = normalizeTelegramUpdate({
      update_id: 101,
      message: {
        message_id: 42,
        date: 1_760_000_000,
        message_thread_id: 9,
        text: 'deploy this',
        chat: {
          id: -123456,
          title: 'Ops Room',
          type: 'supergroup',
        },
        from: {
          id: 7,
          is_bot: false,
          first_name: 'Min',
          username: 'mjay',
        },
      },
    })

    expect(event).not.toBeNull()
    expect(event?.chatId).toBe('-123456')
    expect(event?.threadId).toBe(9)
    expect(event?.senderId).toBe('7')
    expect(event?.senderDisplay).toBe('Min')
    expect(event?.senderUsername).toBe('mjay')
    expect(event?.text).toBe('deploy this')
  })

  it('builds telegram session names from chat metadata', () => {
    expect(buildTelegramSessionName({
      chatId: '123',
      threadId: 77,
      chatTitle: 'Bridge Chat',
      senderDisplay: 'Min',
      text: 'hello',
    })).toBe('Telegram: Bridge Chat #77')
  })

  it('formats markdown replies into telegram-friendly plain text', () => {
    expect(formatTelegramMessageText([
      '### 참고용 비교 글',
      '- [허리 편한 사무용 의자 추천](https://example.com/chair)',
      '- **20만원대** 기준',
      '',
      '```ts',
      'const chair = "t50";',
      '```',
    ].join('\n'))).toBe([
      '참고용 비교 글',
      '- 허리 편한 사무용 의자 추천 - https://example.com/chair',
      '- 20만원대 기준',
      '',
      'ts 코드:',
      'const chair = "t50";',
    ].join('\n'))
  })

  it('polls telegram updates and forwards them into craft sessions', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'telegram-agent-workspace-'))
    const configDir = await mkdtemp(join(tmpdir(), 'telegram-agent-config-'))
    tempDirs.push(workspaceRoot, configDir)
    process.env.CRAFT_CONFIG_DIR = configDir

    const serviceDir = join(configDir, 'telegram-agent')
    await mkdir(serviceDir, { recursive: true })
    await writeFile(join(serviceDir, 'config.json'), JSON.stringify({
      enabled: true,
      pollIntervalMs: 5,
      requestTimeoutMs: 1000,
      agents: [
        {
          slug: 'craft',
          enabled: true,
          botToken: 'telegram-token',
          chatIds: ['12345'],
          allowedUserIds: ['99'],
          replyToMessages: true,
          target: {
            kind: 'craft',
            namePrefix: 'Telegram',
            permissionMode: 'allow-all',
            workingDirectory: 'user_default',
            thinkingLevel: 'medium',
          },
        },
      ],
    }, null, 2), 'utf-8')

    const telegramCalls: Array<{ method: string; body: Record<string, unknown> }> = []
    let nextTelegramMessageId = 900
    let servedUpdates = false
    const fetchImpl = async (input: URL | RequestInfo, init?: RequestInit | BunFetchRequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = url.split('/').pop()
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
      telegramCalls.push({ method: method || 'unknown', body })

      if (method === 'getUpdates') {
        const result = servedUpdates
          ? []
          : [{
            update_id: 101,
            message: {
              message_id: 55,
              date: 1_760_000_000,
              text: 'hello from telegram',
              chat: {
                id: 12345,
                title: 'Bridge Chat',
                type: 'group',
              },
              from: {
                id: 99,
                is_bot: false,
                first_name: 'Min',
                username: 'mjay',
              },
            },
          }]
        servedUpdates = true
        return new Response(JSON.stringify({ ok: true, result }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      if (method === 'sendMessage') {
        nextTelegramMessageId += 1
        return new Response(JSON.stringify({ ok: true, result: { message_id: nextTelegramMessageId } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      if (method === 'sendChatAction' || method === 'editMessageText' || method === 'deleteMessage') {
        return new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      throw new Error(`Unexpected telegram method: ${method}`)
    }

    const sessions = new Map<string, {
      id: string
      isArchived?: boolean
      isProcessing?: boolean
      messages: Array<{
        id?: string
        role?: string
        content?: string
        isIntermediate?: boolean
        toolName?: string
        toolInput?: Record<string, unknown>
        toolStatus?: string
      }>
    }>()
    let createdSessionCount = 0

    const sessionManager = {
      async createSession() {
        createdSessionCount += 1
        const session = {
          id: `sess-${createdSessionCount}`,
          messages: [] as Array<{ id?: string; role?: string; content?: string; isIntermediate?: boolean }>,
        }
        sessions.set(session.id, session)
        return session
      },
      async getSession(sessionId: string) {
        return sessions.get(sessionId) ?? null
      },
      async sendMessage(sessionId: string, message: string) {
        const session = sessions.get(sessionId)
        if (!session) throw new Error(`Missing session: ${sessionId}`)
        session.isProcessing = true
        session.messages.push({ id: `user-${session.messages.length}`, role: 'user', content: message })
        await new Promise(resolve => setTimeout(resolve, 20))
        session.messages.push({
          id: `tool-${session.messages.length}`,
          role: 'tool',
          content: '',
          toolName: 'Read',
          toolInput: { file_path: '/tmp/demo.ts' },
          toolStatus: 'executing',
        })
        await new Promise(resolve => setTimeout(resolve, 780))
        session.messages.push({ id: `assistant-${session.messages.length}`, role: 'assistant', content: 'bridge reply' })
        session.isProcessing = false
      },
      setSessionThinkingLevel() {},
      notifySessionCreated() {},
    }

    const service = new TelegramAgentBridgeService({
      workspaceId: 'workspace-1',
      workspaceRootPath: workspaceRoot,
      sessionManager,
      deps: {
        fetchImpl: fetchImpl as typeof fetch,
      },
    })

    await service.start()
    await new Promise(resolve => setTimeout(resolve, 1100))
    await service.stop()

    expect(createdSessionCount).toBe(1)
    const sendMessages = telegramCalls.filter(call => call.method === 'sendMessage')
    expect(sendMessages.length).toBeGreaterThanOrEqual(2)
    expect(sendMessages[0]?.body.chat_id).toBe('12345')
    expect(sendMessages[0]?.body.reply_to_message_id).toBe(55)
    expect(sendMessages[0]?.body.text).toBe('응답 생성 중...')
    expect(sendMessages[sendMessages.length - 1]?.body.text).toBe('bridge reply')
    expect(telegramCalls.some(call => call.method === 'sendChatAction')).toBe(true)
    expect(telegramCalls.some(call => call.method === 'editMessageText' && String(call.body.text || '').includes('도구'))).toBe(true)
    expect(telegramCalls.some(call => call.method === 'deleteMessage')).toBe(true)

    const sessionMap = JSON.parse(await readFile(join(serviceDir, 'session-map.json'), 'utf-8')) as {
      mappings: Record<string, { craftSessionId: string }>
    }
    expect(Object.values(sessionMap.mappings)).toHaveLength(1)
    expect(Object.values(sessionMap.mappings)[0]?.craftSessionId).toBe('sess-1')
  })

  it('handles /new by resetting the mapped craft session', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'telegram-agent-reset-workspace-'))
    const configDir = await mkdtemp(join(tmpdir(), 'telegram-agent-reset-config-'))
    tempDirs.push(workspaceRoot, configDir)
    process.env.CRAFT_CONFIG_DIR = configDir

    const serviceDir = join(configDir, 'telegram-agent')
    await mkdir(serviceDir, { recursive: true })
    await writeFile(join(serviceDir, 'config.json'), JSON.stringify({
      enabled: true,
      pollIntervalMs: 5,
      requestTimeoutMs: 1000,
      agents: [
        {
          slug: 'craft',
          enabled: true,
          botToken: 'telegram-token',
          chatIds: ['12345'],
          allowedUserIds: ['99'],
          replyToMessages: true,
          target: {
            kind: 'craft',
            namePrefix: 'Telegram',
            permissionMode: 'allow-all',
            workingDirectory: 'user_default',
            thinkingLevel: 'medium',
          },
        },
      ],
    }, null, 2), 'utf-8')

    const telegramCalls: Array<{ method: string; body: Record<string, unknown> }> = []
    let updateIndex = 0
    let nextTelegramMessageId = 700
    const updates = [
      {
        update_id: 201,
        message: {
          message_id: 71,
          date: 1_760_000_000,
          text: 'first task',
          chat: {
            id: 12345,
            title: 'Bridge Chat',
            type: 'group',
          },
          from: {
            id: 99,
            is_bot: false,
            first_name: 'Min',
            username: 'mjay',
          },
        },
      },
      {
        update_id: 202,
        message: {
          message_id: 72,
          date: 1_760_000_010,
          text: '/new',
          chat: {
            id: 12345,
            title: 'Bridge Chat',
            type: 'group',
          },
          from: {
            id: 99,
            is_bot: false,
            first_name: 'Min',
            username: 'mjay',
          },
        },
      },
    ]

    const fetchImpl = async (input: URL | RequestInfo, init?: RequestInit | BunFetchRequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = url.split('/').pop()
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
      telegramCalls.push({ method: method || 'unknown', body })

      if (method === 'getUpdates') {
        const result = updateIndex < updates.length ? [updates[updateIndex++]] : []
        return new Response(JSON.stringify({ ok: true, result }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      if (method === 'sendMessage') {
        nextTelegramMessageId += 1
        return new Response(JSON.stringify({ ok: true, result: { message_id: nextTelegramMessageId } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      if (method === 'sendChatAction' || method === 'deleteMessage') {
        return new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      throw new Error(`Unexpected telegram method: ${method}`)
    }

    const sessions = new Map<string, {
      id: string
      isArchived?: boolean
      messages: Array<{ id?: string; role?: string; content?: string; isIntermediate?: boolean }>
    }>()
    const archivedSessionIds: string[] = []
    let createdSessionCount = 0

    const sessionManager = {
      async createSession() {
        createdSessionCount += 1
        const session = {
          id: `sess-${createdSessionCount}`,
          messages: [] as Array<{ id?: string; role?: string; content?: string; isIntermediate?: boolean }>,
        }
        sessions.set(session.id, session)
        return session
      },
      async getSession(sessionId: string) {
        return sessions.get(sessionId) ?? null
      },
      async sendMessage(sessionId: string, message: string) {
        const session = sessions.get(sessionId)
        if (!session) throw new Error(`Missing session: ${sessionId}`)
        session.messages.push({ id: `user-${session.messages.length}`, role: 'user', content: message })
        session.messages.push({ id: `assistant-${session.messages.length}`, role: 'assistant', content: 'bridge reply' })
      },
      async archiveSession(sessionId: string) {
        archivedSessionIds.push(sessionId)
        const session = sessions.get(sessionId)
        if (session) session.isArchived = true
      },
      setSessionThinkingLevel() {},
      notifySessionCreated() {},
    }

    const service = new TelegramAgentBridgeService({
      workspaceId: 'workspace-1',
      workspaceRootPath: workspaceRoot,
      sessionManager,
      deps: {
        fetchImpl: fetchImpl as typeof fetch,
      },
    })

    await service.start()
    await new Promise(resolve => setTimeout(resolve, 120))
    await service.stop()

    expect(createdSessionCount).toBe(2)
    expect(archivedSessionIds).toEqual(['sess-1'])

    const sendMessages = telegramCalls.filter(call => call.method === 'sendMessage')
    expect(sendMessages.some(call => call.body.text === 'bridge reply')).toBe(true)
    expect(sendMessages.some(call => call.body.text === '새 세션을 시작했습니다. 다음 메시지부터 새 대화로 이어집니다.')).toBe(true)

    const sessionMap = JSON.parse(await readFile(join(serviceDir, 'session-map.json'), 'utf-8')) as {
      mappings: Record<string, { craftSessionId: string }>
    }
    expect(Object.values(sessionMap.mappings)).toHaveLength(1)
    expect(Object.values(sessionMap.mappings)[0]?.craftSessionId).toBe('sess-2')
  })
})
