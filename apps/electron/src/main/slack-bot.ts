import { App, type LogLevel } from '@slack/bolt'
import { existsSync } from 'fs'
import { appendFile, mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { getCredentialManager } from '@craft-agent/shared/credentials'
import { loadWorkspaceSources } from '@craft-agent/shared/sources'
import log from './logger'

const slackLog = log.scope('slack')

const SLACK_DIRNAME = '.slack'
const CONFIG_FILENAME = 'config.json'
const SESSION_MAP_FILENAME = 'session-map.json'
const EVENTS_LOG_FILENAME = 'events.jsonl'

const BOT_TOKEN_SOURCE_ID = 'slack-bot-bot-token'
const APP_TOKEN_SOURCE_ID = 'slack-bot-app-token'
const ENFORCED_CONNECTION_SLUG = 'chatgpt-plus'
const ENFORCED_MODEL = 'pi/gpt-5.3-codex'
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
    },
  ): Promise<SlackSessionLike>
  getSession(sessionId: string): Promise<SlackSessionLike | null>
  sendMessage(sessionId: string, message: string): Promise<void>
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
  userId: string
  channel: string
  threadRootTs: string
}): string {
  return `slack:${params.userId}:${params.channel}:${params.threadRootTs}`
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

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  if (!existsSync(filePath)) return null
  try {
    const raw = await readFile(filePath, 'utf-8')
    return JSON.parse(raw) as T
  } catch (error) {
    slackLog.warn(`Failed to read JSON file ${filePath}:`, error)
    return null
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
}

function withFallbackConfig(raw: SlackRuntimeConfigFile | null): SlackRuntimeConfig {
  if (raw?.enforcedConnectionSlug && raw.enforcedConnectionSlug !== ENFORCED_CONNECTION_SLUG) {
    slackLog.warn(`Ignoring unsupported Slack enforcedConnectionSlug from config: ${raw.enforcedConnectionSlug}`)
  }

  if (raw?.enforcedModel && raw.enforcedModel !== ENFORCED_MODEL) {
    slackLog.warn(`Ignoring unsupported Slack enforcedModel from config: ${raw.enforcedModel}`)
  }

  return {
    ...DEFAULT_CONFIG,
    ...(raw ?? {}),
    testerUserIds: Array.isArray(raw?.testerUserIds)
      ? raw!.testerUserIds.filter((v): v is string => typeof v === 'string' && v.length > 0)
      : [],
  }
}

export class SlackBotService {
  private readonly workspaceId: string
  private readonly workspaceRootPath: string
  private readonly sessionManager: SlackSessionManagerLike
  private readonly slackDir: string
  private readonly configPath: string
  private readonly sessionMapPath: string
  private readonly eventsLogPath: string

  private app: App | null = null
  private started = false
  private config: SlackRuntimeConfig = DEFAULT_CONFIG
  private sessionMap: SlackSessionMap = {
    version: 1,
    mappings: {},
    updatedAt: Date.now(),
  }
  private sessionQueues: Map<string, Promise<void>> = new Map()

  constructor(options: SlackBotServiceOptions) {
    this.workspaceId = options.workspaceId
    this.workspaceRootPath = options.workspaceRootPath
    this.sessionManager = options.sessionManager
    this.slackDir = join(this.workspaceRootPath, SLACK_DIRNAME)
    this.configPath = join(this.slackDir, CONFIG_FILENAME)
    this.sessionMapPath = join(this.slackDir, SESSION_MAP_FILENAME)
    this.eventsLogPath = join(this.slackDir, EVENTS_LOG_FILENAME)
  }

  async start(): Promise<void> {
    if (this.started) return

    await this.ensureStorageFiles()
    this.config = await this.loadConfig()
    this.sessionMap = await this.loadSessionMap()

    if (!this.config.enabled) {
      slackLog.info('Slack bot is disabled by config (.slack/config.json)')
      return
    }

    const tokens = await this.loadTokens()
    if (!tokens) {
      slackLog.warn('Slack bot tokens are missing. Service will stay disabled.')
      return
    }

    this.app = new App({
      token: tokens.botToken,
      appToken: tokens.appToken,
      socketMode: true,
      logLevel: 'WARN' as LogLevel,
    })

    this.registerHandlers(this.app)
    await this.app.start()
    this.started = true

    slackLog.info(`Slack bot connected for workspace ${this.workspaceId}`)
  }

  async stop(): Promise<void> {
    if (!this.app) return

    try {
      await this.app.stop()
      slackLog.info('Slack bot stopped')
    } catch (error) {
      slackLog.error('Failed to stop Slack bot cleanly:', error)
    } finally {
      this.app = null
      this.started = false
    }
  }

  async handleIncomingEvent(event: SlackMessageEvent, client: SlackClientLike): Promise<void> {
    this.config = await this.loadConfig()
    if (!this.config.enabled) return

    const text = event.text.trim()
    if (!text) return

    await this.appendEvent('received', {
      eventType: event.type,
      userId: event.userId,
      channel: event.channel,
      threadTs: event.threadTs,
      textPreview: text.slice(0, 200),
    })

    const isAllowlistConfigured = this.config.testerUserIds.length > 0
    if (!isAllowlistConfigured || !this.config.testerUserIds.includes(event.userId)) {
      const denyThread = computeThreadRootTs(event)
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: denyThread,
        text: this.config.denyMessage,
      })
      await this.appendEvent('denied_user', {
        userId: event.userId,
        channel: event.channel,
        reason: isAllowlistConfigured ? 'not_allowlisted' : 'allowlist_empty',
      })
      return
    }

    const threadRootTs = computeThreadRootTs(event)
    const sessionKey = buildSlackSessionKey({
      userId: event.userId,
      channel: event.channel,
      threadRootTs,
    })

    const queue = this.sessionQueues.get(sessionKey) ?? Promise.resolve()
    const run = queue
      .catch(() => undefined)
      .then(() => this.processEventInOrder(sessionKey, event, threadRootTs, client))
      .finally(() => {
        if (this.sessionQueues.get(sessionKey) === run) {
          this.sessionQueues.delete(sessionKey)
        }
      })

    this.sessionQueues.set(sessionKey, run)
    await run
  }

  private registerHandlers(app: App): void {
    app.event('message', async ({ event, client }: { event: unknown, client: unknown }) => {
      try {
        const parsed = toSlackMessageEvent('message.im', event as Record<string, unknown>)
        if (!parsed) return

        await this.handleIncomingEvent(parsed, client as SlackClientLike)
      } catch (error) {
        slackLog.error('Failed to handle DM message event:', error)
      }
    })

    app.event('app_mention', async ({ event, client }: { event: unknown, client: unknown }) => {
      try {
        const parsed = toSlackMessageEvent('app_mention', event as Record<string, unknown>)
        if (!parsed) return

        await this.handleIncomingEvent(parsed, client as SlackClientLike)
      } catch (error) {
        slackLog.error('Failed to handle app_mention event:', error)
      }
    })
  }

  private async processEventInOrder(
    sessionKey: string,
    event: SlackMessageEvent,
    threadRootTs: string,
    client: SlackClientLike,
  ): Promise<void> {
    const { sessionId, createdSession } = await this.getOrCreateSessionId(sessionKey, event)

    const preSession = await this.sessionManager.getSession(sessionId) ?? createdSession
    if (!this.isModelPolicyAllowed(preSession)) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadRootTs,
        text: this.config.modelGuardMessage,
      })
      await this.appendEvent('model_guard_block', {
        sessionId,
        expectedModel: ENFORCED_MODEL,
        expectedConnection: ENFORCED_CONNECTION_SLUG,
      })
      return
    }

    const previousAssistantId = getLatestAssistantId(preSession)

    const placeholder = await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadRootTs,
      text: pickRandomProcessingMessage(this.config.placeholderText),
    })

    try {
      await this.sessionManager.sendMessage(sessionId, event.text)

      const postSession = await this.sessionManager.getSession(sessionId)
      const responseText = getLatestAssistantReply(postSession, previousAssistantId)

      if (!responseText) {
        const fallback = 'The agent did not produce a final response. Please retry once.'
        await this.updatePlaceholderOrReply(client, event.channel, placeholder.ts, threadRootTs, fallback)
        await this.appendEvent('missing_reply', { sessionId })
        return
      }

      const chunks = this.config.chunkLongReplies
        ? splitSlackMessage(responseText, this.config.maxReplyChars)
        : [responseText.slice(0, this.config.maxReplyChars)]

      if (chunks.length === 0) {
        const fallback = 'The response was empty after processing.'
        await this.updatePlaceholderOrReply(client, event.channel, placeholder.ts, threadRootTs, fallback)
        return
      }

      await this.updatePlaceholderOrReply(client, event.channel, placeholder.ts, threadRootTs, chunks[0])

      for (let i = 1; i < chunks.length; i++) {
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: threadRootTs,
          text: chunks[i],
        })
      }

      await this.appendEvent('replied', {
        sessionId,
        chunkCount: chunks.length,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.updatePlaceholderOrReply(
        client,
        event.channel,
        placeholder.ts,
        threadRootTs,
        `Error while processing request: ${message}`,
      )
      await this.appendEvent('error', {
        sessionId,
        error: message,
      })
      slackLog.error(`Slack event processing failed for session ${sessionId}:`, error)
    }
  }

  private async updatePlaceholderOrReply(
    client: SlackClientLike,
    channel: string,
    placeholderTs: string | undefined,
    threadTs: string,
    text: string,
  ): Promise<void> {
    if (placeholderTs) {
      await client.chat.update({ channel, ts: placeholderTs, text })
      return
    }

    await client.chat.postMessage({ channel, thread_ts: threadTs, text })
  }

  private async getOrCreateSessionId(sessionKey: string, event: SlackMessageEvent): Promise<{
    sessionId: string
    createdSession: SlackSessionLike | null
  }> {
    const existing = this.sessionMap.mappings[sessionKey]
    if (existing) {
      return {
        sessionId: existing,
        createdSession: null,
      }
    }

    const enabledSourceSlugs = loadWorkspaceSources(this.workspaceRootPath)
      .filter(source => source.config.enabled)
      .map(source => source.config.slug)

    const created = await this.sessionManager.createSession(this.workspaceId, {
      name: `Slack ${event.type} ${event.userId}`,
      permissionMode: this.config.permissionModeForTester,
      llmConnection: ENFORCED_CONNECTION_SLUG,
      model: ENFORCED_MODEL,
      labels: ['project::slack'],
      enabledSourceSlugs,
      workingDirectory: this.workspaceRootPath,
    })

    this.sessionMap.mappings[sessionKey] = created.id
    this.sessionMap.updatedAt = Date.now()
    await this.persistSessionMap(this.sessionMap)

    await this.appendEvent('session_created', {
      sessionKey,
      sessionId: created.id,
      userId: event.userId,
      channel: event.channel,
    })

    return {
      sessionId: created.id,
      createdSession: created,
    }
  }

  private isModelPolicyAllowed(session: SlackSessionLike | null): boolean {
    if (!session) return false

    const modelMatches = session.model === ENFORCED_MODEL
    const connectionMatches = session.llmConnection === ENFORCED_CONNECTION_SLUG

    return modelMatches && connectionMatches
  }

  private async ensureStorageFiles(): Promise<void> {
    await mkdir(this.slackDir, { recursive: true })

    if (!existsSync(this.configPath)) {
      await writeJsonFile(this.configPath, DEFAULT_CONFIG)
    }

    if (!existsSync(this.sessionMapPath)) {
      await writeJsonFile(this.sessionMapPath, {
        version: 1,
        mappings: {},
        updatedAt: Date.now(),
      } satisfies SlackSessionMap)
    }
  }

  private async loadConfig(): Promise<SlackRuntimeConfig> {
    const raw = await readJsonFile<SlackRuntimeConfigFile>(this.configPath)
    return withFallbackConfig(raw)
  }

  private async loadSessionMap(): Promise<SlackSessionMap> {
    const raw = await readJsonFile<SlackSessionMap>(this.sessionMapPath)
    if (!raw || raw.version !== 1 || typeof raw.mappings !== 'object' || !raw.mappings) {
      return { version: 1, mappings: {}, updatedAt: Date.now() }
    }

    return {
      version: 1,
      mappings: raw.mappings,
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
    }
  }

  private async persistSessionMap(map: SlackSessionMap): Promise<void> {
    await writeJsonFile(this.sessionMapPath, map)
  }

  private async loadTokens(): Promise<SlackTokens | null> {
    const manager = getCredentialManager()

    const [botToken, appToken] = await Promise.all([
      manager.get({ type: 'source_apikey', workspaceId: this.workspaceId, sourceId: BOT_TOKEN_SOURCE_ID }),
      manager.get({ type: 'source_bearer', workspaceId: this.workspaceId, sourceId: APP_TOKEN_SOURCE_ID }),
    ])

    const bot = botToken?.value
    const app = appToken?.value

    if (!bot || !app) {
      return null
    }

    return { botToken: bot, appToken: app }
  }

  private async appendEvent(type: string, data: Record<string, unknown>): Promise<void> {
    const entry = {
      ts: Date.now(),
      type,
      workspaceId: this.workspaceId,
      ...data,
    }
    await appendFile(this.eventsLogPath, `${JSON.stringify(entry)}\n`, 'utf-8')
  }
}
