import { existsSync } from 'fs'
import { appendFile, mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { CONFIG_DIR, getDefaultLlmConnection, getLlmConnection, getLlmConnections } from '@craft-agent/shared/config'
import { isValidLabelId } from '@craft-agent/shared/labels/storage'
import { loadWorkspaceSources } from '@craft-agent/shared/sources'
import { loadWorkspaceConfig } from '@craft-agent/shared/workspaces'
import log from './logger'

const telegramBridgeLog = log.scope('telegram-agent')

const SERVICE_DIRNAME = 'telegram-agent'
const CONFIG_FILENAME = 'config.json'
const SESSION_MAP_FILENAME = 'session-map.json'
const EVENTS_LOG_FILENAME = 'events.jsonl'
const CURSOR_FILENAME = 'cursor.json'
const TELEGRAM_MESSAGE_LIMIT = 4000
const TELEGRAM_PROGRESS_POLL_MS = 700
const TELEGRAM_TYPING_INTERVAL_MS = 4000
const TELEGRAM_PROGRESS_FALLBACK = '응답 생성 중...'
const TELEGRAM_RESET_CONFIRMATION = '새 세션을 시작했습니다. 다음 메시지부터 새 대화로 이어집니다.'
const TELEGRAM_CALLBACK_PREFIX = 'ca'

type PermissionMode = 'safe' | 'ask' | 'allow-all'
type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'max'

interface TelegramBridgeSessionLike {
  id: string
  name?: string
  isArchived?: boolean
  isProcessing?: boolean
  enabledSourceSlugs?: string[]
  messages?: Array<{
    id?: string
    role?: string
    content?: string
    isIntermediate?: boolean
    timestamp?: number
    toolName?: string
    toolInput?: Record<string, unknown>
    toolResult?: string
    toolStatus?: string
    toolIntent?: string
    toolDisplayName?: string
    isError?: boolean
  }>
}

interface TelegramBridgeSessionManagerLike {
  createSession(
    workspaceId: string,
    options?: {
      name?: string
      permissionMode?: PermissionMode
      llmConnection?: string
      model?: string
      labels?: string[]
      enabledSourceSlugs?: string[]
      workingDirectory?: string | 'user_default' | 'none'
    },
  ): Promise<TelegramBridgeSessionLike>
  getSession(sessionId: string): Promise<TelegramBridgeSessionLike | null>
  sendMessage(sessionId: string, message: string): Promise<void>
  archiveSession?(sessionId: string): Promise<void>
  cancelProcessing?(sessionId: string, silent?: boolean): Promise<void>
  setSessionSources?(sessionId: string, sourceSlugs: string[]): Promise<void>
  setSessionThinkingLevel?(sessionId: string, level: ThinkingLevel): void
  notifySessionCreated?(sessionId: string): void
}

type CraftTargetConfig = {
  kind: 'craft'
  namePrefix?: string
  permissionMode?: PermissionMode
  llmConnection?: string
  model?: string
  thinkingLevel?: ThinkingLevel
  labels?: string[]
  workingDirectory?: string | 'user_default' | 'none'
}

export type TelegramBridgeAgentConfig = {
  slug: string
  enabled: boolean
  botToken?: string
  botTokenEnv?: string
  chatIds?: string[]
  allowedUserIds?: string[]
  allowedUsernames?: string[]
  replyToMessages?: boolean
  target: CraftTargetConfig
}

export interface TelegramBridgeConfig {
  enabled: boolean
  apiBaseUrl: string
  pollIntervalMs: number
  requestTimeoutMs: number
  agents: TelegramBridgeAgentConfig[]
}

interface TelegramBridgeSessionMapEntry {
  agentSlug: string
  targetKind: 'craft'
  craftSessionId: string
  conversationId: string
  chatId: string
  threadId?: number
  lastPromptAt: number
  updatedAt: number
}

interface TelegramBridgeSessionMap {
  version: 1
  mappings: Record<string, TelegramBridgeSessionMapEntry>
}

interface TelegramBridgeCursor {
  version: 1
  offsets: Record<string, number>
}

export interface TelegramNormalizedEvent {
  kind: 'message' | 'callback'
  updateId: number
  messageId: number
  chatId: string
  threadId?: number
  text: string
  chatType?: string
  chatTitle?: string
  senderId: string
  senderDisplay: string
  senderUsername?: string
  sentAt: number
  raw: Record<string, unknown>
  callbackQueryId?: string
  callbackData?: string
}

interface TelegramBridgeDependencies {
  fetchImpl: typeof fetch
  now: () => number
  logger: {
    info: (...args: unknown[]) => void
    warn: (...args: unknown[]) => void
    error: (...args: unknown[]) => void
  }
}

const DEFAULT_CONFIG: TelegramBridgeConfig = {
  enabled: false,
  apiBaseUrl: 'https://api.telegram.org',
  pollIntervalMs: 2500,
  requestTimeoutMs: 10000,
  agents: [
    {
      slug: 'craft',
      enabled: false,
      botTokenEnv: 'TELEGRAM_BOT_TOKEN',
      chatIds: [],
      allowedUserIds: [],
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
}

const DEFAULT_SESSION_MAP: TelegramBridgeSessionMap = {
  version: 1,
  mappings: {},
}

const DEFAULT_CURSOR: TelegramBridgeCursor = {
  version: 1,
  offsets: {},
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(path, 'utf-8')
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function resolveSecret(value: string | undefined, envName: string | undefined): string {
  if (value?.trim()) return value.trim()
  if (envName?.trim()) return process.env[envName.trim()]?.trim() ?? ''
  return ''
}

function getNestedValue(value: unknown, path: string[]): unknown {
  let current: unknown = value
  for (const key of path) {
    if (!isRecord(current)) return undefined
    current = current[key]
  }
  return current
}

function getNestedString(value: unknown, path: string[]): string | undefined {
  const nested = getNestedValue(value, path)
  return typeof nested === 'string' && nested.trim() ? nested.trim() : undefined
}

function getNestedNumber(value: unknown, path: string[]): number | undefined {
  const nested = getNestedValue(value, path)
  return typeof nested === 'number' && Number.isFinite(nested) ? nested : undefined
}

function resolveTelegramAgentHome(): string {
  const configDir = process.env.CRAFT_CONFIG_DIR?.trim() || CONFIG_DIR
  return join(configDir, SERVICE_DIRNAME)
}

function buildConversationKey(chatId: string, threadId?: number): string {
  return `${chatId}:${threadId ?? 'root'}`
}

function buildSessionMapKey(agentSlug: string, chatId: string, threadId?: number): string {
  return `${agentSlug}:${buildConversationKey(chatId, threadId)}`
}

function pickTelegramText(message: Record<string, unknown>): string | undefined {
  const text = typeof message.text === 'string' ? message.text.trim() : ''
  if (text) return text
  const caption = typeof message.caption === 'string' ? message.caption.trim() : ''
  if (caption) return caption
  return undefined
}

function buildTelegramSenderDisplay(message: Record<string, unknown>): { display: string; username?: string } {
  const username = getNestedString(message, ['from', 'username'])
  const firstName = getNestedString(message, ['from', 'first_name'])
  const lastName = getNestedString(message, ['from', 'last_name'])
  const fullName = [firstName, lastName].filter(Boolean).join(' ').trim()
  if (fullName) return { display: fullName, username }
  if (username) return { display: `@${username}`, username }
  return { display: 'Unknown sender' }
}

export function normalizeTelegramUpdate(payload: unknown): TelegramNormalizedEvent | null {
  if (!isRecord(payload)) return null

  const updateId = typeof payload.update_id === 'number' ? payload.update_id : null
  if (updateId == null) return null

  const callbackQuery = isRecord(payload.callback_query) ? payload.callback_query : null
  if (callbackQuery) {
    const callbackId = typeof callbackQuery.id === 'string' && callbackQuery.id.trim()
      ? callbackQuery.id.trim()
      : null
    const callbackData = typeof callbackQuery.data === 'string' && callbackQuery.data.trim()
      ? callbackQuery.data.trim()
      : null
    const message = isRecord(callbackQuery.message) ? callbackQuery.message : null
    if (!callbackId || !callbackData || !message) return null

    const chatIdValue = getNestedValue(message, ['chat', 'id'])
    const chatId = typeof chatIdValue === 'number' || typeof chatIdValue === 'string'
      ? String(chatIdValue)
      : null
    const messageId = typeof message.message_id === 'number' ? message.message_id : null
    const sentAtSeconds = typeof message.date === 'number' ? message.date : Math.floor(Date.now() / 1000)
    const senderIdValue = getNestedValue(callbackQuery, ['from', 'id'])
    const senderId = typeof senderIdValue === 'number' || typeof senderIdValue === 'string'
      ? String(senderIdValue)
      : null
    if (!chatId || messageId == null || !senderId) return null

    const threadId = typeof message.message_thread_id === 'number' ? message.message_thread_id : undefined
    const chatTitle = getNestedString(message, ['chat', 'title'])
      || getNestedString(message, ['chat', 'username'])
      || getNestedString(message, ['chat', 'first_name'])
      || undefined
    const { display, username } = buildTelegramSenderDisplay(callbackQuery)

    return {
      kind: 'callback',
      updateId,
      messageId,
      chatId,
      threadId,
      text: callbackData,
      chatType: getNestedString(message, ['chat', 'type']),
      chatTitle,
      senderId,
      senderDisplay: display,
      senderUsername: username,
      sentAt: sentAtSeconds * 1000,
      raw: payload,
      callbackQueryId: callbackId,
      callbackData,
    }
  }

  const message = isRecord(payload.message) ? payload.message : null
  if (!message) return null

  const isBot = getNestedValue(message, ['from', 'is_bot']) === true
  if (isBot) return null

  const text = pickTelegramText(message)
  const chatIdValue = getNestedValue(message, ['chat', 'id'])
  const messageId = typeof message.message_id === 'number' ? message.message_id : null
  const sentAtSeconds = typeof message.date === 'number' ? message.date : null
  if (!text || messageId == null || sentAtSeconds == null) return null

  const chatId = typeof chatIdValue === 'number' || typeof chatIdValue === 'string'
    ? String(chatIdValue)
    : null
  if (!chatId) return null

  const { display, username } = buildTelegramSenderDisplay(message)
  const senderIdValue = getNestedValue(message, ['from', 'id'])
  const senderId = typeof senderIdValue === 'number' || typeof senderIdValue === 'string'
    ? String(senderIdValue)
    : null
  const threadId = typeof message.message_thread_id === 'number' ? message.message_thread_id : undefined
  const chatTitle = getNestedString(message, ['chat', 'title'])
    || getNestedString(message, ['chat', 'username'])
    || getNestedString(message, ['chat', 'first_name'])
    || undefined
  if (!senderId) return null

  return {
    kind: 'message',
    updateId,
    messageId,
    chatId,
    threadId,
    text,
    chatType: getNestedString(message, ['chat', 'type']),
    chatTitle,
    senderId,
    senderDisplay: display,
    senderUsername: username,
    sentAt: sentAtSeconds * 1000,
    raw: payload,
  }
}

export function buildTelegramSessionName(
  event: Pick<TelegramNormalizedEvent, 'chatTitle' | 'chatId' | 'threadId' | 'senderDisplay' | 'text'>,
  prefix = 'Telegram',
): string {
  const parts = [prefix + ':']
  if (event.chatTitle?.trim()) {
    parts.push(event.chatTitle.trim())
  } else {
    parts.push(event.senderDisplay.trim() || event.chatId)
  }
  if (typeof event.threadId === 'number') {
    parts.push(`#${event.threadId}`)
  }
  return parts.join(' ').slice(0, 120)
}

function buildTelegramPrompt(event: TelegramNormalizedEvent): string {
  const metadata = [
    '[Telegram]',
    `Chat ID: ${event.chatId}`,
    event.chatTitle ? `Chat: ${event.chatTitle}` : null,
    event.chatType ? `Chat Type: ${event.chatType}` : null,
    typeof event.threadId === 'number' ? `Topic ID: ${event.threadId}` : null,
    `Sender: ${event.senderDisplay}${event.senderUsername ? ` (${event.senderUsername})` : ''}`,
    `Message ID: ${event.messageId}`,
    `Sent At: ${new Date(event.sentAt).toISOString()}`,
  ].filter((value): value is string => !!value)

  return `${metadata.join('\n')}\n\n${event.text}`.trim()
}

function isAnthropicLikeProvider(providerType?: string): boolean {
  return providerType === 'anthropic'
    || providerType === 'anthropic_compat'
    || providerType === 'bedrock'
    || providerType === 'vertex'
}

function shouldPreferClaudeConnection(model?: string): boolean {
  return typeof model === 'string' && /claude/i.test(model)
}

function resolveCraftBridgeConnectionSlug(workspaceRootPath: string, target: CraftTargetConfig): string | undefined {
  if (target.llmConnection?.trim()) {
    return target.llmConnection.trim()
  }

  if (!shouldPreferClaudeConnection(target.model)) {
    return undefined
  }

  const workspaceDefault = loadWorkspaceConfig(workspaceRootPath)?.defaults?.defaultLlmConnection
  const candidates = [
    workspaceDefault,
    getDefaultLlmConnection(),
    ...getLlmConnections().map(connection => connection.slug),
  ].filter((slug): slug is string => !!slug)

  const seen = new Set<string>()
  for (const slug of candidates) {
    if (seen.has(slug)) continue
    seen.add(slug)
    const connection = getLlmConnection(slug)
    if (connection && isAnthropicLikeProvider(connection.providerType)) {
      return slug
    }
  }

  return undefined
}

function resolveCraftBridgeEnabledSourceSlugs(workspaceRootPath: string): string[] | undefined {
  const defaults = loadWorkspaceConfig(workspaceRootPath)?.defaults?.enabledSourceSlugs
  if (!Array.isArray(defaults) || defaults.length === 0) return undefined

  return defaults.filter((slug): slug is string => typeof slug === 'string' && slug !== 'linear-cli')
}

function resolveTelegramSessionLabels(workspaceRootPath: string, labels?: string[]): string[] | undefined {
  if (!isValidLabelId(workspaceRootPath, 'telegram')) return labels
  return Array.from(new Set(['telegram', ...(labels ?? [])]))
}

function getLatestAssistantId(session: TelegramBridgeSessionLike | null): string | undefined {
  const messages = session?.messages ?? []
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role === 'assistant' && !message.isIntermediate) {
      return message.id
    }
  }
  return undefined
}

function extractLatestAssistantReply(session: TelegramBridgeSessionLike | null, previousAssistantId?: string): string | null {
  const messages = session?.messages ?? []
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role !== 'assistant' || message.isIntermediate) continue
    if (previousAssistantId && message.id === previousAssistantId) return null
    const content = message.content?.trim()
    if (!content) return null
    return content
  }
  return null
}

function extractLatestErrorMessage(session: TelegramBridgeSessionLike | null): string | null {
  const messages = session?.messages ?? []
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role !== 'error' || message.isIntermediate) continue
    const content = message.content?.trim()
    if (!content) return null
    return content
  }
  return null
}

export function formatTelegramMessageText(markdown: string): string {
  let text = markdown.replace(/\r\n/g, '\n').trim()
  if (!text) return ''

  text = text.replace(/```([a-zA-Z0-9_-]+)?\n([\s\S]*?)```/g, (_match, language: string | undefined, code: string) => {
    const label = language?.trim() ? `${language.trim()} 코드:` : '코드:'
    return `${label}\n${code.trimEnd()}`
  })

  text = text.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, (_match, alt: string, url: string) => {
    const label = alt.trim()
    return label ? `${label} - ${url}` : url
  })

  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label: string, url: string) => {
    return `${label.trim()} - ${url}`
  })

  text = text.replace(/^#{1,6}\s+(.*)$/gm, (_match, heading: string) => heading.trim())
  text = text.replace(/^>\s?/gm, '인용: ')
  text = text.replace(/^\s*[-*+]\s+/gm, '- ')
  text = text.replace(/^\s*(\d+)\.\s+/gm, '$1. ')
  text = text.replace(/^\s*---+\s*$/gm, '')

  text = text.replace(/\*\*([^*]+)\*\*/g, '$1')
  text = text.replace(/__([^_]+)__/g, '$1')
  text = text.replace(/~~([^~]+)~~/g, '$1')
  text = text.replace(/`([^`]+)`/g, '$1')
  text = text.replace(/^\s*\[\s*\]\s+/gm, '- ')
  text = text.replace(/^\s*\[[xX]\]\s+/gm, '- ')
  text = text.replace(/\\([\\`*_{}\[\]()#+\-.!>])/g, '$1')
  text = text.replace(/\n{3,}/g, '\n\n')

  return text.trim()
}

function chunkTelegramMessage(text: string, limit = TELEGRAM_MESSAGE_LIMIT): string[] {
  const normalized = text.trim()
  if (normalized.length <= limit) return [normalized]

  const chunks: string[] = []
  let remaining = normalized
  while (remaining.length > limit) {
    const slice = remaining.slice(0, limit)
    const breakAt = Math.max(slice.lastIndexOf('\n\n'), slice.lastIndexOf('\n'), slice.lastIndexOf(' '))
    const chunkSize = breakAt > limit * 0.5 ? breakAt : limit
    chunks.push(remaining.slice(0, chunkSize).trim())
    remaining = remaining.slice(chunkSize).trim()
  }
  if (remaining) chunks.push(remaining)
  return chunks
}

function parseTelegramCommand(text: string): TelegramCommand | null {
  const trimmed = text.trim()
  const match = trimmed.match(/^\/(?<command>[a-zA-Z0-9_]+)(?:@[a-zA-Z0-9_]+)?(?:\s+(?<rest>[\s\S]*))?$/)
  const command = match?.groups?.command?.toLowerCase()
  if (command === 'settings') {
    return { type: 'settings' }
  }
  if (command !== 'new') return null

  const remainder = match?.groups?.rest?.trim()
  return {
    type: 'new',
    remainder: remainder || undefined,
  }
}

function parseTelegramCallbackCommand(data: string): TelegramCallbackCommand | null {
  if (!data.startsWith(`${TELEGRAM_CALLBACK_PREFIX}:`)) return null
  const parts = data.split(':')
  if (parts[1] === 'menu') return { type: 'menu' }
  if (parts[1] === 'new') return { type: 'new' }
  if (parts[1] === 'stop') return { type: 'stop' }
  if (parts[1] === 'sources') return { type: 'sources' }
  if (parts[1] === 'back') return { type: 'back' }
  if (parts[1] === 'src' && parts[2]) {
    return { type: 'toggle-source', slug: parts.slice(2).join(':') }
  }
  return null
}

function basenameLike(pathValue: string): string {
  const normalized = pathValue.replace(/\\/g, '/')
  const parts = normalized.split('/').filter(Boolean)
  return parts[parts.length - 1] || pathValue
}

function describeTool(message: NonNullable<TelegramBridgeSessionLike['messages']>[number]): string {
  const displayName = message.toolDisplayName?.trim()
  if (displayName) return displayName

  const intent = message.toolIntent?.trim()
  if (intent) return intent

  const input = message.toolInput
  if (typeof input?.description === 'string' && input.description.trim()) {
    return input.description.trim()
  }

  if (typeof input?.file_path === 'string' && input.file_path.trim()) {
    return `${message.toolName || '도구'} ${basenameLike(input.file_path.trim())}`
  }

  if (typeof input?.path === 'string' && input.path.trim()) {
    return `${message.toolName || '도구'} ${basenameLike(input.path.trim())}`
  }

  if (typeof input?.pattern === 'string' && input.pattern.trim()) {
    return `${message.toolName || '도구'} "${input.pattern.trim()}"`
  }

  if (typeof input?.command === 'string' && input.command.trim()) {
    const command = input.command.trim().replace(/\s+/g, ' ')
    const head = command.length > 60 ? `${command.slice(0, 57)}...` : command
    return `${message.toolName || '명령'} ${head}`
  }

  if (typeof input?.skill === 'string' && input.skill.trim()) {
    return `Skill ${input.skill.trim()}`
  }

  return message.toolName?.trim() || '도구 실행'
}

function buildProgressText(session: TelegramBridgeSessionLike | null, baselineMessageCount: number): string {
  const messages = session?.messages?.slice(baselineMessageCount) ?? []
  const latestTool = [...messages].reverse().find(message => message?.role === 'tool')
  if (latestTool) {
    const toolLabel = describeTool(latestTool)
    const toolStatus = latestTool.toolStatus
    if (toolStatus === 'error' || latestTool.isError) {
      return `도구 오류 확인 중...\n${toolLabel}`
    }
    if (toolStatus === 'completed') {
      return `도구 실행 완료\n${toolLabel}`
    }
    if (toolStatus === 'backgrounded') {
      return `백그라운드 작업 시작\n${toolLabel}`
    }
    return `도구 사용 중...\n${toolLabel}`
  }

  const latestInfo = [...messages].reverse().find(message =>
    (message?.role === 'status' || message?.role === 'info') && message.content?.trim(),
  )
  if (latestInfo?.content?.trim()) {
    const summary = latestInfo.content.trim()
    return summary.length > 180 ? `${summary.slice(0, 177)}...` : summary
  }

  const latestIntermediate = [...messages].reverse().find(message =>
    message?.role === 'assistant' && message.isIntermediate && message.content?.trim(),
  )
  if (latestIntermediate?.content?.trim()) {
    const summary = latestIntermediate.content.trim()
    const clipped = summary.length > 180 ? `${summary.slice(0, 177)}...` : summary
    return `응답 정리 중...\n${clipped}`
  }

  return TELEGRAM_PROGRESS_FALLBACK
}

function buildMainSettingsKeyboard(): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '새 세션', callback_data: `${TELEGRAM_CALLBACK_PREFIX}:new` },
        { text: '중지', callback_data: `${TELEGRAM_CALLBACK_PREFIX}:stop` },
      ],
      [
        { text: '소스 선택', callback_data: `${TELEGRAM_CALLBACK_PREFIX}:sources` },
      ],
    ],
  }
}

function buildSourceSettingsKeyboard(
  availableSources: Array<{ slug: string; name: string }>,
  enabledSourceSlugs: string[],
): TelegramInlineKeyboardMarkup {
  const enabled = new Set(enabledSourceSlugs)
  const buttons = availableSources.map<TelegramInlineKeyboardButton>(source => ({
    text: `${enabled.has(source.slug) ? '✅' : '⬜️'} ${source.name}`,
    callback_data: `${TELEGRAM_CALLBACK_PREFIX}:src:${source.slug}`,
  }))

  const rows: TelegramInlineKeyboardButton[][] = []
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2))
  }
  rows.push([{ text: '뒤로', callback_data: `${TELEGRAM_CALLBACK_PREFIX}:back` }])
  return { inline_keyboard: rows }
}

function buildSettingsSummaryText(
  session: TelegramBridgeSessionLike | null,
  availableSources: Array<{ slug: string; name: string }>,
): string {
  const enabledSlugs = session?.enabledSourceSlugs ?? []
  const enabledSourceNames = availableSources
    .filter(source => enabledSlugs.includes(source.slug))
    .map(source => source.name)
  const sourceSummary = enabledSourceNames.length > 0
    ? enabledSourceNames.join(', ')
    : '없음'

  return [
    'Craft Telegram 설정',
    '',
    `세션: ${session?.name || session?.id || '없음'}`,
    `상태: ${session?.isProcessing ? '응답 중' : '대기 중'}`,
    `활성 소스: ${sourceSummary}`,
  ].join('\n')
}

function buildSourceSettingsText(
  session: TelegramBridgeSessionLike | null,
  availableSources: Array<{ slug: string; name: string }>,
): string {
  const enabled = new Set(session?.enabledSourceSlugs ?? [])
  const lines = availableSources.map(source => `${enabled.has(source.slug) ? '✅' : '⬜️'} ${source.name}`)
  return [
    '소스 선택',
    '',
    ...lines,
    '',
    '버튼을 눌러 소스를 켜고 끌 수 있습니다.',
  ].join('\n')
}

interface TelegramApiEnvelope<T> {
  ok: boolean
  result?: T
  description?: string
}

type TelegramUpdateResult = Array<Record<string, unknown>>
type TelegramSendMessageResult = {
  message_id: number
}

type TelegramProgressHandle = {
  stop: () => Promise<void>
}

type TelegramCommand =
  | {
    type: 'new'
    remainder?: string
  }
  | {
    type: 'settings'
  }

type TelegramCallbackCommand =
  | { type: 'menu' }
  | { type: 'new' }
  | { type: 'stop' }
  | { type: 'sources' }
  | { type: 'back' }
  | { type: 'toggle-source'; slug: string }

type TelegramInlineKeyboardButton = {
  text: string
  callback_data: string
}

type TelegramInlineKeyboardMarkup = {
  inline_keyboard: TelegramInlineKeyboardButton[][]
}

export class TelegramAgentBridgeService {
  private readonly workspaceId: string
  private readonly workspaceRootPath: string
  private readonly sessionManager: TelegramBridgeSessionManagerLike
  private readonly deps: TelegramBridgeDependencies
  private readonly serviceDir: string
  private readonly configPath: string
  private readonly sessionMapPath: string
  private readonly eventsPath: string
  private readonly cursorPath: string

  private started = false
  private stopped = false
  private readonly pollTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly inFlightConversations = new Map<string, Promise<void>>()

  constructor(options: {
    workspaceId: string
    workspaceRootPath: string
    sessionManager: TelegramBridgeSessionManagerLike
    deps?: Partial<TelegramBridgeDependencies>
  }) {
    this.workspaceId = options.workspaceId
    this.workspaceRootPath = options.workspaceRootPath
    this.sessionManager = options.sessionManager
    this.deps = {
      fetchImpl: options.deps?.fetchImpl ?? fetch,
      now: options.deps?.now ?? (() => Date.now()),
      logger: options.deps?.logger ?? telegramBridgeLog,
    }
    this.serviceDir = resolveTelegramAgentHome()
    this.configPath = join(this.serviceDir, CONFIG_FILENAME)
    this.sessionMapPath = join(this.serviceDir, SESSION_MAP_FILENAME)
    this.eventsPath = join(this.serviceDir, EVENTS_LOG_FILENAME)
    this.cursorPath = join(this.serviceDir, CURSOR_FILENAME)
  }

  async start(): Promise<void> {
    if (this.started) return

    await this.ensureStorageFiles()
    const config = await this.readConfig()
    if (!config.enabled) {
      this.deps.logger.info('[telegram-agent] service disabled by config')
      return
    }

    const enabledAgents = config.agents.filter(agent => agent.enabled)
    if (enabledAgents.length === 0) {
      this.deps.logger.info('[telegram-agent] no enabled bridge agents configured')
      return
    }

    this.stopped = false
    this.started = true
    for (const agent of enabledAgents) {
      this.schedulePoll(agent.slug, 0)
    }

    this.deps.logger.info('[telegram-agent] service started', {
      agents: enabledAgents.map(agent => ({
        slug: agent.slug,
        chatIds: agent.chatIds ?? [],
        target: agent.target.kind,
      })),
    })
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.started = false
    for (const timer of this.pollTimers.values()) {
      clearTimeout(timer)
    }
    this.pollTimers.clear()
  }

  private async ensureStorageFiles(): Promise<void> {
    await mkdir(this.serviceDir, { recursive: true })
    if (!existsSync(this.configPath)) {
      await writeFile(this.configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8')
    }
    if (!existsSync(this.sessionMapPath)) {
      await writeFile(this.sessionMapPath, JSON.stringify(DEFAULT_SESSION_MAP, null, 2), 'utf-8')
    }
    if (!existsSync(this.cursorPath)) {
      await writeFile(this.cursorPath, JSON.stringify(DEFAULT_CURSOR, null, 2), 'utf-8')
    }
    if (!existsSync(this.eventsPath)) {
      await writeFile(this.eventsPath, '', 'utf-8')
    }
  }

  private async readConfig(): Promise<TelegramBridgeConfig> {
    const config = await readJsonFile(this.configPath, DEFAULT_CONFIG)
    return {
      ...DEFAULT_CONFIG,
      ...config,
      apiBaseUrl: config.apiBaseUrl || DEFAULT_CONFIG.apiBaseUrl,
      pollIntervalMs: config.pollIntervalMs || DEFAULT_CONFIG.pollIntervalMs,
      requestTimeoutMs: config.requestTimeoutMs || DEFAULT_CONFIG.requestTimeoutMs,
      agents: Array.isArray(config.agents) && config.agents.length > 0
        ? config.agents
        : DEFAULT_CONFIG.agents,
    }
  }

  private async readCursor(): Promise<TelegramBridgeCursor> {
    return await readJsonFile(this.cursorPath, DEFAULT_CURSOR)
  }

  private async writeCursor(cursor: TelegramBridgeCursor): Promise<void> {
    await writeFile(this.cursorPath, JSON.stringify(cursor, null, 2), 'utf-8')
  }

  private async readSessionMap(): Promise<TelegramBridgeSessionMap> {
    return await readJsonFile(this.sessionMapPath, DEFAULT_SESSION_MAP)
  }

  private async updateSessionMap(key: string, entry: TelegramBridgeSessionMapEntry): Promise<void> {
    const sessionMap = await this.readSessionMap()
    sessionMap.mappings[key] = entry
    await writeFile(this.sessionMapPath, JSON.stringify(sessionMap, null, 2), 'utf-8')
  }

  private async appendEvent(event: Record<string, unknown>): Promise<void> {
    const line = JSON.stringify({
      timestamp: new Date(this.deps.now()).toISOString(),
      ...event,
    })
    await appendFile(this.eventsPath, `${line}\n`, 'utf-8')
  }

  private async createCraftSession(
    agentConfig: TelegramBridgeAgentConfig,
    event: TelegramNormalizedEvent,
  ): Promise<TelegramBridgeSessionLike> {
    const session = await this.sessionManager.createSession(this.workspaceId, {
      name: buildTelegramSessionName(event, agentConfig.target.namePrefix || 'Telegram'),
      permissionMode: agentConfig.target.permissionMode,
      llmConnection: resolveCraftBridgeConnectionSlug(this.workspaceRootPath, agentConfig.target),
      model: agentConfig.target.model,
      labels: resolveTelegramSessionLabels(this.workspaceRootPath, agentConfig.target.labels),
      enabledSourceSlugs: resolveCraftBridgeEnabledSourceSlugs(this.workspaceRootPath),
      workingDirectory: agentConfig.target.workingDirectory,
    })
    if (agentConfig.target.thinkingLevel) {
      this.sessionManager.setSessionThinkingLevel?.(session.id, agentConfig.target.thinkingLevel)
    }
    this.sessionManager.notifySessionCreated?.(session.id)
    return session
  }

  private buildTelegramReplyBody(
    agentConfig: TelegramBridgeAgentConfig,
    event: TelegramNormalizedEvent,
    text: string,
    replyMarkup?: TelegramInlineKeyboardMarkup,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      chat_id: event.chatId,
      text,
    }
    if (replyMarkup) {
      body.reply_markup = replyMarkup
    }
    if (typeof event.threadId === 'number') {
      body.message_thread_id = event.threadId
    }
    if (agentConfig.replyToMessages !== false) {
      body.reply_to_message_id = event.messageId
    }
    return body
  }

  private async sendTelegramChatAction(
    botToken: string,
    config: TelegramBridgeConfig,
    event: TelegramNormalizedEvent,
    action: 'typing' = 'typing',
  ): Promise<void> {
    const body: Record<string, unknown> = {
      chat_id: event.chatId,
      action,
    }
    if (typeof event.threadId === 'number') {
      body.message_thread_id = event.threadId
    }
    await this.callTelegramApi(botToken, config, 'sendChatAction', body)
  }

  private async deleteTelegramMessage(
    botToken: string,
    config: TelegramBridgeConfig,
    event: TelegramNormalizedEvent,
    messageId: number,
  ): Promise<void> {
    const body: Record<string, unknown> = {
      chat_id: event.chatId,
      message_id: messageId,
    }
    await this.callTelegramApi(botToken, config, 'deleteMessage', body)
  }

  private async answerTelegramCallbackQuery(
    botToken: string,
    config: TelegramBridgeConfig,
    callbackQueryId: string,
    text?: string,
  ): Promise<void> {
    const body: Record<string, unknown> = {
      callback_query_id: callbackQueryId,
    }
    if (text?.trim()) body.text = text.trim()
    await this.callTelegramApi(botToken, config, 'answerCallbackQuery', body)
  }

  private async editTelegramMessage(
    botToken: string,
    config: TelegramBridgeConfig,
    event: TelegramNormalizedEvent,
    text: string,
    replyMarkup?: TelegramInlineKeyboardMarkup,
  ): Promise<void> {
    const body: Record<string, unknown> = {
      chat_id: event.chatId,
      message_id: event.messageId,
      text,
    }
    if (replyMarkup) body.reply_markup = replyMarkup
    await this.callTelegramApi(botToken, config, 'editMessageText', body)
  }

  private getAvailableSourceOptions(): Array<{ slug: string; name: string }> {
    return loadWorkspaceSources(this.workspaceRootPath)
      .filter(source => source.config.enabled)
      .map(source => ({
        slug: source.config.slug,
        name: source.config.name,
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  private async ensureConversationSession(
    agentConfig: TelegramBridgeAgentConfig,
    event: TelegramNormalizedEvent,
  ): Promise<{ mapKey: string; session: TelegramBridgeSessionLike; existingSessionId?: string }> {
    const mapKey = buildSessionMapKey(agentConfig.slug, event.chatId, event.threadId)
    const sessionMap = await this.readSessionMap()
    const existingEntry = sessionMap.mappings[mapKey]
    const existingSessionId = existingEntry?.craftSessionId
    const existingSession = existingSessionId
      ? await this.sessionManager.getSession(existingSessionId)
      : null

    let session = existingSession && !existingSession.isArchived
      ? existingSession
      : null

    if (!session) {
      session = await this.createCraftSession(agentConfig, event)
      await this.appendEvent({
        type: 'session_created',
        slug: agentConfig.slug,
        chatId: event.chatId,
        threadId: event.threadId,
        messageId: event.messageId,
        craftSessionId: session.id,
      })
    }

    await this.updateSessionMap(mapKey, {
      agentSlug: agentConfig.slug,
      targetKind: 'craft',
      craftSessionId: session.id,
      conversationId: buildConversationKey(event.chatId, event.threadId),
      chatId: event.chatId,
      threadId: event.threadId,
      lastPromptAt: this.deps.now(),
      updatedAt: this.deps.now(),
    })

    return { mapKey, session, existingSessionId }
  }

  private async showSettingsMenu(
    botToken: string,
    config: TelegramBridgeConfig,
    agentConfig: TelegramBridgeAgentConfig,
    event: TelegramNormalizedEvent,
    mode: 'main' | 'sources',
  ): Promise<void> {
    const { session } = await this.ensureConversationSession(agentConfig, event)
    const freshSession = await this.sessionManager.getSession(session.id) ?? session
    const availableSources = this.getAvailableSourceOptions()
    const text = mode === 'sources'
      ? buildSourceSettingsText(freshSession, availableSources)
      : buildSettingsSummaryText(freshSession, availableSources)
    const replyMarkup = mode === 'sources'
      ? buildSourceSettingsKeyboard(availableSources, freshSession.enabledSourceSlugs ?? [])
      : buildMainSettingsKeyboard()

    if (event.kind === 'callback') {
      await this.editTelegramMessage(botToken, config, event, text, replyMarkup)
      return
    }

    await this.callTelegramApi<TelegramSendMessageResult>(
      botToken,
      config,
      'sendMessage',
      this.buildTelegramReplyBody(agentConfig, event, text, replyMarkup),
    )
  }

  private async startProgressUpdates(
    botToken: string,
    config: TelegramBridgeConfig,
    agentConfig: TelegramBridgeAgentConfig,
    event: TelegramNormalizedEvent,
    sessionId: string,
    baselineMessageCount: number,
  ): Promise<TelegramProgressHandle> {
    let stopped = false
    let statusMessageId: number | undefined
    let lastStatusText: string | undefined
    let typingInFlight = false
    let pollInFlight = false

    const updateStatusMessage = async (text: string): Promise<void> => {
      const normalized = text.trim() || TELEGRAM_PROGRESS_FALLBACK
      if (normalized === lastStatusText) return

      if (typeof statusMessageId === 'number') {
        await this.callTelegramApi(botToken, config, 'editMessageText', {
          chat_id: event.chatId,
          message_id: statusMessageId,
          text: normalized,
        })
      } else {
        const result = await this.callTelegramApi<TelegramSendMessageResult>(
          botToken,
          config,
          'sendMessage',
          this.buildTelegramReplyBody(agentConfig, event, normalized),
        )
        statusMessageId = result.message_id
      }
      lastStatusText = normalized
    }

    const runTyping = async (): Promise<void> => {
      if (typingInFlight || stopped) return
      typingInFlight = true
      try {
        await this.sendTelegramChatAction(botToken, config, event)
      } catch (error) {
        this.deps.logger.warn('[telegram-agent] typing indicator failed', {
          chatId: event.chatId,
          messageId: event.messageId,
          error: error instanceof Error ? error.message : String(error),
        })
      } finally {
        typingInFlight = false
      }
    }

    const runPoll = async (): Promise<void> => {
      if (pollInFlight || stopped) return
      pollInFlight = true
      try {
        const liveSession = await this.sessionManager.getSession(sessionId)
        await updateStatusMessage(buildProgressText(liveSession, baselineMessageCount))
      } catch (error) {
        this.deps.logger.warn('[telegram-agent] progress polling failed', {
          sessionId,
          chatId: event.chatId,
          error: error instanceof Error ? error.message : String(error),
        })
      } finally {
        pollInFlight = false
      }
    }

    await updateStatusMessage(TELEGRAM_PROGRESS_FALLBACK)
    await runTyping()

    const typingTimer = setInterval(() => {
      void runTyping()
    }, TELEGRAM_TYPING_INTERVAL_MS)
    const pollTimer = setInterval(() => {
      void runPoll()
    }, TELEGRAM_PROGRESS_POLL_MS)

    return {
      stop: async () => {
        if (stopped) return
        stopped = true
        clearInterval(typingTimer)
        clearInterval(pollTimer)
        if (typeof statusMessageId !== 'number') return
        try {
          await this.deleteTelegramMessage(botToken, config, event, statusMessageId)
        } catch (error) {
          this.deps.logger.warn('[telegram-agent] failed to clear progress message', {
            chatId: event.chatId,
            messageId: event.messageId,
            statusMessageId,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      },
    }
  }

  private schedulePoll(agentSlug: string, delayMs: number): void {
    const existing = this.pollTimers.get(agentSlug)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      void this.pollAgent(agentSlug)
    }, Math.max(delayMs, 0))
    this.pollTimers.set(agentSlug, timer)
  }

  private async pollAgent(agentSlug: string): Promise<void> {
    if (this.stopped) return

    const config = await this.readConfig()
    const agentConfig = config.agents.find(agent => agent.enabled && agent.slug === agentSlug)
    if (!agentConfig) return

    const botToken = resolveSecret(agentConfig.botToken, agentConfig.botTokenEnv)
    if (!botToken) {
      this.deps.logger.warn('[telegram-agent] missing bot token, skipping poll', { slug: agentConfig.slug })
      this.schedulePoll(agentSlug, config.pollIntervalMs)
      return
    }

    try {
      const cursor = await this.readCursor()
      const offset = cursor.offsets[agentSlug]
      const updates = await this.callTelegramApi<TelegramUpdateResult>(
        botToken,
        config,
        'getUpdates',
        {
          offset: typeof offset === 'number' ? offset + 1 : undefined,
          limit: 50,
          timeout: 0,
          allowed_updates: ['message', 'callback_query'],
        },
      )

      let latestUpdateId = offset
      for (const update of updates) {
        const updateId = typeof update.update_id === 'number' ? update.update_id : undefined
        if (typeof updateId === 'number') {
          latestUpdateId = typeof latestUpdateId === 'number'
            ? Math.max(latestUpdateId, updateId)
            : updateId
        }

        const event = normalizeTelegramUpdate(update)
        if (!event) continue
        if (!this.isAllowedChat(agentConfig, event.chatId)) continue
        if (!this.isAllowedSender(agentConfig, event.senderId, event.senderUsername)) continue

        const conversationKey = buildSessionMapKey(agentConfig.slug, event.chatId, event.threadId)
        this.enqueueConversation(conversationKey, async () => {
          try {
            await this.processEvent(agentConfig, botToken, event)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            this.deps.logger.error('[telegram-agent] processing failed', {
              slug: agentConfig.slug,
              chatId: event.chatId,
              messageId: event.messageId,
              error: message,
            })
            await this.appendEvent({
              type: 'process_error',
              slug: agentConfig.slug,
              chatId: event.chatId,
              messageId: event.messageId,
              error: message,
            })
            await this.sendTelegramReply(botToken, config, agentConfig, event, `Bridge failed: ${message}`)
          }
        })
      }

      if (typeof latestUpdateId === 'number' && latestUpdateId !== offset) {
        cursor.offsets[agentSlug] = latestUpdateId
        await this.writeCursor(cursor)
      }
    } catch (error) {
      this.deps.logger.error('[telegram-agent] polling failed', {
        slug: agentConfig.slug,
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      if (!this.stopped) {
        this.schedulePoll(agentSlug, config.pollIntervalMs)
      }
    }
  }

  private enqueueConversation(conversationKey: string, task: () => Promise<void>): void {
    const previous = this.inFlightConversations.get(conversationKey) ?? Promise.resolve()
    const next = previous
      .catch(() => {})
      .then(task)
      .finally(() => {
        if (this.inFlightConversations.get(conversationKey) === next) {
          this.inFlightConversations.delete(conversationKey)
        }
      })
    this.inFlightConversations.set(conversationKey, next)
  }

  private isAllowedChat(agentConfig: TelegramBridgeAgentConfig, chatId: string): boolean {
    const allowed = (agentConfig.chatIds ?? []).map(value => String(value).trim()).filter(Boolean)
    if (allowed.length === 0) return true
    return allowed.includes(chatId)
  }

  private isAllowedSender(agentConfig: TelegramBridgeAgentConfig, senderId: string, username?: string): boolean {
    const allowedIds = (agentConfig.allowedUserIds ?? []).map(value => String(value).trim()).filter(Boolean)
    if (allowedIds.length > 0 && !allowedIds.includes(senderId)) {
      return false
    }

    const allowed = (agentConfig.allowedUsernames ?? []).map(value => value.trim().replace(/^@/, '')).filter(Boolean)
    if (allowed.length === 0) return true
    if (!username) return false
    return allowed.includes(username.replace(/^@/, ''))
  }

  private async processEvent(
    agentConfig: TelegramBridgeAgentConfig,
    botToken: string,
    event: TelegramNormalizedEvent,
  ): Promise<void> {
    const config = await this.readConfig()

    if (event.kind === 'callback' && event.callbackData && event.callbackQueryId) {
      const callback = parseTelegramCallbackCommand(event.callbackData)
      if (!callback) {
        await this.answerTelegramCallbackQuery(botToken, config, event.callbackQueryId, '알 수 없는 작업입니다.')
        return
      }

      const availableSources = this.getAvailableSourceOptions()
      const { session, existingSessionId } = await this.ensureConversationSession(agentConfig, event)
      switch (callback.type) {
        case 'menu':
        case 'back':
          await this.showSettingsMenu(botToken, config, agentConfig, event, 'main')
          await this.answerTelegramCallbackQuery(botToken, config, event.callbackQueryId)
          return

        case 'sources':
          await this.showSettingsMenu(botToken, config, agentConfig, event, 'sources')
          await this.answerTelegramCallbackQuery(botToken, config, event.callbackQueryId)
          return

        case 'new': {
          if (existingSessionId && !session.isArchived) {
            await this.sessionManager.archiveSession?.(existingSessionId)
          }
          const newSession = await this.createCraftSession(agentConfig, event)
          await this.updateSessionMap(buildSessionMapKey(agentConfig.slug, event.chatId, event.threadId), {
            agentSlug: agentConfig.slug,
            targetKind: 'craft',
            craftSessionId: newSession.id,
            conversationId: buildConversationKey(event.chatId, event.threadId),
            chatId: event.chatId,
            threadId: event.threadId,
            lastPromptAt: this.deps.now(),
            updatedAt: this.deps.now(),
          })
          await this.showSettingsMenu(botToken, config, agentConfig, event, 'main')
          await this.answerTelegramCallbackQuery(botToken, config, event.callbackQueryId, '새 세션으로 전환했습니다.')
          return
        }

        case 'stop':
          if (session.isProcessing) {
            await this.sessionManager.cancelProcessing?.(session.id, false)
            await this.showSettingsMenu(botToken, config, agentConfig, event, 'main')
            await this.answerTelegramCallbackQuery(botToken, config, event.callbackQueryId, '현재 응답을 중지했습니다.')
          } else {
            await this.answerTelegramCallbackQuery(botToken, config, event.callbackQueryId, '현재 진행 중인 응답이 없습니다.')
          }
          return

        case 'toggle-source': {
          const sourceExists = availableSources.some(source => source.slug === callback.slug)
          if (!sourceExists) {
            await this.answerTelegramCallbackQuery(botToken, config, event.callbackQueryId, '알 수 없는 소스입니다.')
            return
          }
          const current = new Set(session.enabledSourceSlugs ?? [])
          if (current.has(callback.slug)) {
            current.delete(callback.slug)
          } else {
            current.add(callback.slug)
          }
          await this.sessionManager.setSessionSources?.(session.id, Array.from(current))
          await this.showSettingsMenu(botToken, config, agentConfig, event, 'sources')
          await this.answerTelegramCallbackQuery(botToken, config, event.callbackQueryId, '소스 설정을 업데이트했습니다.')
          return
        }
      }
    }

    await this.appendEvent({
      type: 'message',
      slug: agentConfig.slug,
      updateId: event.updateId,
      chatId: event.chatId,
      threadId: event.threadId,
      messageId: event.messageId,
      sender: event.senderDisplay,
      preview: event.text.slice(0, 200),
    })

    const command = parseTelegramCommand(event.text)
    if (command?.type === 'settings') {
      await this.showSettingsMenu(botToken, config, agentConfig, event, 'main')
      return
    }

    const effectiveEvent = command?.type === 'new' && command.remainder
      ? { ...event, text: command.remainder }
      : event

    if (command?.type === 'new') {
      const mapKey = buildSessionMapKey(agentConfig.slug, event.chatId, event.threadId)
      const sessionMap = await this.readSessionMap()
      const existingEntry = sessionMap.mappings[mapKey]
      const existingSessionId = existingEntry?.craftSessionId
      const existingSession = existingSessionId
        ? await this.sessionManager.getSession(existingSessionId)
        : null

      if (existingSessionId && existingSession && !existingSession.isArchived) {
        await this.sessionManager.archiveSession?.(existingSessionId)
      }
      const resetSession = await this.createCraftSession(agentConfig, effectiveEvent)
      await this.updateSessionMap(mapKey, {
        agentSlug: agentConfig.slug,
        targetKind: 'craft',
        craftSessionId: resetSession.id,
        conversationId: buildConversationKey(event.chatId, event.threadId),
        chatId: event.chatId,
        threadId: event.threadId,
        lastPromptAt: this.deps.now(),
        updatedAt: this.deps.now(),
      })
      await this.appendEvent({
        type: 'session_reset',
        slug: agentConfig.slug,
        chatId: event.chatId,
        threadId: event.threadId,
        messageId: event.messageId,
        previousCraftSessionId: existingSessionId,
        craftSessionId: resetSession.id,
      })
      if (!command.remainder) {
        await this.sendTelegramReply(botToken, config, agentConfig, event, TELEGRAM_RESET_CONFIRMATION)
        return
      }

      const previousAssistantId = getLatestAssistantId(resetSession)
      const baselineMessageCount = resetSession.messages?.length ?? 0
      let progressHandle: TelegramProgressHandle = {
        stop: async () => {},
      }
      try {
        progressHandle = await this.startProgressUpdates(
          botToken,
          config,
          agentConfig,
          event,
          resetSession.id,
          baselineMessageCount,
        )
      } catch (error) {
        this.deps.logger.warn('[telegram-agent] progress setup failed, continuing without live updates', {
          sessionId: resetSession.id,
          chatId: event.chatId,
          messageId: event.messageId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      try {
        await this.sessionManager.sendMessage(resetSession.id, buildTelegramPrompt(effectiveEvent))
      } finally {
        await progressHandle.stop()
      }
      const finalSession = await this.sessionManager.getSession(resetSession.id)
      const finalReply = extractLatestAssistantReply(finalSession, previousAssistantId)
      if (!finalReply) {
        throw new Error(extractLatestErrorMessage(finalSession) || 'Craft session completed without a final assistant reply')
      }
      await this.sendTelegramReply(botToken, config, agentConfig, event, finalReply)
      await this.appendEvent({
        type: 'reply_sent',
        slug: agentConfig.slug,
        chatId: event.chatId,
        threadId: event.threadId,
        messageId: event.messageId,
        craftSessionId: resetSession.id,
        replyPreview: finalReply.slice(0, 200),
      })
      return
    }

    const { session } = await this.ensureConversationSession(agentConfig, effectiveEvent)
    const previousAssistantId = getLatestAssistantId(session)
    const baselineMessageCount = session.messages?.length ?? 0
    let progressHandle: TelegramProgressHandle = {
      stop: async () => {},
    }
    try {
      progressHandle = await this.startProgressUpdates(
        botToken,
        config,
        agentConfig,
        event,
        session.id,
        baselineMessageCount,
      )
    } catch (error) {
      this.deps.logger.warn('[telegram-agent] progress setup failed, continuing without live updates', {
        sessionId: session.id,
        chatId: event.chatId,
        messageId: event.messageId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    try {
      await this.sessionManager.sendMessage(session.id, buildTelegramPrompt(effectiveEvent))
    } finally {
      await progressHandle.stop()
    }
    const finalSession = await this.sessionManager.getSession(session.id)
    const finalReply = extractLatestAssistantReply(finalSession, previousAssistantId)
    if (!finalReply) {
      throw new Error(extractLatestErrorMessage(finalSession) || 'Craft session completed without a final assistant reply')
    }

    await this.sendTelegramReply(botToken, config, agentConfig, event, finalReply)
    await this.appendEvent({
      type: 'reply_sent',
      slug: agentConfig.slug,
      chatId: event.chatId,
      threadId: event.threadId,
      messageId: event.messageId,
      craftSessionId: session.id,
      replyPreview: finalReply.slice(0, 200),
    })
  }

  private async sendTelegramReply(
    botToken: string,
    config: TelegramBridgeConfig,
    agentConfig: TelegramBridgeAgentConfig,
    event: TelegramNormalizedEvent,
    reply: string,
  ): Promise<void> {
    const formattedReply = formatTelegramMessageText(reply)
    const chunks = chunkTelegramMessage(formattedReply)
    for (let index = 0; index < chunks.length; index++) {
      const body: Record<string, unknown> = {
        chat_id: event.chatId,
        text: chunks[index],
      }
      if (typeof event.threadId === 'number') {
        body.message_thread_id = event.threadId
      }
      if (agentConfig.replyToMessages !== false && index === 0) {
        body.reply_to_message_id = event.messageId
      }
      await this.callTelegramApi(botToken, config, 'sendMessage', body)
    }
  }

  private async callTelegramApi<T>(
    botToken: string,
    config: TelegramBridgeConfig,
    method: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const response = await this.deps.fetchImpl(
      `${config.apiBaseUrl.replace(/\/+$/, '')}/bot${botToken}/${method}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    )

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`Telegram ${method} failed with ${response.status}${text ? `: ${text}` : ''}`)
    }

    const json = await response.json() as TelegramApiEnvelope<T>
    if (!json.ok) {
      throw new Error(json.description || `Telegram ${method} failed`)
    }
    return json.result as T
  }
}
