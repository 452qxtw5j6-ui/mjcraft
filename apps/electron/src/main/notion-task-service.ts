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

function parseHeaderCredential(value: unknown): Record<string, string> | null {
  if (!value) return null
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>
      const headers = Object.fromEntries(
        Object.entries(parsed).filter(([, headerValue]) => typeof headerValue === 'string'),
      ) as Record<string, string>
      return Object.keys(headers).length > 0 ? headers : null
    } catch {
      return null
    }
  }
  if (typeof value === 'object') {
    const headers = Object.fromEntries(
      Object.entries(value as Record<string, unknown>).filter(([, headerValue]) => typeof headerValue === 'string'),
    ) as Record<string, string>
    return Object.keys(headers).length > 0 ? headers : null
  }
  return null
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

const DEFAULT_CONFIG: NotionTaskConfig = {
  enabled: false,
  pollCron: '*/5 * * * *',
  databaseId: '',
  notionSourceSlug: 'notion',
  slackSourceSlug: 'slack',
  slackChannelId: '',
  trigger: {
    property: 'AI',
    type: 'checkbox',
    value: true,
  },
  status: {
    property: 'Status',
    type: 'status',
    readyValues: ['To Do', 'Ready'],
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

function normalizeMarkdownForHash(markdown: string): string {
  return markdown.replace(/\r\n/g, '\n').replace(/\s+$/gm, '').trim()
}

function truncateForPrompt(text: string, limit: number): string {
  if (text.length <= limit) return text
  if (limit <= 1) return text.slice(0, limit)
  return `${text.slice(0, Math.max(limit - 1, 0))}…`
}

function extractLatestAssistantReply(session: NotionTaskSessionLike | null, previousAssistantId?: string): string | null {
  if (!session?.messages?.length) return null

  for (let i = session.messages.length - 1; i >= 0; i--) {
    const message = session.messages[i]
    if (message.role !== 'assistant' || message.isIntermediate) continue
    if (previousAssistantId && message.id === previousAssistantId) return null
    const content = message.content?.trim()
    if (!content) return null
    return content
  }

  return null
}

function getLatestAssistantId(session: NotionTaskSessionLike | null): string | undefined {
  if (!session?.messages?.length) return undefined
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const message = session.messages[i]
    if (message.role === 'assistant' && !message.isIntermediate) {
      return message.id
    }
  }
  return undefined
}

function buildPrompt(pageTitle: string, pageMarkdown: string): string {
  return [
    `A Notion task requires a response.`,
    ``,
    `Title: ${pageTitle}`,
    ``,
    `Task details:`,
    pageMarkdown,
    ``,
    `Respond with exactly these sections:`,
    `1. Summary`,
    `2. Actions taken`,
    `3. Final answer`,
  ].join('\n')
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
  private readonly eventsPath: string

  private scheduler: SchedulerLike | null = null
  private started = false
  private processing = false
  private readonly queue: QueueItem[] = []
  private queueSet = new Set<string>()
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
    this.eventsPath = join(this.serviceDir, EVENTS_LOG_FILENAME)

    const credentialManager = options.deps?.credentialManager ?? getSourceCredentialManager()
    const rawCredentialManager = options.deps?.rawCredentialManager ?? getCredentialManager()
    this.deps = {
      fetchImpl: options.deps?.fetchImpl ?? fetch,
      loadSources: options.deps?.loadSources ?? loadWorkspaceSources,
      credentialManager,
      rawCredentialManager,
      createSlackGateway: options.deps?.createSlackGateway ?? ((sourceSlug) => new SlackGateway({
        workspaceId: this.workspaceId,
        workspaceRootPath: this.workspaceRootPath,
        sourceSlug,
      })),
      createScheduler: options.deps?.createScheduler ?? ((onTick) => new SchedulerService(onTick)),
      logger: options.deps?.logger ?? notionTaskLog,
      now: options.deps?.now ?? (() => new Date()),
    }
  }

  async start(): Promise<void> {
    if (this.started) return

    await this.ensureStorageFiles()
    this.scheduler = this.deps.createScheduler((payload) => this.onSchedulerTick(payload))
    this.scheduler.start()
    this.started = true

    this.deps.logger.info('[notion-ai] service started')
  }

  async stop(): Promise<void> {
    this.scheduler?.stop()
    this.scheduler = null
    this.started = false
    this.queue.length = 0
    this.queueSet.clear()
    this.processing = false
  }

  async forcePollNow(): Promise<{ success: boolean; queued: boolean; reason?: string; pageId?: string }> {
    if (!this.started) {
      return { success: false, queued: false, reason: 'runtime_unavailable' }
    }

    const runtime = await this.loadRuntimeConfig()
    if (!runtime) {
      return { success: false, queued: false, reason: 'disabled' }
    }

    const candidate = await this.findNextCandidate(runtime)
    if (!candidate) {
      return { success: true, queued: false, reason: 'no_candidate' }
    }

    const queued = this.enqueue(candidate.id, 'manual')
    await this.drainQueue().catch(error => {
      this.deps.logger.error('[notion-ai] manual drain failed:', error)
    })

    return { success: true, queued, pageId: candidate.id }
  }

  private async onSchedulerTick(payload: SchedulerTickPayload): Promise<void> {
    if (!matchesCron(DEFAULT_CONFIG.pollCron, payload.now)) return

    const runtime = await this.loadRuntimeConfig()
    if (!runtime) return

    const candidate = await this.findNextCandidate(runtime)
    if (!candidate) return

    this.enqueue(candidate.id, 'scheduler')
    await this.drainQueue()
  }

  private enqueue(pageId: string, reason: string): boolean {
    if (this.queueSet.has(pageId)) return false
    this.queue.push({ pageId, reason })
    this.queueSet.add(pageId)
    return true
  }

  private async drainQueue(): Promise<void> {
    if (this.processing) return
    this.processing = true

    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!
        this.queueSet.delete(item.pageId)
        await this.processCandidate(item.pageId, item.reason)
      }
    } finally {
      this.processing = false
    }
  }

  private async processCandidate(pageId: string, reason: string): Promise<void> {
    let runtime: RuntimeConfigResult | null = null
    let page: DetailedPage | null = null
    let shouldWriteFailure = false
    let sessionId: string | undefined

    try {
      runtime = await this.loadRuntimeConfig()
      if (!runtime) return

      page = await this.fetchPage(runtime, pageId)
      if (!page) return

      const title = this.extractPageTitle(runtime, page)
      const pageContent = await this.fetchPageContent(runtime, pageId)
      const normalizedMarkdown = normalizeMarkdownForHash(pageContent.markdown)
      const contentHash = createHash('sha256').update(normalizedMarkdown).digest('hex')

      const ledger = await this.readLedger()
      const previousEntry = ledger.pages[pageId]
      if (previousEntry?.lastProcessedEditedTime === page.lastEditedTime && previousEntry.contentHash === contentHash) {
        return
      }

      shouldWriteFailure = true

      const config = runtime.config
      const existingSession = await this.sessionManager.findSessionByNotionPage?.(this.workspaceId, pageId) ?? null

      let session = existingSession && !existingSession.isArchived
        ? existingSession
        : null

      if (!session) {
        session = await this.sessionManager.createSession(this.workspaceId, {
          name: `Notion AI: ${truncateForPrompt(title, 60)}`,
          suppressCreatedEvent: true,
          permissionMode: config.session.permissionMode,
          llmConnection: config.session.llmConnection,
          model: config.session.model,
          labels: config.session.labels,
          workingDirectory: config.session.workingDirectory,
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
      sessionId = session.id

      let slackRef = session.slackRef
      if (!slackRef) {
        const kickoff = await this.createSlackKickoff(config, title, page.url, session.id)
        slackRef = kickoff.slackRef
        await this.sessionManager.linkSessionToSlack?.(session.id, slackRef)
        if (kickoff.permalinkError) {
          throw new Error(kickoff.permalinkError)
        }
      }

      await this.markRowClaimed(runtime, pageId, session.id, slackRef.permalink)

      const prompt = buildPrompt(title, truncateForPrompt(pageContent.markdown, config.limits.maxPageChars))
      const previousAssistantId = getLatestAssistantId(session)
      const completionPromise = this.sessionManager.sendMessage(session.id, prompt)
      await waitForSessionBootstrap(this.sessionManager, session.id)
      this.sessionManager.notifySessionCreated?.(session.id)
      await completionPromise
      const finalSession = await this.sessionManager.getSession(session.id)
      const reply = extractLatestAssistantReply(finalSession, previousAssistantId)
      if (!reply) {
        throw new Error('No final assistant reply was produced')
      }

      await this.postSlackSuccess(runtime, slackRef, reply)
      await this.markRowDone(runtime, pageId, session.id, slackRef.permalink, reply, page.lastEditedTime, contentHash)
      shouldWriteFailure = false
    } catch (error) {
      this.deps.logger.error('[notion-ai] candidate processing failed:', { pageId, reason, error })
      if (runtime && shouldWriteFailure) {
        await this.markRowFailed(runtime, pageId, sessionId, error instanceof Error ? error.message : String(error))
      }
    }
  }

  private async ensureStorageFiles(): Promise<void> {
    await mkdir(this.serviceDir, { recursive: true })
    if (!existsSync(this.configPath)) {
      await writeFile(this.configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8')
    }
    if (!existsSync(this.ledgerPath)) {
      await writeFile(this.ledgerPath, JSON.stringify({ version: 1, pages: {} } satisfies NotionLedger, null, 2), 'utf-8')
    }
    if (!existsSync(this.eventsPath)) {
      await writeFile(this.eventsPath, '', 'utf-8')
    }
  }

  private async readConfig(): Promise<NotionTaskConfig> {
    const raw = await readFile(this.configPath, 'utf-8')
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) } as NotionTaskConfig
  }

  private async readLedger(): Promise<NotionLedger> {
    const raw = await readFile(this.ledgerPath, 'utf-8')
    return JSON.parse(raw) as NotionLedger
  }

  private async writeLedger(ledger: NotionLedger): Promise<void> {
    await writeFile(this.ledgerPath, JSON.stringify(ledger, null, 2), 'utf-8')
  }

  private async appendEvent(event: Record<string, unknown>): Promise<void> {
    await appendFile(this.eventsPath, `${JSON.stringify({ ...event, at: this.deps.now().toISOString() })}\n`, 'utf-8')
  }

  private async loadRuntimeConfig(): Promise<RuntimeConfigResult | null> {
    const config = await this.readConfig()
    if (!config.enabled || !config.databaseId || !config.slackChannelId) return null

    const sources = this.resolveSources(config)
    if (!sources) return null

    const schema = await this.loadSchema(config, sources.notion)
    return { config, sources, schema }
  }

  private resolveSources(config: NotionTaskConfig): NotionTaskSourceRef | null {
    const sources = this.deps.loadSources(this.workspaceRootPath)
    const notion = sources.find(source => source.config.slug === config.notionSourceSlug)
    const slack = sources.find(source => source.config.slug === config.slackSourceSlug)
    if (!notion || !slack) return null
    return { notion, slack }
  }

  private async loadSchema(config: NotionTaskConfig, notionSource: LoadedSource): Promise<NotionSchemaCache> {
    if (this.schemaCache && this.schemaCache.databaseId === config.databaseId && Date.now() - this.schemaCache.loadedAt < SCHEMA_CACHE_TTL_MS) {
      return this.schemaCache
    }

    const response = await this.requestNotion(notionSource, `databases/${config.databaseId}`, undefined, 'GET')
    const properties = new Map<string, NotionSchemaProperty>()
    const propertiesById = new Map<string, NotionSchemaProperty>()
    let titlePropertyName: string | null = null
    let titlePropertyId: string | null = null

    const responseProps = (response.properties ?? {}) as Record<string, JsonObject>
    for (const [name, value] of Object.entries(responseProps)) {
      const property: NotionSchemaProperty = {
        id: String(value.id ?? ''),
        name,
        type: String(value.type ?? ''),
      }
      properties.set(name, property)
      propertiesById.set(property.id, property)
      if (property.type === 'title') {
        titlePropertyName = name
        titlePropertyId = property.id
      }
    }

    this.schemaCache = {
      loadedAt: Date.now(),
      databaseId: config.databaseId,
      titlePropertyName,
      titlePropertyId,
      propertiesByName: properties,
      propertiesById,
    }
    return this.schemaCache
  }

  private async findNextCandidate(runtime: RuntimeConfigResult): Promise<CandidatePage | null> {
    const response = await this.requestNotion(runtime.sources.notion, `databases/${runtime.config.databaseId}/query`, {
      filter: this.buildDetectorFilter(runtime),
      page_size: runtime.config.limits.maxConcurrent,
      sorts: [{ timestamp: 'last_edited_time', direction: 'ascending' }],
    })

    const results = Array.isArray(response.results) ? response.results : []
    const candidate = results.find((item) => typeof item?.id === 'string')
    if (!candidate) return null

    return {
      id: candidate.id,
      lastEditedTime: String(candidate.last_edited_time ?? ''),
    }
  }

  private buildDetectorFilter(runtime: RuntimeConfigResult): JsonObject {
    const triggerProperty = runtime.config.trigger.property
    const statusProperty = runtime.config.status.property
    const readyValues = runtime.config.status.readyValues

    const triggerFilter: JsonObject = runtime.config.trigger.type === 'checkbox'
      ? { property: triggerProperty, checkbox: { equals: Boolean(runtime.config.trigger.value ?? true) } }
      : { property: triggerProperty, [runtime.config.trigger.type]: { equals: runtime.config.trigger.value } }

    const statusFilter: JsonObject = runtime.config.status.type === 'status'
      ? { property: statusProperty, status: { equals: readyValues[0] } }
      : { property: statusProperty, select: { equals: readyValues[0] } }

    if (readyValues.length === 1) {
      return { and: [triggerFilter, statusFilter] }
    }

    const statusOr = readyValues.map(value =>
      runtime.config.status.type === 'status'
        ? { property: statusProperty, status: { equals: value } }
        : { property: statusProperty, select: { equals: value } },
    )

    return {
      and: [
        triggerFilter,
        { or: statusOr },
      ],
    }
  }

  private async fetchPage(runtime: RuntimeConfigResult, pageId: string): Promise<DetailedPage | null> {
    const response = await this.requestNotion(runtime.sources.notion, `pages/${pageId}`, undefined, 'GET')
    if (!response?.id) return null
    return {
      id: response.id,
      url: response.url,
      lastEditedTime: String(response.last_edited_time ?? ''),
      properties: (response.properties ?? {}) as Record<string, JsonObject>,
    }
  }

  private extractPageTitle(runtime: RuntimeConfigResult, page: DetailedPage): string {
    const titlePropertyName = runtime.schema.titlePropertyName
    if (!titlePropertyName) return page.id
    const titleProperty = page.properties[titlePropertyName]
    const titleItems = Array.isArray(titleProperty?.title) ? titleProperty.title : []
    const text = titleItems
      .map(item => String((item as JsonObject).plain_text ?? ''))
      .join('')
      .trim()
    return text || page.id
  }

  private async fetchPageContent(runtime: RuntimeConfigResult, pageId: string): Promise<PageContentResult> {
    const blocks = await this.requestNotion(runtime.sources.notion, `blocks/${pageId}/children?page_size=100`, undefined, 'GET')
    const results = Array.isArray(blocks.results) ? blocks.results : []
    const markdown = results
      .map((block: JsonObject) => this.blockToMarkdown(block))
      .filter(Boolean)
      .join('\n\n')
      .trim()

    return {
      markdown: markdown || '_No content_',
      source: markdown ? 'blocks' : 'markdown',
    }
  }

  private blockToMarkdown(block: JsonObject): string {
    const type = String(block.type ?? '')
    const value = block[type] as JsonObject | undefined
    const richText = Array.isArray(value?.rich_text) ? value.rich_text : []
    const plain = richText.map(item => String((item as JsonObject).plain_text ?? '')).join('').trim()

    switch (type) {
      case 'paragraph':
        return plain
      case 'heading_1':
        return plain ? `# ${plain}` : ''
      case 'heading_2':
        return plain ? `## ${plain}` : ''
      case 'heading_3':
        return plain ? `### ${plain}` : ''
      case 'bulleted_list_item':
        return plain ? `- ${plain}` : ''
      case 'numbered_list_item':
        return plain ? `1. ${plain}` : ''
      case 'to_do':
        return plain ? `- [${value?.checked ? 'x' : ' '}] ${plain}` : ''
      default:
        return plain
    }
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
    const slackGateway = this.deps.createSlackGateway(config.slackSourceSlug)
    const kickoffText = [
      `*Notion AI Task*`,
      title,
      pageUrl ? `<${pageUrl}|Open in Notion>` : null,
      `Session: ${sessionId}`,
    ].filter(Boolean).join('\n')

    const message = await slackGateway.postMessage({
      channel: config.slackChannelId,
      text: truncateForPrompt(kickoffText, SLACK_TEXT_LIMIT),
    })

    let permalink: string | undefined
    let permalinkError: string | undefined
    try {
      permalink = await slackGateway.getPermalink({
        channel: config.slackChannelId,
        messageTs: message.ts,
      })
    } catch (error) {
      permalinkError = error instanceof Error ? error.message : String(error)
    }

    return {
      slackRef: {
        channelId: config.slackChannelId,
        threadTs: message.ts,
        rootMessageTs: message.ts,
        permalink,
      },
      permalinkError,
    }
  }

  private async postSlackSuccess(
    runtime: RuntimeConfigResult,
    slackRef: { channelId: string; threadTs: string; rootMessageTs: string; permalink?: string },
    reply: string,
  ): Promise<void> {
    const slackGateway = this.deps.createSlackGateway(runtime.config.slackSourceSlug)
    await slackGateway.postMessage({
      channel: slackRef.channelId,
      threadTs: slackRef.threadTs,
      text: truncateForPrompt(reply, SLACK_TEXT_LIMIT),
    })
  }

  private async postSlackFailure(
    runtime: RuntimeConfigResult,
    args: {
      slackRef: { channelId: string; threadTs: string; rootMessageTs: string; permalink?: string }
      title: string
      error: string
    },
  ): Promise<void> {
    const slackGateway = this.deps.createSlackGateway(runtime.config.slackSourceSlug)
    await slackGateway.postMessage({
      channel: args.slackRef.channelId,
      threadTs: args.slackRef.threadTs,
      text: truncateForPrompt(`Notion AI task failed for *${args.title}*\n${args.error}`, SLACK_TEXT_LIMIT),
    })
  }

  private async markRowClaimed(
    runtime: RuntimeConfigResult,
    pageId: string,
    sessionId: string,
    slackUrl?: string,
  ): Promise<void> {
    await this.updatePageProperties(runtime, pageId, {
      sessionId,
      slackUrl,
      statusValue: runtime.config.status.runningValue,
      claimedAt: this.deps.now().toISOString(),
      processedAt: undefined,
      summary: undefined,
    })
  }

  private async markRowDone(
    runtime: RuntimeConfigResult,
    pageId: string,
    sessionId: string,
    slackUrl: string | undefined,
    summary: string,
    lastEditedTime: string,
    contentHash: string,
  ): Promise<void> {
    await this.updatePageProperties(runtime, pageId, {
      sessionId,
      slackUrl,
      statusValue: runtime.config.status.doneValue,
      processedAt: this.deps.now().toISOString(),
      summary: truncateForPrompt(summary, NOTION_TEXT_LIMIT),
    })

    const ledger = await this.readLedger()
    ledger.pages[pageId] = {
      status: 'done',
      sessionId,
      contentHash,
      lastProcessedEditedTime: lastEditedTime,
      processedAt: this.deps.now().toISOString(),
    }
    await this.writeLedger(ledger)
    await this.appendEvent({ type: 'done', pageId, sessionId })
  }

  private async markRowFailed(
    runtime: RuntimeConfigResult,
    pageId: string,
    sessionId: string | undefined,
    error: string,
  ): Promise<void> {
    await this.updatePageProperties(runtime, pageId, {
      sessionId,
      statusValue: runtime.config.status.failedValue,
      processedAt: this.deps.now().toISOString(),
      summary: truncateForPrompt(`Failed: ${error}`, NOTION_TEXT_LIMIT),
    })

    const ledger = await this.readLedger()
    ledger.pages[pageId] = {
      status: 'failed',
      sessionId,
      processedAt: this.deps.now().toISOString(),
    }
    await this.writeLedger(ledger)
    await this.appendEvent({ type: 'failed', pageId, sessionId, error })
  }

  private async updatePageProperties(
    runtime: RuntimeConfigResult,
    pageId: string,
    args: {
      sessionId?: string
      slackUrl?: string
      statusValue?: string
      claimedAt?: string
      processedAt?: string
      summary?: string
    },
  ): Promise<void> {
    const properties: Record<string, JsonObject> = {}
    const config = runtime.config

    if (args.sessionId !== undefined) {
      properties[config.properties.sessionId] = { rich_text: args.sessionId ? [{ type: 'text', text: { content: args.sessionId } }] : [] }
    }
    if (args.slackUrl !== undefined) {
      properties[config.properties.slackUrl] = { url: args.slackUrl ?? null }
    }
    if (args.claimedAt !== undefined) {
      properties[config.properties.claimedAt] = { date: args.claimedAt ? { start: args.claimedAt } : null }
    }
    if (args.processedAt !== undefined) {
      properties[config.properties.processedAt] = { date: args.processedAt ? { start: args.processedAt } : null }
    }
    if (args.summary !== undefined) {
      properties[config.properties.summary] = { rich_text: args.summary ? [{ type: 'text', text: { content: args.summary } }] : [] }
    }
    if (args.statusValue !== undefined) {
      properties[config.status.property] = runtime.config.status.type === 'status'
        ? { status: { name: args.statusValue } }
        : { select: { name: args.statusValue } }
    }

    await this.requestNotion(runtime.sources.notion, `pages/${pageId}`, { properties }, 'PATCH')
  }

  private async requestNotion(
    notionSource: LoadedSource,
    path: string,
    body?: Record<string, unknown>,
    method: 'GET' | 'PATCH' | 'POST' = 'POST',
  ): Promise<JsonObject> {
    const tokenRefreshManager = new TokenRefreshManager(this.deps.credentialManager, {
      log: (message) => this.deps.logger.info(message),
    })
    const tokenResult = await tokenRefreshManager.ensureFreshToken(notionSource)
    const rawToken = tokenResult.success ? tokenResult.token : await this.deps.credentialManager.getToken(notionSource)
    const apiCredential = await this.deps.credentialManager.getApiCredential(notionSource)

    const tokenHeaders = parseHeaderCredential(rawToken)
    const credentialHeaders = parseHeaderCredential(apiCredential)

    let headers: Record<string, string>
    if (tokenHeaders || credentialHeaders) {
      headers = {
        ...(tokenHeaders ?? {}),
        ...(credentialHeaders ?? {}),
        'Content-Type': 'application/json',
      }
    } else if (typeof rawToken === 'string' && rawToken.trim()) {
      headers = {
        Authorization: `Bearer ${rawToken}`,
        'Notion-Version': NOTION_API_VERSION,
        'Content-Type': 'application/json',
      }
    } else {
      throw new Error(`No usable Notion credentials available for source ${notionSource.config.slug}`)
    }

    const response = await this.deps.fetchImpl(`https://api.notion.com/v1/${path}`, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Notion API ${method} ${path} failed (${response.status}): ${text}`)
    }

    return await response.json() as JsonObject
  }
}
