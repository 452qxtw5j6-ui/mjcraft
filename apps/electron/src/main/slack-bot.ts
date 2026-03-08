import { App, type LogLevel } from '@slack/bolt'
import { existsSync } from 'fs'
import { appendFile, mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { getCredentialManager } from '@craft-agent/shared/credentials'
import { loadWorkspaceSources } from '@craft-agent/shared/sources'
import log from './logger'
import { SlackGateway, type SlackGatewayClientLike } from './slack-gateway'

const slackLog = log.scope('slack')

const SLACK_DIRNAME = '.slack'
const CONFIG_FILENAME = 'config.json'
const SESSION_MAP_FILENAME = 'session-map.json'
const EVENTS_LOG_FILENAME = 'events.jsonl'

const BOT_TOKEN_SOURCE_ID = 'slack-bot-bot-token'
const APP_TOKEN_SOURCE_ID = 'slack-bot-app-token'
const ENFORCED_CONNECTION_SLUG = 'chatgpt-plus'
const ENFORCED_MODEL = 'pi/gpt-5.4'
const SLACK_TEXT_MAX_BYTES = 3000
export const SLACK_PROCESSING_MESSAGES = [
  '두뇌 풀가동 중 🧠💨',
  '음... 이거 좀 생각해볼게요 🫠',
  '허리 한번 펴고... 🙆 바로 답변할게요',
  '읽는 중... 눈 좀 깜빡이고 올게요 👀',
  '잠깐, 머리 좀 긁적이는 중 😅',
]

export interface SlackRuntimeConfig {
  enabled: boolean
  testerUserIds: string[]
  permissionModeForTester: 'safe' | 'ask' | 'allow-all'
  maxReplyChars: number
  chunkLongReplies: boolean
  placeholderText: string
  denyMessage: string
  modelGuardMessage: string
}

interface SlackSessionMap {
  version: number
  mappings: Record<string, string>
  updatedAt: number
}

interface SlackMessageEvent {
  type: 'message.im' | 'app_mention'
  channel: string
  channelType?: string
  userId: string
  text: string
  ts: string
  threadTs?: string
}

interface SlackTokens {
  botToken: string
  appToken: string
}

interface SlackClientLike {
  chat: {
    postMessage(args: {
      channel: string
      text: string
      thread_ts?: string
    }): Promise<{ ts?: string }>
    update(args: {
      channel: string
      ts: string
      text: string
    }): Promise<unknown>
  }
}

interface SlackBotServiceOptions {
  workspaceId: string
  workspaceRootPath: string
  sessionManager: SlackSessionManagerLike
}

interface SlackSessionMessage {
  id: string
  role: string
  content: string
  isIntermediate?: boolean
}

interface SlackSessionLike {
  id: string
  model?: string
  llmConnection?: string
  messages: SlackSessionMessage[]
  isArchived?: boolean
}

interface SlackSessionManagerLike {
  createSession(
    workspaceId: string,
    options?: {
      name?: string
      permissionMode?: 'safe' | 'ask' | 'allow-all'
      llmConnection?: string
      model?: string
      labels?: string[]
      enabledSourceSlugs?: string[]
      workingDirectory?: string | 'user_default' | 'none'
      sessionOrigin?: 'manual' | 'notion' | 'slack'
      slackRef?: { channelId: string; threadTs: string; rootMessageTs: string; permalink?: string }
    },
  ): Promise<SlackSessionLike>
  getSession(sessionId: string): Promise<SlackSessionLike | null>
  sendMessage(sessionId: string, message: string): Promise<void>
  findSessionBySlackThread?(workspaceId: string, channelId: string, threadTs: string): Promise<SlackSessionLike | null>
  linkSessionToSlack?(sessionId: string, slackRef: { channelId: string; threadTs: string; rootMessageTs: string; permalink?: string }): Promise<void>
}

type SlackRuntimeConfigFile = Partial<SlackRuntimeConfig> & {
  enforcedConnectionSlug?: string
  enforcedModel?: string
}

const DEFAULT_CONFIG: SlackRuntimeConfig = {
  enabled: true,
  testerUserIds: [],
  permissionModeForTester: 'allow-all',
  maxReplyChars: 4000,
  chunkLongReplies: true,
  placeholderText: 'Processing your message...',
  denyMessage: 'This Slack user is not allowed to use this bot yet.',
  modelGuardMessage: 'This session is restricted to GPT/Codex only. Please retry in a Slack-managed thread.',
}

export function computeThreadRootTs(event: Pick<SlackMessageEvent, 'threadTs' | 'ts'>): string {
  const threadRoot = event.threadTs?.trim()
  return threadRoot ? threadRoot : event.ts
}

export function buildSlackSessionKey(params: {
  channel: string
  threadRootTs: string
}): string {
  return `slack:${params.channel}:${params.threadRootTs}`
}

export function stripAppMentionText(text: string): string {
  return text.replace(/<@[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

export function splitSlackMessage(text: string, maxChars: number): string[] {
  const safeMaxChars = Math.max(1, Math.floor(maxChars))
  if (!text.trim()) return []
  const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).length
  if (text.length <= safeMaxChars && utf8ByteLength(text) <= SLACK_TEXT_MAX_BYTES) {
    return [text]
  }

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    const candidateLength = Math.min(safeMaxChars, remaining.length)
    const candidate = remaining.slice(0, candidateLength)
    const minBoundary = Math.floor(candidateLength * 0.6)
    const paragraphBoundary = candidate.lastIndexOf('\n\n')
    const lineBoundary = candidate.lastIndexOf('\n')
    const wordBoundary = candidate.lastIndexOf(' ')

    let splitAt = candidateLength
    if (paragraphBoundary >= minBoundary) {
      splitAt = paragraphBoundary + 2
    } else if (lineBoundary >= minBoundary) {
      splitAt = lineBoundary + 1
    } else if (wordBoundary >= minBoundary) {
      splitAt = wordBoundary + 1
    }

    while (splitAt > 1 && utf8ByteLength(remaining.slice(0, splitAt)) > SLACK_TEXT_MAX_BYTES) {
      splitAt = Math.max(1, Math.floor(splitAt / 2))
    }

    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt)
  }

  return chunks
}

export function getLatestAssistantReply(session: SlackSessionLike | null, previousAssistantId?: string): string | null {
  if (!session) return null

  for (let i = session.messages.length - 1; i >= 0; i--) {
    const message = session.messages[i]
    if (message.role !== 'assistant' || message.isIntermediate) continue
    if (previousAssistantId && message.id === previousAssistantId) return null
    if (!message.content.trim()) return null
    return message.content
  }

  return null
}

function pickRandomProcessingMessage(fallbackText: string): string {
  if (SLACK_PROCESSING_MESSAGES.length === 0) return fallbackText
  const index = Math.floor(Math.random() * SLACK_PROCESSING_MESSAGES.length)
  return SLACK_PROCESSING_MESSAGES[index] ?? fallbackText
}

function getLatestAssistantId(session: SlackSessionLike | null): string | undefined {
  if (!session) return undefined
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const message = session.messages[i]
    if (message.role === 'assistant' && !message.isIntermediate) {
      return message.id
    }
  }
  return undefined
}

export function isPlainUserMessage(event: Record<string, unknown>): boolean {
  const subtype = typeof event.subtype === 'string' ? event.subtype : undefined
  const user = typeof event.user === 'string' ? event.user : undefined
  const text = typeof event.text === 'string' ? event.text : ''
  const botId = typeof event.bot_id === 'string' ? event.bot_id : undefined

  if (!user || !text.trim()) return false
  if (botId) return false
  if (subtype) return false

  return true
}

export function toSlackMessageEvent(
  type: SlackMessageEvent['type'],
  raw: Record<string, unknown>,
): SlackMessageEvent | null {
  if (!isPlainUserMessage(raw)) return null

  const channel = typeof raw.channel === 'string' ? raw.channel : ''
  const userId = typeof raw.user === 'string' ? raw.user : ''
  const ts = typeof raw.ts === 'string' ? raw.ts : ''
  const channelType = typeof raw.channel_type === 'string' ? raw.channel_type : undefined

  if (!channel || !userId || !ts) return null
  if (type === 'message.im' && channelType !== 'im') return null

  const sourceText = String(raw.text ?? '')
  const text = type === 'app_mention'
    ? stripAppMentionText(sourceText)
    : sourceText.trim()

  if (!text) return null

  return {
    type,
    channel,
    channelType,
    userId,
    text,
    ts,
    threadTs: typeof raw.thread_ts === 'string' ? raw.thread_ts : undefined,
  }
}

export class SlackBotService {
  private readonly workspaceId: string
  private readonly workspaceRootPath: string
  private readonly sessionManager: SlackSessionManagerLike
  private readonly serviceDir: string
  private readonly configPath: string
  private readonly sessionMapPath: string
  private readonly eventsPath: string
  private readonly slackGateway: SlackGateway

  private app: App | null = null
  private started = false

  constructor(options: SlackBotServiceOptions) {
    this.workspaceId = options.workspaceId
    this.workspaceRootPath = options.workspaceRootPath
    this.sessionManager = options.sessionManager
    this.serviceDir = join(this.workspaceRootPath, SLACK_DIRNAME)
    this.configPath = join(this.serviceDir, CONFIG_FILENAME)
    this.sessionMapPath = join(this.serviceDir, SESSION_MAP_FILENAME)
    this.eventsPath = join(this.serviceDir, EVENTS_LOG_FILENAME)
    this.slackGateway = new SlackGateway({
      workspaceId: this.workspaceId,
      workspaceRootPath: this.workspaceRootPath,
      sourceSlug: 'slack',
    })
  }

  async start(): Promise<void> {
    if (this.started) return

    await this.ensureStorageFiles()
    const tokens = await this.loadTokens()
    const config = await this.readConfig()
    if (!config.enabled) {
      slackLog.info('[slack] service disabled by config')
      return
    }

    this.app = new App({
      token: tokens.botToken,
      appToken: tokens.appToken,
      socketMode: true,
      logLevel: this.resolveLogLevel(),
      logger: {
        debug: (...args) => slackLog.debug(...args),
        info: (...args) => slackLog.info(...args),
        warn: (...args) => slackLog.warn(...args),
        error: (...args) => slackLog.error(...args),
        setLevel: () => {},
        getLevel: () => LogLevel.INFO,
        setName: () => {},
      },
    })

    this.app.event('app_mention', async ({ event, client }) => {
      await this.handleIncomingEvent('app_mention', event as unknown as Record<string, unknown>, client as SlackClientLike)
    })

    this.app.message(async ({ message, client }) => {
      const payload = toSlackMessageEvent('message.im', message as unknown as Record<string, unknown>)
      if (!payload) return
      await this.handleSlackMessage(payload, client as SlackClientLike)
    })

    await this.app.start()
    this.started = true
    slackLog.info('[slack] service started')
  }

  async stop(): Promise<void> {
    if (!this.started) return
    await this.app?.stop()
    this.app = null
    this.started = false
  }

  private async handleIncomingEvent(
    type: SlackMessageEvent['type'],
    raw: Record<string, unknown>,
    client: SlackClientLike,
  ): Promise<void> {
    const payload = toSlackMessageEvent(type, raw)
    if (!payload) return
    await this.handleSlackMessage(payload, client)
  }

  private async handleSlackMessage(event: SlackMessageEvent, client: SlackClientLike): Promise<void> {
    await this.appendEvent({ type: event.type, event })

    const config = await this.readConfig()
    if (!config.enabled) return

    if (!this.isAllowedUser(config, event.userId)) {
      await this.slackGateway.postMessage({
        channel: event.channel,
        text: config.denyMessage,
        threadTs: event.threadTs,
      }, client as unknown as SlackGatewayClientLike)
      return
    }

    const threadRootTs = computeThreadRootTs(event)
    const sessionKey = buildSlackSessionKey({ channel: event.channel, threadRootTs })
    const previousSessionId = (await this.readSessionMap()).mappings[sessionKey]
    const previousSession = previousSessionId
      ? await this.sessionManager.getSession(previousSessionId)
      : null

    const linkedSession = await this.sessionManager.findSessionBySlackThread?.(this.workspaceId, event.channel, threadRootTs) ?? null
    const session = (linkedSession && !linkedSession.isArchived)
      ? linkedSession
      : (previousSession && !previousSession.isArchived ? previousSession : null)

    const previousAssistantId = getLatestAssistantId(session)
    const processingText = pickRandomProcessingMessage(config.placeholderText)
    const placeholder = await this.slackGateway.postMessage({
      channel: event.channel,
      text: processingText,
      threadTs: threadRootTs,
    }, client as unknown as SlackGatewayClientLike)

    let targetSession = session
    if (!targetSession) {
      targetSession = await this.sessionManager.createSession(this.workspaceId, {
        name: `Slack: ${stripAppMentionText(event.text).slice(0, 60)}`,
        permissionMode: this.resolvePermissionMode(config, event.userId),
        llmConnection: ENFORCED_CONNECTION_SLUG,
        model: ENFORCED_MODEL,
        sessionOrigin: 'slack',
        slackRef: {
          channelId: event.channel,
          threadTs: threadRootTs,
          rootMessageTs: threadRootTs,
        },
      })

      await this.sessionManager.linkSessionToSlack?.(targetSession.id, {
        channelId: event.channel,
        threadTs: threadRootTs,
        rootMessageTs: threadRootTs,
      })
      await this.updateSessionMap(sessionKey, targetSession.id)
    }

    if (targetSession.llmConnection && targetSession.llmConnection !== ENFORCED_CONNECTION_SLUG) {
      await this.slackGateway.updateMessage({
        channel: event.channel,
        ts: placeholder.ts,
        text: config.modelGuardMessage,
      }, client as unknown as SlackGatewayClientLike)
      return
    }

    await this.sessionManager.sendMessage(targetSession.id, event.text)
    const refreshedSession = await this.sessionManager.getSession(targetSession.id)
    const reply = getLatestAssistantReply(refreshedSession, previousAssistantId)
    const fallback = reply ?? 'No final assistant response was produced.'
    const parts = config.chunkLongReplies
      ? splitSlackMessage(fallback, config.maxReplyChars)
      : [fallback]

    if (parts.length === 0) {
      await this.slackGateway.updateMessage({
        channel: event.channel,
        ts: placeholder.ts,
        text: 'No final assistant response was produced.',
      }, client as unknown as SlackGatewayClientLike)
      return
    }

    await this.slackGateway.updateMessage({
      channel: event.channel,
      ts: placeholder.ts,
      text: parts[0]!,
    }, client as unknown as SlackGatewayClientLike)

    for (let i = 1; i < parts.length; i++) {
      await this.slackGateway.postMessage({
        channel: event.channel,
        threadTs: threadRootTs,
        text: parts[i]!,
      }, client as unknown as SlackGatewayClientLike)
    }
  }

  private isAllowedUser(config: SlackRuntimeConfig, userId: string): boolean {
    if (config.testerUserIds.length === 0) return false
    return config.testerUserIds.includes(userId)
  }

  private resolvePermissionMode(config: SlackRuntimeConfig, userId: string): 'safe' | 'ask' | 'allow-all' {
    return this.isAllowedUser(config, userId) ? config.permissionModeForTester : 'safe'
  }

  private async ensureStorageFiles(): Promise<void> {
    await mkdir(this.serviceDir, { recursive: true })
    if (!existsSync(this.configPath)) {
      await writeFile(this.configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8')
    }
    if (!existsSync(this.sessionMapPath)) {
      await writeFile(this.sessionMapPath, JSON.stringify({ version: 1, mappings: {}, updatedAt: Date.now() } satisfies SlackSessionMap, null, 2), 'utf-8')
    }
    if (!existsSync(this.eventsPath)) {
      await writeFile(this.eventsPath, '', 'utf-8')
    }
  }

  private async readConfig(): Promise<SlackRuntimeConfig> {
    const raw = await readFile(this.configPath, 'utf-8')
    const parsed = JSON.parse(raw) as SlackRuntimeConfigFile
    return { ...DEFAULT_CONFIG, ...parsed }
  }

  private async readSessionMap(): Promise<SlackSessionMap> {
    const raw = await readFile(this.sessionMapPath, 'utf-8')
    return JSON.parse(raw) as SlackSessionMap
  }

  private async updateSessionMap(key: string, sessionId: string): Promise<void> {
    const current = await this.readSessionMap()
    current.mappings[key] = sessionId
    current.updatedAt = Date.now()
    await writeFile(this.sessionMapPath, JSON.stringify(current, null, 2), 'utf-8')
  }

  private async appendEvent(event: Record<string, unknown>): Promise<void> {
    await appendFile(this.eventsPath, `${JSON.stringify({ ...event, at: new Date().toISOString() })}\n`, 'utf-8')
  }

  private async loadTokens(): Promise<SlackTokens> {
    const sources = loadWorkspaceSources(this.workspaceRootPath)
    const slackSource = sources.find(source => source.config.slug === 'slack')
    const rawCredentialManager = getCredentialManager()

    let botToken = ''
    let appToken = ''

    if (slackSource) {
      const sourceCredentialManager = getCredentialManager()
      const botFallback = await rawCredentialManager.get({
        type: 'source_apikey',
        workspaceId: this.workspaceId,
        sourceId: BOT_TOKEN_SOURCE_ID,
      })
      const appFallback = await rawCredentialManager.get({
        type: 'source_apikey',
        workspaceId: this.workspaceId,
        sourceId: APP_TOKEN_SOURCE_ID,
      })
      botToken = botFallback?.value ?? ''
      appToken = appFallback?.value ?? ''
      void sourceCredentialManager
    }

    if (!botToken || !appToken) {
      throw new Error('Slack bot/app tokens are missing')
    }
    return { botToken, appToken }
  }

  private resolveLogLevel(): LogLevel {
    return process.env.CRAFT_DEBUG === '1' ? LogLevel.DEBUG : LogLevel.INFO
  }
}
