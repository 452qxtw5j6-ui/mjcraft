import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { appendFile, mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { matchesCron } from '@craft-agent/shared/automations'
import { getCredentialManager } from '@craft-agent/shared/credentials'
import { SchedulerService, type SchedulerTickPayload } from '@craft-agent/shared/scheduler'
import {
  TokenRefreshManager,
  getSourceCredentialManager,
  loadWorkspaceSources,
  type LoadedSource,
} from '@craft-agent/shared/sources'
import log from './logger'
import { SlackGateway, type SlackGatewayClientLike } from './slack-gateway'

const notionTaskLog = log.scope('notion-ai')

const SERVICE_DIRNAME = '.notion-ai'
const CONFIG_FILENAME = 'config.json'
const LEDGER_FILENAME = 'ledger.json'
const EVENTS_LOG_FILENAME = 'events.jsonl'
const SLACK_BOT_TOKEN_SOURCE_ID = 'slack-bot-bot-token'

const NOTION_API_VERSION = '2025-09-03'
const NOTION_TEXT_LIMIT = 1900
const SLACK_TEXT_LIMIT = 3500
const SCHEMA_CACHE_TTL_MS = 5 * 60 * 1000

type PermissionMode = 'safe' | 'ask' | 'allow-all'
type TriggerType = 'checkbox' | 'status' | 'select' | 'multi_select' | 'rich_text' | 'title'
type StatusType = 'status' | 'select'

type JsonObject = Record<string, unknown>

interface NotionTaskSessionLike {
  id: string
  sessionOrigin?: 'manual' | 'notion' | 'slack'
  notionRef?: { pageId: string; dataSourceId: string; pageUrl?: string }
  slackRef?: { channelId: string; threadTs: string; rootMessageTs: string; permalink?: string }
  isArchived?: boolean
  messages?: Array<{
    id?: string
    role?: string
    content?: string
    isIntermediate?: boolean
  }>
}

interface NotionTaskSessionManagerLike {
  createSession(
    workspaceId: string,
    options?: {
      name?: string
      suppressCreatedEvent?: boolean
      permissionMode?: PermissionMode
      llmConnection?: string
      model?: string
      labels?: string[]
      workingDirectory?: string | 'user_default' | 'none'
      sessionOrigin?: 'manual' | 'notion' | 'slack'
      notionRef?: { pageId: string; dataSourceId: string; pageUrl?: string }
      slackRef?: { channelId: string; threadTs: string; rootMessageTs: string; permalink?: string }
    },
  ): Promise<NotionTaskSessionLike>
  getSession(sessionId: string): Promise<NotionTaskSessionLike | null>
  sendMessage(sessionId: string, message: string): Promise<void>
  notifySessionCreated?(sessionId: string): void
  findSessionByNotionPage?(workspaceId: string, pageId: string): Promise<NotionTaskSessionLike | null>
  linkSessionToSlack?(sessionId: string, slackRef: { channelId: string; threadTs: string; rootMessageTs: string; permalink?: string }): Promise<void>
  linkSessionToNotion?(sessionId: string, notionRef: { pageId: string; dataSourceId: string; pageUrl?: string }): Promise<void>
}

interface SchedulerLike {
  start(): void
  stop(): void
}

interface LoggerLike {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

interface NotionTaskSourceRef {
  notion: LoadedSource
  slack: LoadedSource
}

interface NotionSchemaProperty {
  id: string
  name: string
  type: string
}

interface NotionSchemaCache {
  loadedAt: number
  databaseId: string
  titlePropertyName: string | null
  titlePropertyId: string | null
  propertiesByName: Map<string, NotionSchemaProperty>
  propertiesById: Map<string, NotionSchemaProperty>
}

interface CandidatePage {
  id: string
  lastEditedTime: string
}

interface NotionLedgerEntry {
  lastProcessedEditedTime?: string
  contentHash?: string
  sessionId?: string
  status: 'done' | 'failed' | 'skipped'
  processedAt: string
}

interface NotionLedger {
  version: 1
  pages: Record<string, NotionLedgerEntry>
}

interface QueueItem {
  pageId: string
  reason: string
}

interface PageContentResult {
  markdown: string
  source: 'markdown' | 'blocks'
}

interface DetailedPage {
  id: string
  url?: string
  lastEditedTime: string
  properties: Record<string, JsonObject>
}

interface RuntimeConfigResult {
  config: NotionTaskConfig
  sources: NotionTaskSourceRef
  schema: NotionSchemaCache
}

interface NotionTaskServiceDependencies {
  fetchImpl: typeof fetch
  loadSources: typeof loadWorkspaceSources
  credentialManager: ReturnType<typeof getSourceCredentialManager>
  rawCredentialManager: ReturnType<typeof getCredentialManager>
  createSlackGateway: (sourceSlug: string) => SlackGatewayLike
  createScheduler: (onTick: (payload: SchedulerTickPayload) => Promise<void>) => SchedulerLike
  logger: LoggerLike
  now: () => Date
}

interface SlackGatewayLike {
  postMessage(args: { channel: string; text: string; threadTs?: string }, client?: SlackGatewayClientLike): Promise<{ ts: string }>
  updateMessage(args: { channel: string; ts: string; text: string }, client?: SlackGatewayClientLike): Promise<void>
  getPermalink(args: { channel: string; messageTs: string }, client?: SlackGatewayClientLike): Promise<string>
}

export interface NotionTaskConfig {
  enabled: boolean
  pollCron: string
  databaseId: string
  notionSourceSlug: string
  slackSourceSlug: string
  slackChannelId: string
  trigger: {
    property: string
    type: TriggerType
    value?: string | boolean
  }
  status: {
    property: string
    type?: StatusType
    readyValues: string[]
    runningValue: string
    doneValue: string
    failedValue: string
  }
  properties: {
    claimedAt: string
    processedAt: string
    sessionId: string
    slackUrl: string
    summary: string
  }
  session: {
    permissionMode: PermissionMode
    labels: string[]
    llmConnection?: string
    model?: string
    workingDirectory?: string | 'user_default' | 'none'
  }
  limits: {
    maxPageChars: number
    maxConcurrent: number
  }
}

export const DEFAULT_NOTION_TASK_CONFIG: Readonly<NotionTaskConfig> = {
  enabled: false,
  pollCron: '* * * * *',
  databaseId: '',
  notionSourceSlug: 'notion-api',
  slackSourceSlug: 'slack',
  slackChannelId: '',
  trigger: {
    property: 'AI',
    type: 'checkbox',
    value: true,
  },
  status: {
    property: 'AI Status',
    type: 'status',
    readyValues: ['Queued', 'Retry'],
    runningValue: 'Running',
    doneValue: 'Done',
    failedValue: 'Failed',
  },
  properties: {
    claimedAt: 'Claimed At',
    processedAt: 'Processed At',
    sessionId: 'Craft Session ID',
    slackUrl: 'Slack Report URL',
    summary: 'AI Summary',
  },
  session: {
    permissionMode: 'allow-all',
    labels: ['project::notion-ai'],
    workingDirectory: 'user_default',
  },
  limits: {
    maxPageChars: 8000,
    maxConcurrent: 1,
  },
}

const PROMPT_FRIENDLY_TYPES = new Set([
  'title',
  'rich_text',
  'number',
  'select',
  'multi_select',
  'status',
  'checkbox',
  'date',
  'url',
  'email',
  'phone_number',
  'formula',
  'created_time',
  'last_edited_time',
  'unique_id',
])

const MULTI_VALUE_TYPES = new Set(['relation', 'rollup', 'files', 'people', 'created_by', 'last_edited_by'])

function defaultSchedulerFactory(onTick: (payload: SchedulerTickPayload) => Promise<void>): SchedulerLike {
  return new SchedulerService(onTick)
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item)).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function toPlainText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''

  return value
    .map((item) => {
      if (!item || typeof item !== 'object') return ''
      const plainText = (item as Record<string, unknown>).plain_text
      if (typeof plainText === 'string') return plainText
      const text = (item as Record<string, unknown>).text
      if (text && typeof text === 'object') {
        const content = (text as Record<string, unknown>).content
        return typeof content === 'string' ? content : ''
      }
      return ''
    })
    .join('')
}

function readFormulaValue(formula: unknown): string {
  if (!formula || typeof formula !== 'object') return ''
  const typed = formula as Record<string, unknown>
  const type = typed.type
  if (type === 'string' && typeof typed.string === 'string') return typed.string
  if (type === 'number' && typeof typed.number === 'number') return String(typed.number)
  if (type === 'boolean' && typeof typed.boolean === 'boolean') return String(typed.boolean)
  if (type === 'date' && typed.date && typeof typed.date === 'object') {
    const start = (typed.date as Record<string, unknown>).start
    return typeof start === 'string' ? start : ''
  }
  return ''
}

function readStatusLikeName(value: unknown, key: 'status' | 'select'): string {
  if (!value || typeof value !== 'object') return ''
  const raw = (value as Record<string, unknown>)[key]
  if (!raw || typeof raw !== 'object') return ''
  const name = (raw as Record<string, unknown>).name
  return typeof name === 'string' ? name : ''
}

function readDateValue(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const raw = (value as Record<string, unknown>).date
  if (!raw || typeof raw !== 'object') return ''
  const start = (raw as Record<string, unknown>).start
  const end = (raw as Record<string, unknown>).end
  if (typeof start !== 'string' || !start) return ''
  return typeof end === 'string' && end ? `${start} -> ${end}` : start
}

function readUniqueIdValue(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const raw = (value as Record<string, unknown>).unique_id
  if (!raw || typeof raw !== 'object') return ''
  const prefix = typeof (raw as Record<string, unknown>).prefix === 'string' ? String((raw as Record<string, unknown>).prefix) : ''
  const number = typeof (raw as Record<string, unknown>).number === 'number' ? String((raw as Record<string, unknown>).number) : ''
  return `${prefix}${number}`
}

function readPropertyValue(property: JsonObject | undefined): string {
  if (!property) return ''
  switch (property.type) {
    case 'title':
      return toPlainText(property.title)
    case 'rich_text':
      return toPlainText(property.rich_text)
    case 'number':
      return typeof property.number === 'number' ? String(property.number) : ''
    case 'select':
      return readStatusLikeName(property, 'select')
    case 'status':
      return readStatusLikeName(property, 'status')
    case 'multi_select':
      return Array.isArray(property.multi_select)
        ? property.multi_select
          .map(item => (item && typeof item === 'object' && typeof (item as Record<string, unknown>).name === 'string')
            ? String((item as Record<string, unknown>).name)
            : '')
          .filter(Boolean)
          .join(', ')
        : ''
    case 'checkbox':
      return typeof property.checkbox === 'boolean' ? String(property.checkbox) : ''
    case 'date':
      return readDateValue(property)
    case 'url':
      return typeof property.url === 'string' ? property.url : ''
    case 'email':
      return typeof property.email === 'string' ? property.email : ''
    case 'phone_number':
      return typeof property.phone_number === 'string' ? property.phone_number : ''
    case 'formula':
      return readFormulaValue(property.formula)
    case 'created_time':
      return typeof property.created_time === 'string' ? property.created_time : ''
    case 'last_edited_time':
      return typeof property.last_edited_time === 'string' ? property.last_edited_time : ''
    case 'unique_id':
      return readUniqueIdValue(property)
    default:
      return ''
  }
}

function toNotionTextArray(value: string): Array<{ type: 'text'; text: { content: string } }> {
  const content = value.slice(0, NOTION_TEXT_LIMIT)
  if (!content) return []
  return [{ type: 'text', text: { content } }]
}

function buildPropertyUpdate(property: JsonObject | undefined, value: string | undefined): JsonObject | null {
  if (!property || value === undefined) return null

  switch (property.type) {
    case 'status':
      return { status: { name: value } }
    case 'select':
      return { select: { name: value } }
    case 'date':
      return { date: value ? { start: value } : null }
    case 'url':
      return { url: value || null }
    case 'email':
      return { email: value || null }
    case 'phone_number':
      return { phone_number: value || null }
    case 'rich_text':
      return { rich_text: toNotionTextArray(value) }
    case 'title':
      return { title: toNotionTextArray(value) }
    default:
      return null
  }
}

function readTitle(properties: Record<string, JsonObject>, titlePropertyName: string | null): string {
  if (titlePropertyName && properties[titlePropertyName]) {
    const title = readPropertyValue(properties[titlePropertyName])
    if (title) return title
  }

  for (const property of Object.values(properties)) {
    if (property.type === 'title') {
      const title = readPropertyValue(property)
      if (title) return title
    }
  }

  return 'Untitled'
}

function summarizeReply(reply: string): string {
  return truncateForPrompt(reply.replace(/\s+/g, ' ').trim(), 600)
}

export function truncateForPrompt(input: string, maxChars: number): string {
  const trimmed = input.trim()
  if (trimmed.length <= maxChars) return trimmed
  if (maxChars <= 1) return trimmed.slice(0, maxChars)
  return `${trimmed.slice(0, maxChars - 1)}…`
}

export function normalizeMarkdownForHash(input: string): string {
  return input
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function extractLatestAssistantReply(
  session: NotionTaskSessionLike | null,
  previousAssistantId?: string,
): string | null {
  const messages = session?.messages
  if (!messages) return null

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role !== 'assistant' || message.isIntermediate) continue
    if (previousAssistantId && message.id === previousAssistantId) return null
    if (typeof message.content !== 'string' || !message.content.trim()) return null
    return message.content
  }

  return null
}

function getLatestAssistantId(session: NotionTaskSessionLike | null): string | undefined {
  const messages = session?.messages
  if (!messages) return undefined

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role === 'assistant' && !message.isIntermediate && message.id) {
      return message.id
    }
  }

  return undefined
}

export function buildNotionPrompt(input: {
  title: string
  pageUrl?: string
  propertiesText: string
  bodyText: string
}): string {
  const pageUrl = input.pageUrl ? `Page URL: ${input.pageUrl}` : 'Page URL: (not available)'
  const propertiesText = input.propertiesText.trim() || '(no prompt-worthy properties)'
  const bodyText = input.bodyText.trim() || '(no body content)'

  return [
    `You are handling a queued Notion task titled "${input.title}".`,
    '',
    pageUrl,
    '',
    'Document properties:',
    propertiesText,
    '',
    'Document body:',
    bodyText,
    '',
    'Perform the requested work using the document as the primary source of truth.',
    'Respond with these sections exactly:',
    'Summary',
    'Work Performed',
    'Risks',
    'Next Steps',
  ].join('\n')
}

function createDefaultConfig(): NotionTaskConfig {
  return JSON.parse(JSON.stringify(DEFAULT_NOTION_TASK_CONFIG)) as NotionTaskConfig
}

function createDefaultLedger(): NotionLedger {
  return {
    version: 1,
    pages: {},
  }
}

function isPromptFriendlyProperty(
  property: NotionSchemaProperty,
  config: NotionTaskConfig,
): boolean {
  if (!PROMPT_FRIENDLY_TYPES.has(property.type)) return false

  const skippedNames = new Set([
    config.trigger.property,
    config.status.property,
    config.properties.claimedAt,
    config.properties.processedAt,
    config.properties.sessionId,
    config.properties.slackUrl,
    config.properties.summary,
  ])

  return !skippedNames.has(property.name)
}

function buildPromptPropertiesText(
  page: DetailedPage,
  schema: NotionSchemaCache,
  config: NotionTaskConfig,
): string {
  const names = Array.from(schema.propertiesByName.values())
    .filter(property => isPromptFriendlyProperty(property, config))
    .map(property => property.name)
    .sort((a, b) => a.localeCompare(b))

  const lines: string[] = []
  for (const name of names) {
    const property = page.properties[name]
    if (!property) continue
    const propertyType = typeof property.type === 'string' ? property.type : ''
    if (MULTI_VALUE_TYPES.has(propertyType)) continue
    const text = truncateForPrompt(readPropertyValue(property), 300)
    if (!text) continue
    lines.push(`- ${name}: ${text}`)
  }

  return lines.join('\n')
}

function matchesReadyStatus(
  property: JsonObject | undefined,
  config: NotionTaskConfig,
): boolean {
  const value = readPropertyValue(property)
  return !!value && config.status.readyValues.includes(value)
}

function matchesTrigger(
  property: JsonObject | undefined,
  config: NotionTaskConfig,
): boolean {
  if (!property) return false

  switch (config.trigger.type) {
    case 'checkbox': {
      const expected = config.trigger.value === undefined ? true : Boolean(config.trigger.value)
      return property.type === 'checkbox' && property.checkbox === expected
    }
    case 'status':
      return property.type === 'status' && readPropertyValue(property) === String(config.trigger.value ?? '')
    case 'select':
      return property.type === 'select' && readPropertyValue(property) === String(config.trigger.value ?? '')
    case 'multi_select':
      return property.type === 'multi_select' && readPropertyValue(property).split(', ').includes(String(config.trigger.value ?? ''))
    case 'rich_text':
      return property.type === 'rich_text' && readPropertyValue(property).includes(String(config.trigger.value ?? ''))
    case 'title':
      return property.type === 'title' && readPropertyValue(property).includes(String(config.trigger.value ?? ''))
    default:
      return false
  }
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  if (!existsSync(filePath)) return fallback
  try {
    const raw = await readFile(filePath, 'utf-8')
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

async function waitForSessionBootstrap(
  sessionManager: NotionTaskSessionManagerLike,
  sessionId: string,
  timeoutMs = 5000,
): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const session = await sessionManager.getSession(sessionId)
    if ((session?.messages?.length ?? 0) > 0) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

export class NotionTaskService {
  private readonly workspaceId: string
  private readonly workspaceRootPath: string
  private readonly sessionManager: NotionTaskSessionManagerLike
  private readonly deps: NotionTaskServiceDependencies
  private readonly serviceDir: string
  private readonly configPath: string
  private readonly ledgerPath: string
  private readonly eventsLogPath: string
  private readonly tokenRefreshManager: TokenRefreshManager

  private scheduler: SchedulerLike | null = null
  private started = false
  private processing = false
  private queue: QueueItem[] = []
  private queuedPageIds = new Set<string>()
  private schemaCache: NotionSchemaCache | null = null

  constructor(options: {
    workspaceId: string
    workspaceRootPath: string
    sessionManager: NotionTaskSessionManagerLike
    deps?: Partial<NotionTaskServiceDependencies>
  }) {
    this.workspaceId = options.workspaceId
    this.workspaceRootPath = options.workspaceRootPath
    this.sessionManager = options.sessionManager
    this.serviceDir = join(this.workspaceRootPath, SERVICE_DIRNAME)
    this.configPath = join(this.serviceDir, CONFIG_FILENAME)
    this.ledgerPath = join(this.serviceDir, LEDGER_FILENAME)
    this.eventsLogPath = join(this.serviceDir, EVENTS_LOG_FILENAME)

    const credentialManager = options.deps?.credentialManager ?? getSourceCredentialManager()
    this.deps = {
      fetchImpl: options.deps?.fetchImpl ?? fetch,
      loadSources: options.deps?.loadSources ?? loadWorkspaceSources,
      credentialManager,
      rawCredentialManager: options.deps?.rawCredentialManager ?? getCredentialManager(),
      createSlackGateway: options.deps?.createSlackGateway ?? ((sourceSlug: string) => new SlackGateway({
        workspaceId: this.workspaceId,
        workspaceRootPath: this.workspaceRootPath,
        sourceSlug,
        deps: {
          fetchImpl: options.deps?.fetchImpl ?? fetch,
          loadSources: options.deps?.loadSources ?? loadWorkspaceSources,
          sourceCredentialManager: credentialManager,
          rawCredentialManager: options.deps?.rawCredentialManager ?? getCredentialManager(),
          logger: options.deps?.logger ?? notionTaskLog,
        },
      })),
      createScheduler: options.deps?.createScheduler ?? defaultSchedulerFactory,
      logger: options.deps?.logger ?? notionTaskLog,
      now: options.deps?.now ?? (() => new Date()),
    }
    this.tokenRefreshManager = new TokenRefreshManager(credentialManager)
  }

  async start(): Promise<void> {
    if (this.started) return

    await this.ensureStorageFiles()
    this.scheduler = this.deps.createScheduler((payload) => this.onSchedulerTick(payload))
    this.scheduler.start()
    this.started = true

    this.deps.logger.info('[NotionTaskService] started')
  }

  async stop(): Promise<void> {
    this.scheduler?.stop()
    this.scheduler = null
    this.started = false
    this.processing = false
    this.queue = []
    this.queuedPageIds.clear()
    this.deps.logger.info('[NotionTaskService] stopped')
  }

  async forcePollNow(): Promise<{ success: boolean; queued: boolean; reason?: string; pageId?: string }> {
    if (!this.started) {
      return { success: false, queued: false, reason: 'runtime_unavailable' }
    }

    const config = await this.loadConfig()
    if (!config.enabled) {
      return { success: false, queued: false, reason: 'disabled' }
    }

    if (this.processing || this.queue.length > 0) {
      return { success: true, queued: false, reason: 'busy' }
    }

    const runtime = await this.resolveRuntime(config)
    if (!runtime) {
      return { success: false, queued: false, reason: 'runtime_unavailable' }
    }

    const candidate = await this.queryNextCandidate(runtime)
    if (!candidate) {
      return { success: true, queued: false, reason: 'no_candidate' }
    }

    this.enqueueCandidate(candidate.id, 'manual')
    return { success: true, queued: true, pageId: candidate.id }
  }

  enqueueCandidate(pageId: string, reason: string): boolean {
    if (!pageId || this.queuedPageIds.has(pageId)) return false
    this.queue.push({ pageId, reason })
    this.queuedPageIds.add(pageId)
    void this.processQueue()
    return true
  }

  private async onSchedulerTick(_payload: SchedulerTickPayload): Promise<void> {
    await this.poll('poll')
  }

  private async poll(reason: string): Promise<boolean> {
    if (!this.started) return false

    const config = await this.loadConfig()
    if (!config.enabled) return false
    if (reason === 'poll' && !matchesCron(config.pollCron)) return false
    if (config.limits.maxConcurrent !== 1) {
      this.deps.logger.warn('[NotionTaskService] maxConcurrent > 1 is not supported in v1; using 1')
    }
    if (this.processing || this.queue.length > 0) return false

    const runtime = await this.resolveRuntime(config)
    if (!runtime) return false

    const candidate = await this.queryNextCandidate(runtime)
    if (!candidate) return false

    return this.enqueueCandidate(candidate.id, reason)
  }

  private async processQueue(): Promise<void> {
    if (this.processing || !this.started) return
    this.processing = true

    try {
      while (this.queue.length > 0 && this.started) {
        const next = this.queue.shift()
        if (!next) continue
        this.queuedPageIds.delete(next.pageId)
        await this.processCandidate(next.pageId, next.reason)
      }
    } finally {
      this.processing = false
    }
  }

  private async processCandidate(pageId: string, reason: string): Promise<void> {
    const config = await this.loadConfig()
    if (!config.enabled) return

    const runtime = await this.resolveRuntime(config)
    if (!runtime) return

    let claimed = false
    let shouldWriteFailure = false
    let sessionId: string | undefined

    try {
      const page = await this.fetchPage(runtime, pageId)
      if (!matchesTrigger(page.properties[config.trigger.property], config)) {
        await this.appendEvent('candidate_skipped_trigger', { pageId, reason })
        return
      }
      if (!matchesReadyStatus(page.properties[config.status.property], config)) {
        await this.appendEvent('candidate_skipped_status', { pageId, reason })
        return
      }

      const content = await this.fetchPageContent(runtime, pageId)
      const title = readTitle(page.properties, runtime.schema.titlePropertyName)
      const propertiesText = buildPromptPropertiesText(page, runtime.schema, config)
      const bodyText = truncateForPrompt(content.markdown, config.limits.maxPageChars)
      const contentHash = createHash('sha256')
        .update(stableStringify({
          title,
          propertiesText,
          bodyText: normalizeMarkdownForHash(bodyText),
        }), 'utf8')
        .digest('hex')

      const ledger = await this.loadLedger()
      const existing = ledger.pages[pageId]
      if (existing?.lastProcessedEditedTime === page.lastEditedTime || existing?.contentHash === contentHash) {
        await this.updatePageProperties(runtime, page, {
          [config.status.property]: config.status.doneValue,
          [config.properties.processedAt]: this.deps.now().toISOString(),
          [config.properties.summary]: 'Skipped unchanged content.',
          ...(existing?.sessionId ? { [config.properties.sessionId]: existing.sessionId } : {}),
        })
        ledger.pages[pageId] = {
          lastProcessedEditedTime: page.lastEditedTime,
          contentHash,
          sessionId: existing?.sessionId,
          status: 'skipped',
          processedAt: this.deps.now().toISOString(),
        }
        await this.saveLedger(ledger)
        await this.appendEvent('candidate_skipped_unchanged', { pageId, reason })
        return
      }

      shouldWriteFailure = true

      const existingSession = await this.sessionManager.findSessionByNotionPage?.(this.workspaceId, pageId) ?? null

      let session = existingSession && !existingSession.isArchived
        ? existingSession
        : null
      let slackRef = session?.slackRef

      if (!session) {
        session = await this.sessionManager.createSession(this.workspaceId, {
          name: `Notion AI: ${truncateForPrompt(title, 60)}`,
          suppressCreatedEvent: true,
          permissionMode: config.session.permissionMode,
          labels: config.session.labels,
          llmConnection: config.session.llmConnection,
          model: config.session.model,
          workingDirectory: config.session.workingDirectory ?? this.workspaceRootPath,
          sessionOrigin: 'notion',
          notionRef: {
            pageId,
            dataSourceId: config.databaseId,
            pageUrl: page.url,
          },
        })
        await this.sessionManager.linkSessionToNotion?.(session.id, {
          pageId,
          dataSourceId: config.databaseId,
          pageUrl: page.url,
        })
      }

      if (!slackRef) {
        const kickoff = await this.createSlackKickoff(config, title, page.url, session.id)
        slackRef = kickoff.slackRef
        await this.sessionManager.linkSessionToSlack?.(session.id, slackRef)
        if (kickoff.permalinkError) {
          throw new Error(kickoff.permalinkError)
        }
      }

      sessionId = session.id
      await this.updatePageProperties(runtime, page, {
        [config.status.property]: config.status.runningValue,
        [config.properties.claimedAt]: this.deps.now().toISOString(),
        [config.properties.sessionId]: session.id,
        ...(slackRef?.permalink ? { [config.properties.slackUrl]: slackRef.permalink } : {}),
      })
      claimed = true

      const prompt = buildNotionPrompt({
        title,
        pageUrl: page.url,
        propertiesText,
        bodyText,
      })

      const previousAssistantId = getLatestAssistantId(session)
      const completionPromise = this.sessionManager.sendMessage(session.id, prompt)
      await waitForSessionBootstrap(this.sessionManager, session.id)
      this.sessionManager.notifySessionCreated?.(session.id)
      await completionPromise
      const finalSession = await this.sessionManager.getSession(session.id)
      const reply = extractLatestAssistantReply(finalSession, previousAssistantId)
      if (!reply) {
        throw new Error('The agent did not produce a final assistant response.')
      }

      if (!slackRef) {
        throw new Error('Slack thread linkage missing for Notion-origin session.')
      }

      await this.postSlackReply(runtime, {
        channel: slackRef.channelId,
        threadTs: slackRef.threadTs,
        title,
        pageUrl: page.url,
        sessionId: session.id,
        reply,
      })

      await this.updatePageProperties(runtime, page, {
        [config.status.property]: config.status.doneValue,
        [config.properties.processedAt]: this.deps.now().toISOString(),
        [config.properties.sessionId]: session.id,
        ...(slackRef.permalink ? { [config.properties.slackUrl]: slackRef.permalink } : {}),
        [config.properties.summary]: summarizeReply(reply),
      })

      ledger.pages[pageId] = {
        lastProcessedEditedTime: page.lastEditedTime,
        contentHash,
        sessionId: session.id,
        status: 'done',
        processedAt: this.deps.now().toISOString(),
      }
      await this.saveLedger(ledger)
      await this.appendEvent('candidate_completed', {
        pageId,
        reason,
        sessionId: session.id,
        contentSource: content.source,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.deps.logger.error(`[NotionTaskService] Failed to process ${pageId}:`, error)
      await this.appendEvent('candidate_failed', { pageId, reason, error: message, sessionId })
      if (claimed || shouldWriteFailure) {
        try {
          const runtime = await this.resolveRuntime(config)
          if (!runtime) return
          const page = await this.fetchPage(runtime, pageId)
          const currentSession = sessionId ? await this.sessionManager.getSession(sessionId) : null
          if (currentSession?.slackRef) {
            await this.postSlackFailure(runtime, {
              channel: currentSession.slackRef.channelId,
              threadTs: currentSession.slackRef.threadTs,
              title: readTitle(page.properties, runtime.schema.titlePropertyName),
              pageUrl: page.url,
              sessionId,
              error: message,
            }).catch(postError => {
              this.deps.logger.error('[NotionTaskService] Failed to post Slack failure reply:', postError)
            })
          }
          await this.updatePageProperties(runtime, page, {
            [config.status.property]: config.status.failedValue,
            [config.properties.processedAt]: this.deps.now().toISOString(),
            [config.properties.summary]: truncateForPrompt(`Error: ${message}`, NOTION_TEXT_LIMIT),
            ...(sessionId ? { [config.properties.sessionId]: sessionId } : {}),
          })
        } catch (writeError) {
          this.deps.logger.error('[NotionTaskService] Failed to write failure state:', writeError)
        }
      }
    }
  }

  private async ensureStorageFiles(): Promise<void> {
    await mkdir(this.serviceDir, { recursive: true })

    if (!existsSync(this.configPath)) {
      await writeFile(this.configPath, `${JSON.stringify(createDefaultConfig(), null, 2)}\n`, 'utf-8')
    }
    if (!existsSync(this.ledgerPath)) {
      await writeFile(this.ledgerPath, `${JSON.stringify(createDefaultLedger(), null, 2)}\n`, 'utf-8')
    }
  }

  private async loadConfig(): Promise<NotionTaskConfig> {
    const raw = await readJsonFile<Partial<NotionTaskConfig>>(this.configPath, {})
    return {
      ...createDefaultConfig(),
      ...raw,
      trigger: {
        ...createDefaultConfig().trigger,
        ...(raw.trigger ?? {}),
      },
      status: {
        ...createDefaultConfig().status,
        ...(raw.status ?? {}),
        readyValues: Array.isArray(raw.status?.readyValues) && raw.status.readyValues.length > 0
          ? raw.status.readyValues
          : [...DEFAULT_NOTION_TASK_CONFIG.status.readyValues],
      },
      properties: {
        ...createDefaultConfig().properties,
        ...(raw.properties ?? {}),
      },
      session: {
        ...createDefaultConfig().session,
        ...(raw.session ?? {}),
        labels: Array.isArray(raw.session?.labels) && raw.session.labels.length > 0
          ? raw.session.labels
          : [...DEFAULT_NOTION_TASK_CONFIG.session.labels],
      },
      limits: {
        ...createDefaultConfig().limits,
        ...(raw.limits ?? {}),
      },
    }
  }

  private async loadLedger(): Promise<NotionLedger> {
    const raw = await readJsonFile<NotionLedger>(this.ledgerPath, createDefaultLedger())
    return raw.version === 1 && raw.pages ? raw : createDefaultLedger()
  }

  private async saveLedger(ledger: NotionLedger): Promise<void> {
    await writeFile(this.ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf-8')
  }

  private async appendEvent(type: string, data: Record<string, unknown>): Promise<void> {
    const entry = {
      ts: this.deps.now().toISOString(),
      type,
      workspaceId: this.workspaceId,
      ...data,
    }
    try {
      await appendFile(this.eventsLogPath, `${JSON.stringify(entry)}\n`, 'utf-8')
    } catch (error) {
      this.deps.logger.warn('[NotionTaskService] Failed to append event log:', error)
    }
  }

  private async resolveRuntime(config: NotionTaskConfig): Promise<RuntimeConfigResult | null> {
    if (!config.databaseId || !config.slackChannelId) {
      return null
    }

    const sources = this.resolveSources(config)
    if (!sources) return null
    const schema = await this.getSchema(config, sources.notion)
    return { config, sources, schema }
  }

  private resolveSources(config: NotionTaskConfig): NotionTaskSourceRef | null {
    const sources = this.deps.loadSources(this.workspaceRootPath)
    const notion = sources.find(source => source.config.slug === config.notionSourceSlug && source.config.type === 'api')
    const slack = sources.find(source => source.config.slug === config.slackSourceSlug && source.config.type === 'api')

    if (!notion || !slack) {
      this.deps.logger.warn('[NotionTaskService] Required API sources not found')
      return null
    }

    return { notion, slack }
  }

  private async getSchema(config: NotionTaskConfig, notionSource: LoadedSource): Promise<NotionSchemaCache> {
    const cached = this.schemaCache
    if (cached && cached.databaseId === config.databaseId && Date.now() - cached.loadedAt < SCHEMA_CACHE_TTL_MS) {
      return cached
    }

    const response = await this.requestNotionJson<{ properties?: Record<string, JsonObject> }>(
      notionSource,
      `/data_sources/${config.databaseId}`,
      { method: 'GET' },
    )

    const properties = response.properties ?? {}
    const propertiesByName = new Map<string, NotionSchemaProperty>()
    const propertiesById = new Map<string, NotionSchemaProperty>()
    let titlePropertyName: string | null = null
    let titlePropertyId: string | null = null

    for (const [name, rawProperty] of Object.entries(properties)) {
      if (!rawProperty || typeof rawProperty !== 'object') continue
      const id = typeof rawProperty.id === 'string' ? rawProperty.id : name
      const type = typeof rawProperty.type === 'string' ? rawProperty.type : 'unknown'
      const property = { id, name, type }
      propertiesByName.set(name, property)
      propertiesById.set(id, property)
      if (type === 'title' && !titlePropertyName) {
        titlePropertyName = name
        titlePropertyId = id
      }
    }

    const schema = {
      loadedAt: Date.now(),
      databaseId: config.databaseId,
      titlePropertyName,
      titlePropertyId,
      propertiesByName,
      propertiesById,
    }
    this.schemaCache = schema
    return schema
  }

  private getDetectorPropertyIds(schema: NotionSchemaCache, config: NotionTaskConfig): string[] {
    const ids = new Set<string>()
    const trigger = schema.propertiesByName.get(config.trigger.property)?.id
    const status = schema.propertiesByName.get(config.status.property)?.id
    if (trigger) ids.add(trigger)
    if (status) ids.add(status)
    return Array.from(ids)
  }

  private getDetailPropertyIds(schema: NotionSchemaCache, config: NotionTaskConfig): string[] {
    const ids = new Set<string>()
    const requiredNames = [
      config.trigger.property,
      config.status.property,
      config.properties.claimedAt,
      config.properties.processedAt,
      config.properties.sessionId,
      config.properties.slackUrl,
      config.properties.summary,
    ]

    for (const name of requiredNames) {
      const id = schema.propertiesByName.get(name)?.id
      if (id) ids.add(id)
    }
    if (schema.titlePropertyId) ids.add(schema.titlePropertyId)
    for (const property of schema.propertiesByName.values()) {
      if (isPromptFriendlyProperty(property, config)) {
        ids.add(property.id)
      }
    }
    return Array.from(ids)
  }

  private async queryNextCandidate(runtime: RuntimeConfigResult): Promise<CandidatePage | null> {
    const filter = {
      and: [
        this.buildTriggerFilter(runtime.config),
        this.buildReadyStatusFilter(runtime.config),
      ],
    }
    const propertyIds = this.getDetectorPropertyIds(runtime.schema, runtime.config)

    const query = propertyIds.length > 0
      ? `?${propertyIds.map(id => `filter_properties=${encodeURIComponent(id)}`).join('&')}`
      : ''

    const response = await this.requestNotionJson<{ results?: Array<{ id?: string; last_edited_time?: string }> }>(
      runtime.sources.notion,
      `/data_sources/${runtime.config.databaseId}/query${query}`,
      {
        method: 'POST',
        body: {
          page_size: 1,
          filter,
          sorts: [{ timestamp: 'last_edited_time', direction: 'ascending' }],
        },
      },
    )

    const page = response.results?.[0]
    if (!page?.id || !page.last_edited_time) return null
    return {
      id: page.id,
      lastEditedTime: page.last_edited_time,
    }
  }

  private buildTriggerFilter(config: NotionTaskConfig): JsonObject {
    switch (config.trigger.type) {
      case 'checkbox':
        return {
          property: config.trigger.property,
          checkbox: { equals: config.trigger.value === undefined ? true : Boolean(config.trigger.value) },
        }
      case 'status':
        return {
          property: config.trigger.property,
          status: { equals: String(config.trigger.value ?? '') },
        }
      case 'select':
        return {
          property: config.trigger.property,
          select: { equals: String(config.trigger.value ?? '') },
        }
      case 'multi_select':
        return {
          property: config.trigger.property,
          multi_select: { contains: String(config.trigger.value ?? '') },
        }
      case 'rich_text':
        return {
          property: config.trigger.property,
          rich_text: { contains: String(config.trigger.value ?? '') },
        }
      case 'title':
        return {
          property: config.trigger.property,
          title: { contains: String(config.trigger.value ?? '') },
        }
      default:
        return {
          property: config.trigger.property,
          checkbox: { equals: true },
        }
    }
  }

  private buildReadyStatusFilter(config: NotionTaskConfig): JsonObject {
    const propertyKey = config.status.type === 'select' ? 'select' : 'status'
    if (config.status.readyValues.length === 1) {
      return {
        property: config.status.property,
        [propertyKey]: { equals: config.status.readyValues[0] },
      }
    }

    return {
      or: config.status.readyValues.map(value => ({
        property: config.status.property,
        [propertyKey]: { equals: value },
      })),
    }
  }

  private async fetchPage(runtime: RuntimeConfigResult, pageId: string): Promise<DetailedPage> {
    const propertyIds = this.getDetailPropertyIds(runtime.schema, runtime.config)
    const query = propertyIds.length > 0
      ? `?${propertyIds.map(id => `filter_properties=${encodeURIComponent(id)}`).join('&')}`
      : ''
    const response = await this.requestNotionJson<{ id: string; url?: string; last_edited_time?: string; properties?: Record<string, JsonObject> }>(
      runtime.sources.notion,
      `/pages/${pageId}${query}`,
      { method: 'GET' },
    )

    return {
      id: response.id,
      url: response.url,
      lastEditedTime: response.last_edited_time ?? '',
      properties: response.properties ?? {},
    }
  }

  private async fetchPageContent(runtime: RuntimeConfigResult, pageId: string): Promise<PageContentResult> {
    try {
      const markdownResponse = await this.requestNotionJson<{ markdown?: string }>(
        runtime.sources.notion,
        `/pages/${pageId}/markdown`,
        { method: 'GET' },
      )

      const markdown = typeof markdownResponse.markdown === 'string'
        ? markdownResponse.markdown
        : ''
      return {
        markdown: normalizeMarkdownForHash(markdown),
        source: 'markdown',
      }
    } catch (error) {
      this.deps.logger.warn('[NotionTaskService] Markdown endpoint failed, falling back to block traversal:', error)
      const markdown = await this.fetchBlocksAsMarkdown(runtime.sources.notion, pageId)
      return {
        markdown: normalizeMarkdownForHash(markdown),
        source: 'blocks',
      }
    }
  }

  private async fetchBlocksAsMarkdown(notionSource: LoadedSource, blockId: string, indent = 0): Promise<string> {
    const lines: string[] = []
    let cursor: string | undefined

    do {
      const path = cursor
        ? `/blocks/${blockId}/children?page_size=100&start_cursor=${encodeURIComponent(cursor)}`
        : `/blocks/${blockId}/children?page_size=100`
      const response = await this.requestNotionJson<{
        results?: JsonObject[]
        has_more?: boolean
        next_cursor?: string | null
      }>(notionSource, path, { method: 'GET' })

      for (const block of response.results ?? []) {
        lines.push(await this.blockToMarkdown(notionSource, block, indent))
      }

      cursor = response.has_more && response.next_cursor ? response.next_cursor : undefined
    } while (cursor)

    return lines.filter(Boolean).join('\n')
  }

  private async blockToMarkdown(notionSource: LoadedSource, block: JsonObject, indent = 0): Promise<string> {
    const type = typeof block.type === 'string' ? block.type : ''
    const payload = type && block[type] && typeof block[type] === 'object'
      ? block[type] as JsonObject
      : undefined
    const text = payload ? toPlainText(payload.rich_text) : ''
    const prefix = '  '.repeat(indent)

    switch (type) {
      case 'paragraph':
        return `${prefix}${text}`
      case 'heading_1':
        return `${prefix}# ${text}`
      case 'heading_2':
        return `${prefix}## ${text}`
      case 'heading_3':
        return `${prefix}### ${text}`
      case 'bulleted_list_item': {
        const nested = block.has_children ? await this.fetchBlocksAsMarkdown(notionSource, String(block.id), indent + 1) : ''
        return [ `${prefix}- ${text}`, nested ].filter(Boolean).join('\n')
      }
      case 'numbered_list_item': {
        const nested = block.has_children ? await this.fetchBlocksAsMarkdown(notionSource, String(block.id), indent + 1) : ''
        return [ `${prefix}1. ${text}`, nested ].filter(Boolean).join('\n')
      }
      case 'to_do': {
        const checked = payload && typeof payload.checked === 'boolean' && payload.checked ? 'x' : ' '
        const nested = block.has_children ? await this.fetchBlocksAsMarkdown(notionSource, String(block.id), indent + 1) : ''
        return [ `${prefix}- [${checked}] ${text}`, nested ].filter(Boolean).join('\n')
      }
      case 'toggle': {
        const nested = block.has_children ? await this.fetchBlocksAsMarkdown(notionSource, String(block.id), indent + 1) : ''
        return [ `${prefix}Toggle: ${text}`, nested ].filter(Boolean).join('\n')
      }
      case 'code': {
        const language = payload && typeof payload.language === 'string' ? payload.language : ''
        const code = text
        return `${prefix}\`\`\`${language}\n${code}\n${prefix}\`\`\``
      }
      default:
        if (text) return `${prefix}${text}`
        return ''
    }
  }

  private async postSlackReport(
    runtime: RuntimeConfigResult,
    input: {
      channel: string
      threadTs?: string
      title: string
      pageUrl?: string
      sessionId: string
      reply: string
    },
  ): Promise<string> {
    const text = [
      '*Notion AI Task Complete*',
      `*Title:* ${input.title}`,
      input.pageUrl ? `*Page:* ${input.pageUrl}` : undefined,
      `*Session:* ${input.sessionId}`,
      '',
      truncateForPrompt(input.reply, SLACK_TEXT_LIMIT),
    ].filter(Boolean).join('\n')

    const gateway = this.deps.createSlackGateway(runtime.config.slackSourceSlug)
    const postResult = await gateway.postMessage({
      channel: input.channel,
      threadTs: input.threadTs,
      text,
    })
    return await gateway.getPermalink({
      channel: input.channel,
      messageTs: postResult.ts,
    })
  }

  private async createSlackKickoff(
    config: NotionTaskConfig,
    title: string,
    pageUrl: string | undefined,
    sessionId: string,
  ): Promise<{
    slackRef: { channelId: string; threadTs: string; rootMessageTs: string; permalink?: string }
    permalinkError?: string
  }> {
    const gateway = this.deps.createSlackGateway(config.slackSourceSlug)
    const text = [
      '*Notion AI Task Started*',
      `*Title:* ${title}`,
      pageUrl ? `*Page:* ${pageUrl}` : undefined,
      `*Session:* ${sessionId}`,
      '이 스레드에서 후속 커뮤니케이션을 이어갈 수 있습니다.',
    ].filter(Boolean).join('\n')

    const postResult = await gateway.postMessage({
      channel: config.slackChannelId,
      text,
    })

    const slackRef = {
      channelId: config.slackChannelId,
      threadTs: postResult.ts,
      rootMessageTs: postResult.ts,
    }

    try {
      const permalink = await gateway.getPermalink({
        channel: config.slackChannelId,
        messageTs: postResult.ts,
      })
      return { slackRef: { ...slackRef, permalink } }
    } catch (error) {
      return {
        slackRef,
        permalinkError: `Slack thread kickoff failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  private async postSlackReply(
    runtime: RuntimeConfigResult,
    input: {
      channel: string
      threadTs: string
      title: string
      pageUrl?: string
      sessionId: string
      reply: string
    },
  ): Promise<void> {
    const gateway = this.deps.createSlackGateway(runtime.config.slackSourceSlug)
    const text = [
      '*Notion AI Task Update*',
      `*Title:* ${input.title}`,
      input.pageUrl ? `*Page:* ${input.pageUrl}` : undefined,
      `*Session:* ${input.sessionId}`,
      '',
      truncateForPrompt(input.reply, SLACK_TEXT_LIMIT),
    ].filter(Boolean).join('\n')
    await gateway.postMessage({
      channel: input.channel,
      threadTs: input.threadTs,
      text,
    })
  }

  private async postSlackFailure(
    runtime: RuntimeConfigResult,
    input: {
      channel: string
      threadTs: string
      title: string
      pageUrl?: string
      sessionId?: string
      error: string
    },
  ): Promise<void> {
    const gateway = this.deps.createSlackGateway(runtime.config.slackSourceSlug)
    const text = [
      '*Notion AI Task Failed*',
      `*Title:* ${input.title}`,
      input.pageUrl ? `*Page:* ${input.pageUrl}` : undefined,
      input.sessionId ? `*Session:* ${input.sessionId}` : undefined,
      '',
      truncateForPrompt(input.error, SLACK_TEXT_LIMIT),
    ].filter(Boolean).join('\n')
    await gateway.postMessage({
      channel: input.channel,
      threadTs: input.threadTs,
      text,
    })
  }

  private async updatePageProperties(
    runtime: RuntimeConfigResult,
    page: DetailedPage,
    values: Record<string, string>,
  ): Promise<void> {
    const properties: Record<string, JsonObject> = {}

    for (const [name, value] of Object.entries(values)) {
      const property = page.properties[name]
      const update = buildPropertyUpdate(property, value)
      if (!update) continue
      properties[name] = update
    }

    if (Object.keys(properties).length === 0) return

    await this.requestNotionJson(
      runtime.sources.notion,
      `/pages/${page.id}`,
      {
        method: 'PATCH',
        body: { properties },
      },
    )
  }

  private async requestNotionJson<T>(
    source: LoadedSource,
    path: string,
    options: {
      method: 'GET' | 'POST' | 'PATCH'
      body?: JsonObject
    },
  ): Promise<T> {
    const headers = await this.buildApiHeaders(source, true)
    return this.requestJson<T>(source, path, {
      method: options.method,
      headers,
      body: options.body,
    })
  }

  private async buildApiHeaders(source: LoadedSource, isNotion: boolean): Promise<Record<string, string>> {
    const api = source.config.api
    if (!api) throw new Error(`Source ${source.config.slug} is missing api configuration`)

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(api.defaultHeaders ?? {}),
    }

    if (api.authType === 'header') {
      const credential = await this.deps.credentialManager.getApiCredential(source)
      if (!credential) {
        throw new Error(`No credential for ${source.config.slug}`)
      }

      if (credential && typeof credential === 'object' && !Array.isArray(credential)) {
        Object.assign(headers, credential as Record<string, string>)
        if (isNotion) {
          const authValue = headers.Authorization || headers.authorization
          if (authValue && !String(authValue).toLowerCase().startsWith('bearer ')) {
            headers.Authorization = `Bearer ${authValue}`
          }
          headers['Notion-Version'] = NOTION_API_VERSION
        }
      } else {
        const headerValue = typeof credential === 'string' ? credential : ''
        const headerName = api.headerName
          || (api.headerNames?.includes('Authorization') ? 'Authorization' : api.headerNames?.[0])
          || 'x-api-key'
        headers[headerName] = isNotion && headerName === 'Authorization' && headerValue && !headerValue.toLowerCase().startsWith('bearer ')
          ? `Bearer ${headerValue}`
          : headerValue
      }

      if (isNotion && !headers['Notion-Version']) {
        headers['Notion-Version'] = NOTION_API_VERSION
      }
      return headers
    }

    const tokenResult = await this.tokenRefreshManager.ensureFreshToken(source)
    if (!tokenResult.success || !tokenResult.token) {
      throw new Error(tokenResult.reason || `No token for ${source.config.slug}`)
    }

    switch (api.authType) {
      case 'oauth':
      case 'bearer': {
        const scheme = api.authScheme ?? 'Bearer'
        headers.Authorization = scheme ? `${scheme} ${tokenResult.token}` : tokenResult.token
        break
      }
      case 'query':
      case 'basic':
      case 'none':
      default:
        break
    }

    if (isNotion && !headers['Notion-Version']) {
      headers['Notion-Version'] = NOTION_API_VERSION
    }

    return headers
  }

  private async requestJson<T>(
    source: LoadedSource,
    path: string,
    options: {
      method: 'GET' | 'POST' | 'PATCH'
      headers: Record<string, string>
      body?: JsonObject
    },
  ): Promise<T> {
    const api = source.config.api
    if (!api) throw new Error(`Source ${source.config.slug} is missing api configuration`)

    const normalizedBase = api.baseUrl.endsWith('/') ? api.baseUrl.slice(0, -1) : api.baseUrl
    const normalizedPath = path.startsWith('/') ? path : `/${path}`
    const response = await this.deps.fetchImpl(`${normalizedBase}${normalizedPath}`, {
      method: options.method,
      headers: options.headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    })

    const rawText = await response.text()
    const payload = rawText ? JSON.parse(rawText) as T : {} as T

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${source.config.slug}: ${rawText}`)
    }

    return payload
  }
}
