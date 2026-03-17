import { createHmac, timingSafeEqual } from 'crypto'
import { existsSync } from 'fs'
import { appendFile, copyFile, cp, mkdir, readFile, rm, symlink, writeFile } from 'fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { homedir } from 'os'
import { basename, join, relative } from 'path'
import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import { getCredentialManager } from '@craft-agent/shared/credentials'
import type { StoredCredential } from '@craft-agent/shared/credentials/types'
import { isValidLabelId } from '@craft-agent/shared/labels/storage'
import log from './logger'

const linearBridgeLog = log.scope('linear-agent')

const SERVICE_DIRNAME = '.linear-agent'
const CONFIG_FILENAME = 'config.json'
const SESSION_MAP_FILENAME = 'session-map.json'
const EVENTS_LOG_FILENAME = 'events.jsonl'
const LINEAR_SIGNATURE_HEADER = 'linear-signature'
const TIMESTAMP_TOLERANCE_MS = 60_000
const LINEAR_AUTHORIZE_URL = 'https://linear.app/oauth/authorize'
const LINEAR_TOKEN_URL = 'https://api.linear.app/oauth/token'
const execFileAsync = promisify(execFile)

type PermissionMode = 'safe' | 'ask' | 'allow-all'

interface LinearBridgeSessionLike {
  id: string
  isArchived?: boolean
  messages?: Array<{
    id?: string
    role?: string
    content?: string
    isIntermediate?: boolean
  }>
}

interface LinearBridgeSessionManagerLike {
  createSession(
    workspaceId: string,
    options?: {
      name?: string
      permissionMode?: PermissionMode
      llmConnection?: string
      model?: string
      labels?: string[]
      workingDirectory?: string | 'user_default' | 'none'
    },
  ): Promise<LinearBridgeSessionLike>
  getSession(sessionId: string): Promise<LinearBridgeSessionLike | null>
  sendMessage(sessionId: string, message: string): Promise<void>
  notifySessionCreated?(sessionId: string): void
}

type CraftTargetConfig = {
  kind: 'craft'
  namePrefix?: string
  permissionMode?: PermissionMode
  llmConnection?: string
  model?: string
  labels?: string[]
  workingDirectory?: string | 'user_default' | 'none'
  openLabel?: string
  externalUrlTemplate?: string
}

type CodexTargetConfig = {
  kind: 'codex'
  sessionId?: string
  useLastSession?: boolean
  workspacePath?: string
  launchDesktopApp?: boolean
  openLabel?: string
  externalUrlTemplate?: string
  fullAuto?: boolean
  dangerouslyBypassApprovalsAndSandbox?: boolean
  profile?: string
  model?: string
  codexConfig?: {
    reasoningEffort?: 'low' | 'medium' | 'high'
  }
  results?: {
    addIssueComment?: boolean
    addAgentResponse?: boolean
    moveToReviewOnCompleted?: boolean
    moveToDoneOnCompletedIfNoReview?: boolean
    appendArtifactLinksSection?: boolean
    artifactLinkBaseUrl?: string
    addLabels?: string[]
    createFollowupIssueOnBlocked?: boolean
    followupIssueTitlePrefix?: string
  }
}

export type LinearBridgeAgentConfig = {
  slug: string
  enabled: boolean
  linearAgentId?: string
  webhookPath: string
  oauthCallbackPath?: string
  oauthClientId?: string
  oauthClientIdEnv?: string
  oauthClientSecret?: string
  oauthClientSecretEnv?: string
  oauthScopes?: string[]
  apiToken?: string
  apiTokenEnv?: string
  webhookSecret?: string
  webhookSecretEnv?: string
  installationViewerId?: string
  target: CraftTargetConfig | CodexTargetConfig
}

export interface LinearBridgeConfig {
  enabled: boolean
  host: string
  port: number
  apiBaseUrl: string
  publicBaseUrl?: string
  webhookPrefix: string
  codexBin: string
  agents: LinearBridgeAgentConfig[]
}

interface LinearBridgeSessionMapEntry {
  agentSlug: string
  targetKind: 'craft' | 'codex'
  craftSessionId?: string
  codexThreadId?: string
  workspacePath?: string
  lastPromptAt: number
  updatedAt: number
}

interface LinearBridgeSessionMap {
  version: 1
  mappings: Record<string, LinearBridgeSessionMapEntry>
}

interface LinearBridgeNormalizedEvent {
  action: 'created' | 'prompted' | string
  eventType: string
  linearAgentId?: string
  agentSessionId: string
  prompt: string
  promptContext?: string
  issueId?: string
  issueIdentifier?: string
  issueTitle?: string
  issueUrl?: string
  webhookTimestamp?: number
  raw: Record<string, unknown>
}

interface LinearBridgeDependencies {
  fetchImpl: typeof fetch
  now: () => number
  logger: {
    info: (...args: unknown[]) => void
    warn: (...args: unknown[]) => void
    error: (...args: unknown[]) => void
  }
  spawnProcess: typeof spawn
}

interface LinearIssueSnapshot {
  id: string
  identifier: string
  title: string
  description: string
  url: string
  teamId?: string
  stateName?: string
  teamStates: Array<{ id: string; name: string; type?: string }>
  comments: string[]
}

interface CodexJsonResult {
  stdout: string
  stderr: string
  exitCode: number | null
  threadId: string | null
  finalMessage: string | null
}

interface LinearBridgeRunRecord {
  agentSessionId: string
  issueId?: string
  issueIdentifier?: string
  issueUrl?: string
  workspacePath: string
  startedAt: string
  finishedAt?: string
  durationMs?: number
  codexThreadId?: string | null
  prompt: string
  finalMessage?: string
  statusTag?: string
  usage?: {
    inputTokens?: number
    cachedInputTokens?: number
    outputTokens?: number
  }
  error?: string
}

const DEFAULT_CONFIG: LinearBridgeConfig = {
  enabled: false,
  host: '127.0.0.1',
  port: 8788,
  apiBaseUrl: 'https://api.linear.app/graphql',
  publicBaseUrl: '',
  webhookPrefix: '/webhooks/linear-agent',
  codexBin: process.env.CODEX_BIN || 'codex',
  agents: [
    {
      slug: 'craft',
      enabled: false,
      webhookPath: '/craft',
      oauthCallbackPath: '/oauth/craft/callback',
      oauthClientIdEnv: 'LINEAR_CRAFT_CLIENT_ID',
      oauthClientSecretEnv: 'LINEAR_CRAFT_CLIENT_SECRET',
      oauthScopes: ['read', 'write', 'app:mentionable', 'app:assignable'],
      apiTokenEnv: 'LINEAR_CRAFT_API_TOKEN',
      webhookSecretEnv: 'LINEAR_CRAFT_WEBHOOK_SECRET',
      target: {
        kind: 'craft',
        namePrefix: 'Linear',
        permissionMode: 'allow-all',
        workingDirectory: 'user_default',
        openLabel: 'Open in Craft',
      },
    },
    {
      slug: 'codex',
      enabled: false,
      webhookPath: '/codex',
      oauthCallbackPath: '/oauth/codex/callback',
      oauthClientIdEnv: 'LINEAR_CODEX_CLIENT_ID',
      oauthClientSecretEnv: 'LINEAR_CODEX_CLIENT_SECRET',
      oauthScopes: ['read', 'write', 'app:mentionable', 'app:assignable'],
      apiTokenEnv: 'LINEAR_CODEX_API_TOKEN',
      webhookSecretEnv: 'LINEAR_CODEX_WEBHOOK_SECRET',
      target: {
        kind: 'codex',
        launchDesktopApp: false,
        workspacePath: '.',
        sessionId: '',
        openLabel: 'Open in Codex',
        fullAuto: true,
        codexConfig: {
          reasoningEffort: 'medium',
        },
        results: {
          addIssueComment: true,
          addAgentResponse: true,
          moveToReviewOnCompleted: true,
          moveToDoneOnCompletedIfNoReview: true,
          appendArtifactLinksSection: true,
          addLabels: [],
          createFollowupIssueOnBlocked: false,
          followupIssueTitlePrefix: 'Follow-up:',
        },
      },
    },
  ],
}

const DEFAULT_SESSION_MAP: LinearBridgeSessionMap = {
  version: 1,
  mappings: {},
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function getNestedString(value: unknown, path: string[]): string | undefined {
  let current: unknown = value
  for (const key of path) {
    if (!isRecord(current)) return undefined
    current = current[key]
  }
  return typeof current === 'string' && current.trim() ? current : undefined
}

function getNestedValue(value: unknown, path: string[]): unknown {
  let current: unknown = value
  for (const key of path) {
    if (!isRecord(current)) return undefined
    current = current[key]
  }
  return current
}

function coercePromptContext(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (isRecord(value) || Array.isArray(value)) {
    const json = JSON.stringify(value)
    return json === '{}' || json === '[]' ? undefined : json
  }
  return undefined
}

function normalizeLinearPromptBody(text: string): string {
  return text
    .replace(/\[[^\]]+\]\(<[^>]+>\)\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function isLinearAgentSessionPlaceholderComment(text: string | undefined): boolean {
  if (!text) return false
  return /^This thread is for an agent session with [\w-]+\.$/i.test(text.trim())
}

function sanitizeWebhookPath(path: string): string {
  const trimmed = path.trim()
  if (!trimmed) return '/hook'
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

function joinWebhookPath(prefix: string, path: string): string {
  const normalizedPrefix = sanitizeWebhookPath(prefix).replace(/\/+$/, '')
  const normalizedPath = sanitizeWebhookPath(path)
  return `${normalizedPrefix}${normalizedPath}`
}

function resolveLinearAgentHome(workspaceRootPath: string): string {
  const override = process.env.CRAFT_LINEAR_AGENT_HOME?.trim()
  if (override) return override

  return join(homedir(), '.craft-agent', 'linear-agent')
}

function resolveLegacyLinearAgentHomes(workspaceRootPath: string, serviceDir: string): string[] {
  const candidates = [
    join(process.env.CRAFT_APP_ROOT?.trim() || process.cwd(), SERVICE_DIRNAME),
    join(workspaceRootPath, SERVICE_DIRNAME),
  ]

  const seen = new Set<string>()
  const result: string[] = []
  for (const candidate of candidates) {
    if (!candidate || candidate === serviceDir || seen.has(candidate)) continue
    seen.add(candidate)
    result.push(candidate)
  }
  return result
}

function buildOAuthCredentialSourceId(agentSlug: string): string {
  return `linear-agent-${agentSlug}`
}

function buildSessionMapKey(agentSlug: string, agentSessionId: string): string {
  return `${agentSlug}:${agentSessionId}`
}

function sanitizeWorkspaceSegment(value: string): string {
  return value
    .replace(/[^\w.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'issue'
}

function buildCraftSessionName(
  event: Pick<LinearBridgeNormalizedEvent, 'issueIdentifier' | 'issueTitle' | 'prompt'>,
  prefix = 'Linear',
): string {
  const issuePart = event.issueIdentifier?.trim()
  const titlePart = event.issueTitle?.trim()
  if (issuePart && titlePart) return `${prefix}: ${issuePart} ${titlePart}`.slice(0, 120)
  if (issuePart) return `${prefix}: ${issuePart}`.slice(0, 120)
  if (titlePart) return `${prefix}: ${titlePart}`.slice(0, 120)
  return `${prefix}: ${event.prompt.slice(0, 80)}`.slice(0, 120)
}

export function resolveLinearSessionLabels(workspaceRootPath: string, labels?: string[]): string[] {
  if (!isValidLabelId(workspaceRootPath, 'linear')) return labels ?? []
  return Array.from(new Set(['linear', ...(labels ?? [])]))
}

function maybeNormalizeTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return numeric
    const parsedDate = Date.parse(value)
    if (Number.isFinite(parsedDate)) return parsedDate
  }
  return undefined
}

function extractWebhookTimestamp(payload: Record<string, unknown>): number | undefined {
  return maybeNormalizeTimestamp(payload.webhookTimestamp)
    ?? maybeNormalizeTimestamp(payload.createdAt)
    ?? maybeNormalizeTimestamp(getNestedString(payload, ['data', 'createdAt']))
}

export function normalizeLinearAgentEvent(payload: unknown): LinearBridgeNormalizedEvent | null {
  if (!isRecord(payload)) return null

  const action = getNestedString(payload, ['action']) ?? ''
  const eventType = getNestedString(payload, ['type']) ?? ''
  if (!action || !eventType) return null

  const agentSessionId =
    getNestedString(payload, ['data', 'agentSession', 'id'])
    ?? getNestedString(payload, ['agentSession', 'id'])
  if (!agentSessionId) return null

  const promptContext =
    coercePromptContext(getNestedValue(payload, ['promptContext']))
    ?? coercePromptContext(getNestedValue(payload, ['guidance']))
    ?? coercePromptContext(getNestedValue(payload, ['data', 'agentSession', 'promptContext']))
    ?? coercePromptContext(getNestedValue(payload, ['agentSession', 'promptContext']))

  const activityPrompt =
    getNestedString(payload, ['agentActivity', 'content', 'body'])
    ?? getNestedString(payload, ['data', 'agentActivity', 'content', 'body'])
    ?? getNestedString(payload, ['agentActivity', 'body'])
    ?? getNestedString(payload, ['data', 'agentActivity', 'body'])

  const rawCommentPrompt =
    getNestedString(payload, ['agentSession', 'comment', 'body'])
    ?? getNestedString(payload, ['comment', 'body'])
  const commentPrompt = isLinearAgentSessionPlaceholderComment(rawCommentPrompt)
    ? undefined
    : rawCommentPrompt

  const prompt =
    (action === 'prompted' ? activityPrompt : undefined)
    ?? commentPrompt
    ?? activityPrompt
    ?? promptContext
    ?? ''

  const normalizedPrompt = normalizeLinearPromptBody(prompt)
  if (!normalizedPrompt) return null

  const issueId =
    getNestedString(payload, ['data', 'agentSession', 'issue', 'id'])
    ?? getNestedString(payload, ['agentSession', 'issue', 'id'])

  const issueIdentifier =
    getNestedString(payload, ['data', 'agentSession', 'issue', 'identifier'])
    ?? getNestedString(payload, ['agentSession', 'issue', 'identifier'])

  const issueTitle =
    getNestedString(payload, ['data', 'agentSession', 'issue', 'title'])
    ?? getNestedString(payload, ['agentSession', 'issue', 'title'])

  const issueUrl =
    getNestedString(payload, ['data', 'agentSession', 'issue', 'url'])
    ?? getNestedString(payload, ['agentSession', 'issue', 'url'])

  const linearAgentId =
    getNestedString(payload, ['appUserId'])
    ?? getNestedString(payload, ['data', 'agentSession', 'agent', 'id'])
    ?? getNestedString(payload, ['agentSession', 'agent', 'id'])

  return {
    action,
    eventType,
    linearAgentId,
    agentSessionId,
    prompt: normalizedPrompt,
    promptContext,
    issueId,
    issueIdentifier,
    issueTitle,
    issueUrl,
    webhookTimestamp: extractWebhookTimestamp(payload),
    raw: payload,
  }
}

function renderTemplate(template: string, values: Record<string, string | undefined>): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key) => values[key] ?? '')
}

export function buildCraftExternalUrl(
  workspaceId: string,
  sessionId: string,
  template?: string,
): string {
  if (template?.trim()) {
    return renderTemplate(template, {
      workspaceId,
      sessionId,
    })
  }
  return `craftagents://workspace/${encodeURIComponent(workspaceId)}/allSessions/session/${encodeURIComponent(sessionId)}?window=focused`
}

export function buildLinearInstallUrl(options: {
  clientId: string
  redirectUri: string
  scopes?: string[]
  actor?: 'app' | 'user'
  prompt?: 'consent'
  state?: string
}): string {
  const params = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    response_type: 'code',
  })
  if (options.scopes?.length) params.set('scope', options.scopes.join(','))
  if (options.actor) params.set('actor', options.actor)
  if (options.prompt) params.set('prompt', options.prompt)
  if (options.state) params.set('state', options.state)
  return `${LINEAR_AUTHORIZE_URL}?${params.toString()}`
}

function buildCodexCommonArgs(config: CodexTargetConfig): string[] {
  const args: string[] = []
  const reasoningEffort = config.codexConfig?.reasoningEffort || 'medium'

  if (config.fullAuto) args.push('--full-auto')
  if (config.dangerouslyBypassApprovalsAndSandbox) args.push('--dangerously-bypass-approvals-and-sandbox')
  args.push('--json')
  args.push('-c', `model_reasoning_effort="${reasoningEffort}"`)

  if (config.profile?.trim()) args.push('--profile', config.profile.trim())
  if (config.model?.trim()) args.push('--model', config.model.trim())

  return args
}

export function buildCodexExecArgs(config: CodexTargetConfig, workspacePath: string): string[] {
  return [
    'exec',
    ...buildCodexCommonArgs(config),
    '--skip-git-repo-check',
    '--cd',
    workspacePath,
  ]
}

export function buildCodexResumeArgs(config: CodexTargetConfig, threadId?: string): string[] {
  const args = ['exec', 'resume', ...buildCodexCommonArgs(config), '--skip-git-repo-check']

  if (threadId?.trim()) {
    args.push(threadId.trim())
    return args
  }

  if (config.sessionId?.trim()) {
    args.push(config.sessionId.trim())
  } else if (config.useLastSession) {
    args.push('--last')
  } else {
    throw new Error('Codex target requires either threadId, sessionId, or useLastSession=true')
  }

  return args
}

function resolveSecret(value: string | undefined, envName: string | undefined): string {
  if (value?.trim()) return value.trim()
  if (envName?.trim()) return process.env[envName.trim()]?.trim() ?? ''
  return ''
}

function resolveLinearApiTokenFallback(agentConfig: LinearBridgeAgentConfig): string {
  const explicit = resolveSecret(agentConfig.apiToken, agentConfig.apiTokenEnv)
  if (explicit) return explicit

  const slugUpper = agentConfig.slug.toUpperCase()
  const candidates = [
    `LINEAR_${slugUpper}_API_TOKEN`,
    'LINEAR_API_KEY',
  ]
  for (const name of candidates) {
    const value = process.env[name]?.trim()
    if (value) return value
  }
  return ''
}

function buildLinearAuthorizationHeader(accessToken: string): string {
  const token = accessToken.trim()
  if (!token) return token
  if (/^Bearer\s+/i.test(token)) return token
  if (token.startsWith('lin_api_')) return token
  return `Bearer ${token}`
}

function buildCallbackUrl(publicBaseUrl: string, callbackPath: string): string {
  return `${publicBaseUrl.replace(/\/+$/, '')}${sanitizeWebhookPath(callbackPath)}`
}

function htmlResponse(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>${body}</p></body></html>`
}

function buildCraftRedirectUrl(publicBaseUrl: string, workspaceId: string, sessionId: string): string {
  const encodedSessionId = encodeURIComponent(sessionId)
  const encodedWorkspaceId = encodeURIComponent(workspaceId)
  return `${publicBaseUrl.replace(/\/+$/, '')}/open/craft/${encodedWorkspaceId}/${encodedSessionId}`
}

function buildCraftRedirectPage(targetUrl: string): string {
  const escapedUrl = targetUrl.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${escapedUrl}"><title>Open Craft</title></head><body><p>Opening Craft…</p><p><a href="${escapedUrl}">Open Craft</a></p><script>window.location.href=${JSON.stringify(targetUrl)};</script></body></html>`
}

function verifyWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader || !secret) return false
  const received = Buffer.from(signatureHeader, 'hex')
  const expected = createHmac('sha256', secret).update(rawBody).digest()
  if (received.length !== expected.length) return false
  return timingSafeEqual(received, expected)
}

function isFreshTimestamp(timestamp: number | undefined, now: number): boolean {
  if (!timestamp) return true
  return Math.abs(now - timestamp) <= TIMESTAMP_TOLERANCE_MS
}

async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(path, 'utf-8')
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

async function runCommand(
  spawnProcess: typeof spawn,
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs?: number; env?: NodeJS.ProcessEnv },
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let finished = false
    const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000

    const timer = setTimeout(() => {
      if (finished) return
      finished = true
      child.kill('SIGTERM')
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`))
    }, timeoutMs)

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (error) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (exitCode) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      resolve({ exitCode, stdout, stderr })
    })
  })
}

function spawnDetached(
  spawnProcess: typeof spawn,
  command: string,
  args: string[],
  cwd: string,
): void {
  const child = spawnProcess(command, args, {
    cwd,
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
}

function parseCodexJsonStream(stdout: string): {
  threadId: string | null
  finalMessage: string | null
  usage: {
    inputTokens?: number
    cachedInputTokens?: number
    outputTokens?: number
  }
} {
  let threadId: string | null = null
  let finalMessage: string | null = null
  let usage: {
    inputTokens?: number
    cachedInputTokens?: number
    outputTokens?: number
  } = {}

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>
      if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
        threadId = event.thread_id
      }
      if (event.type === 'item.completed') {
        const item = event.item as Record<string, unknown> | undefined
        if (item?.type === 'agent_message' && typeof item.text === 'string') {
          finalMessage = item.text
        }
      }
      if (event.type === 'turn.completed') {
        const rawUsage = event.usage as Record<string, unknown> | undefined
        usage = {
          inputTokens: typeof rawUsage?.input_tokens === 'number' ? rawUsage.input_tokens : undefined,
          cachedInputTokens: typeof rawUsage?.cached_input_tokens === 'number' ? rawUsage.cached_input_tokens : undefined,
          outputTokens: typeof rawUsage?.output_tokens === 'number' ? rawUsage.output_tokens : undefined,
        }
      }
    } catch {
      // Ignore non-JSON lines emitted by Codex.
    }
  }

  return { threadId, finalMessage, usage }
}

export class LinearAgentBridgeService {
  private readonly workspaceId: string
  private readonly workspaceRootPath: string
  private readonly sessionManager: LinearBridgeSessionManagerLike
  private readonly credentialManager = getCredentialManager()
  private readonly deps: LinearBridgeDependencies
  private readonly serviceDir: string
  private readonly configPath: string
  private readonly sessionMapPath: string
  private readonly eventsPath: string

  private server: Server | null = null
  private started = false
  private readonly inFlightAgentSessions = new Map<string, Promise<void>>()
  private readonly inFlightIssues = new Set<string>()

  constructor(options: {
    workspaceId: string
    workspaceRootPath: string
    sessionManager: LinearBridgeSessionManagerLike
    deps?: Partial<LinearBridgeDependencies>
  }) {
    this.workspaceId = options.workspaceId
    this.workspaceRootPath = options.workspaceRootPath
    this.sessionManager = options.sessionManager
    this.deps = {
      fetchImpl: options.deps?.fetchImpl ?? fetch,
      now: options.deps?.now ?? (() => Date.now()),
      logger: options.deps?.logger ?? linearBridgeLog,
      spawnProcess: options.deps?.spawnProcess ?? spawn,
    }
    this.serviceDir = resolveLinearAgentHome(this.workspaceRootPath)
    this.configPath = join(this.serviceDir, CONFIG_FILENAME)
    this.sessionMapPath = join(this.serviceDir, SESSION_MAP_FILENAME)
    this.eventsPath = join(this.serviceDir, EVENTS_LOG_FILENAME)
  }

  async start(): Promise<void> {
    if (this.started) return

    await this.ensureStorageFiles()
    const config = await this.readConfig()
    if (!config.enabled) {
      this.deps.logger.info('[linear-agent] service disabled by config')
      return
    }

    const hasEnabledAgents = config.agents.some(agent => agent.enabled)
    if (!hasEnabledAgents) {
      this.deps.logger.info('[linear-agent] no enabled bridge agents configured')
      return
    }

    this.server = createServer((req, res) => {
      void this.handleRequest(req, res)
    })

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(config.port, config.host, () => {
        this.server!.off('error', reject)
        resolve()
      })
    })

    this.started = true
    this.deps.logger.info('[linear-agent] service started', {
      host: config.host,
      port: config.port,
      agents: config.agents.filter(agent => agent.enabled).map(agent => ({
        slug: agent.slug,
        webhookPath: joinWebhookPath(config.webhookPrefix, agent.webhookPath),
        target: agent.target.kind,
      })),
    })
  }

  async stop(): Promise<void> {
    if (!this.server) {
      this.started = false
      return
    }

    const server = this.server
    this.server = null
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
    this.started = false
  }

  private async ensureStorageFiles(): Promise<void> {
    await this.migrateLegacyStorageIfNeeded()
    await mkdir(this.serviceDir, { recursive: true })
    if (!existsSync(this.configPath)) {
      await writeFile(this.configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8')
    }
    if (!existsSync(this.sessionMapPath)) {
      await writeFile(this.sessionMapPath, JSON.stringify(DEFAULT_SESSION_MAP, null, 2), 'utf-8')
    }
    if (!existsSync(this.eventsPath)) {
      await writeFile(this.eventsPath, '', 'utf-8')
    }
    await this.repairSessionMapPaths()
  }

  private async migrateLegacyStorageIfNeeded(): Promise<void> {
    await mkdir(this.serviceDir, { recursive: true })
    const legacyHomes = resolveLegacyLinearAgentHomes(this.workspaceRootPath, this.serviceDir)
    const entries = [
      CONFIG_FILENAME,
      SESSION_MAP_FILENAME,
      EVENTS_LOG_FILENAME,
      'runs',
      'workspaces',
      'codex-home',
    ]

    for (const legacyHome of legacyHomes) {
      if (!existsSync(legacyHome)) continue
      for (const entry of entries) {
        const sourcePath = join(legacyHome, entry)
        const targetPath = join(this.serviceDir, entry)
        if (!existsSync(sourcePath) || existsSync(targetPath)) continue
        await cp(sourcePath, targetPath, { recursive: true, force: false, errorOnExist: true })
        this.deps.logger.info('[linear-agent] migrated legacy runtime entry', {
          sourcePath,
          targetPath,
        })
      }
    }
  }

  private async repairSessionMapPaths(): Promise<void> {
    const sessionMap = await readJsonFile(this.sessionMapPath, DEFAULT_SESSION_MAP)
    const legacyHomes = resolveLegacyLinearAgentHomes(this.workspaceRootPath, this.serviceDir)
    const currentWorkspacesDir = join(this.serviceDir, 'workspaces')
    const nextMappings: Record<string, LinearBridgeSessionMapEntry> = {}
    let changed = false

    for (const [key, entry] of Object.entries(sessionMap.mappings || {})) {
      let nextEntry = entry
      const currentPath = entry.workspacePath?.trim()
      if (currentPath) {
        const genericMarker = `${SERVICE_DIRNAME}/workspaces/`
        if (!currentPath.startsWith(`${currentWorkspacesDir}/`) && currentPath.includes(genericMarker)) {
          const relativePath = currentPath.slice(currentPath.indexOf(genericMarker) + genericMarker.length)
          const repairedPath = join(currentWorkspacesDir, relativePath)
          nextEntry = {
            ...entry,
            workspacePath: repairedPath,
            updatedAt: this.deps.now(),
          }
          changed = true
          this.deps.logger.info('[linear-agent] repaired generic session-map workspace path', {
            key,
            previousPath: currentPath,
            repairedPath,
          })
        }
        for (const legacyHome of legacyHomes) {
          const legacyWorkspacesDir = join(legacyHome, 'workspaces')
          const pathToCheck = nextEntry.workspacePath?.trim() || currentPath
          if (!pathToCheck.startsWith(`${legacyWorkspacesDir}/`)) continue
          const relativePath = relative(legacyWorkspacesDir, pathToCheck)
          const repairedPath = join(this.serviceDir, 'workspaces', relativePath)
          nextEntry = {
            ...entry,
            workspacePath: repairedPath,
            updatedAt: this.deps.now(),
          }
          changed = true
          this.deps.logger.info('[linear-agent] repaired session-map workspace path', {
            key,
            previousPath: pathToCheck,
            repairedPath,
          })
          break
        }
      }
      nextMappings[key] = nextEntry
    }

    if (changed) {
      await writeFile(this.sessionMapPath, JSON.stringify({
        version: 1,
        mappings: nextMappings,
      }, null, 2), 'utf-8')
    }
  }

  private async readConfig(): Promise<LinearBridgeConfig> {
    const config = await readJsonFile(this.configPath, DEFAULT_CONFIG)
    return {
      ...DEFAULT_CONFIG,
      ...config,
      host: config.host || DEFAULT_CONFIG.host,
      port: config.port || DEFAULT_CONFIG.port,
      apiBaseUrl: config.apiBaseUrl || DEFAULT_CONFIG.apiBaseUrl,
      webhookPrefix: config.webhookPrefix || DEFAULT_CONFIG.webhookPrefix,
      codexBin: config.codexBin || DEFAULT_CONFIG.codexBin,
      agents: Array.isArray(config.agents) && config.agents.length > 0
        ? config.agents
        : DEFAULT_CONFIG.agents,
    }
  }

  private async readSessionMap(): Promise<LinearBridgeSessionMap> {
    return await readJsonFile(this.sessionMapPath, DEFAULT_SESSION_MAP)
  }

  private async updateSessionMap(
    key: string,
    entry: LinearBridgeSessionMapEntry,
  ): Promise<void> {
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

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const config = await this.readConfig()
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')

    if (req.method === 'GET') {
      const craftOpenMatch = url.pathname.match(/^\/open\/craft\/([^/]+)\/([^/]+)$/)
      if (craftOpenMatch) {
        const workspaceId = decodeURIComponent(craftOpenMatch[1]!)
        const sessionId = decodeURIComponent(craftOpenMatch[2]!)
        const deepLink = `craftagents://workspace/${encodeURIComponent(workspaceId)}/allSessions/session/${encodeURIComponent(sessionId)}?window=focused`
        res.statusCode = 200
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end(buildCraftRedirectPage(deepLink))
        return
      }

      const callbackAgent = config.agents.find(agent =>
        agent.enabled && agent.oauthCallbackPath && url.pathname === sanitizeWebhookPath(agent.oauthCallbackPath),
      )
      if (!callbackAgent) {
        res.statusCode = 404
        res.end('Not Found')
        return
      }
      await this.handleOAuthCallback(config, callbackAgent, url, res)
      return
    }

    if (req.method !== 'POST') {
      res.statusCode = 405
      res.end('Method Not Allowed')
      return
    }

    const agentConfig = config.agents.find(agent =>
      agent.enabled && url.pathname === joinWebhookPath(config.webhookPrefix, agent.webhookPath),
    )

    if (!agentConfig) {
      res.statusCode = 404
      res.end('Not Found')
      return
    }

    const chunks: Buffer[] = []
    req.on('data', chunk => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })
    req.on('error', error => {
      this.deps.logger.error('[linear-agent] request stream error', { error })
      if (!res.headersSent) {
        res.statusCode = 500
        res.end('Request Error')
      }
    })
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks)
      void this.handleWebhookRequest(config, agentConfig, rawBody, req, res)
    })
  }

  private async handleWebhookRequest(
    config: LinearBridgeConfig,
    agentConfig: LinearBridgeAgentConfig,
    rawBody: Buffer,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const webhookSecret = resolveSecret(agentConfig.webhookSecret, agentConfig.webhookSecretEnv)
    const signature = req.headers[LINEAR_SIGNATURE_HEADER]
    const signatureValue = Array.isArray(signature) ? signature[0] : signature

    if (webhookSecret && !verifyWebhookSignature(rawBody, signatureValue, webhookSecret)) {
      this.deps.logger.warn('[linear-agent] webhook signature verification failed', {
        slug: agentConfig.slug,
      })
      res.statusCode = 401
      res.end('Invalid Signature')
      return
    }

    let payload: unknown
    try {
      payload = JSON.parse(rawBody.toString('utf-8'))
    } catch {
      res.statusCode = 400
      res.end('Invalid JSON')
      return
    }

    await this.appendEvent({
      type: 'webhook_raw',
      slug: agentConfig.slug,
      path: req.url ?? '',
      hasSignature: !!signatureValue,
      payload,
    })

    const event = normalizeLinearAgentEvent(payload)
    if (!event) {
      this.deps.logger.warn('[linear-agent] webhook payload did not match expected AgentSessionEvent shape', {
        slug: agentConfig.slug,
      })
      res.statusCode = 200
      res.end('Ignored')
      return
    }

    if (agentConfig.linearAgentId?.trim() && event.linearAgentId && agentConfig.linearAgentId.trim() !== event.linearAgentId) {
      this.deps.logger.warn('[linear-agent] agent id mismatch, ignoring event', {
        slug: agentConfig.slug,
        expected: agentConfig.linearAgentId,
        received: event.linearAgentId,
      })
      res.statusCode = 200
      res.end('Ignored')
      return
    }

    if (!isFreshTimestamp(event.webhookTimestamp, this.deps.now())) {
      this.deps.logger.warn('[linear-agent] stale webhook rejected', {
        slug: agentConfig.slug,
        agentSessionId: event.agentSessionId,
        webhookTimestamp: event.webhookTimestamp,
      })
      res.statusCode = 401
      res.end('Stale Webhook')
      return
    }

    await this.appendEvent({
      type: 'webhook',
      slug: agentConfig.slug,
      action: event.action,
      agentSessionId: event.agentSessionId,
      eventType: event.eventType,
      issueIdentifier: event.issueIdentifier,
    })

    res.statusCode = 200
    res.end('OK')

    this.enqueueAgentSession(event.agentSessionId, async () => {
      await this.processEvent(agentConfig, event).catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error)
        this.deps.logger.error('[linear-agent] event processing failed', {
          slug: agentConfig.slug,
          action: event.action,
          agentSessionId: event.agentSessionId,
          error: message,
        })
        await this.appendEvent({
          type: 'bridge-stage',
          slug: agentConfig.slug,
          agentSessionId: event.agentSessionId,
          issueIdentifier: event.issueIdentifier,
          stage: 'process_event_error',
          action: event.action,
          error: message,
          stack: error instanceof Error ? error.stack : undefined,
        })
        await this.safeCreateActivity(agentConfig, event.agentSessionId, 'error',
          `Bridge failed: ${message}`)
      })
    })
  }

  private async handleOAuthCallback(
    config: LinearBridgeConfig,
    agentConfig: LinearBridgeAgentConfig,
    url: URL,
    res: ServerResponse,
  ): Promise<void> {
    const code = url.searchParams.get('code')?.trim()
    const error = url.searchParams.get('error')?.trim()
    const errorDescription = url.searchParams.get('error_description')?.trim()

    if (error) {
      this.deps.logger.warn('[linear-agent] oauth callback returned error', {
        slug: agentConfig.slug,
        error,
        errorDescription,
      })
      res.statusCode = 400
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(htmlResponse('Linear authorization failed', errorDescription || error))
      return
    }

    if (!code) {
      res.statusCode = 400
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(htmlResponse('Missing authorization code', 'Linear did not provide an authorization code.'))
      return
    }

    try {
      const tokens = await this.exchangeAuthorizationCode(config, agentConfig, code)
      await this.saveOAuthCredential(agentConfig, tokens)
      const viewer = await this.fetchLinearViewer(agentConfig)
      if (viewer?.id) {
        await this.updateAgentConfig(agentConfig.slug, (currentAgent) => ({
          ...currentAgent,
          installationViewerId: viewer.id,
        }))
      }
      await this.appendEvent({
        type: 'oauth-installed',
        slug: agentConfig.slug,
        viewerId: viewer?.id,
      })

      res.statusCode = 200
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(htmlResponse('Linear authorization complete', 'You can close this window and return to Craft Agent.'))
    } catch (callbackError) {
      this.deps.logger.error('[linear-agent] oauth callback handling failed', {
        slug: agentConfig.slug,
        error: callbackError instanceof Error ? callbackError.message : String(callbackError),
      })
      res.statusCode = 500
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(htmlResponse('Linear authorization failed', callbackError instanceof Error ? callbackError.message : String(callbackError)))
    }
  }

  private async exchangeAuthorizationCode(
    config: LinearBridgeConfig,
    agentConfig: LinearBridgeAgentConfig,
    code: string,
  ): Promise<LinearTokenResponse> {
    const clientId = resolveSecret(agentConfig.oauthClientId, agentConfig.oauthClientIdEnv)
    const clientSecret = resolveSecret(agentConfig.oauthClientSecret, agentConfig.oauthClientSecretEnv)
    const callbackPath = agentConfig.oauthCallbackPath?.trim()
    const publicBaseUrl = config.publicBaseUrl?.trim()

    if (!clientId || !clientSecret || !callbackPath || !publicBaseUrl) {
      throw new Error('Missing Linear OAuth client configuration for callback handling')
    }

    const redirectUri = buildCallbackUrl(publicBaseUrl, callbackPath)
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    })
    const response = await this.deps.fetchImpl(LINEAR_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => '')
      throw new Error(`Linear token exchange failed with ${response.status}${errorText ? `: ${errorText}` : ''}`)
    }

    const json = await response.json() as Partial<LinearTokenResponse> & { error?: string; error_description?: string }
    if (!json.access_token) {
      throw new Error(json.error_description || json.error || 'Linear token exchange returned no access token')
    }

    return {
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      token_type: json.token_type,
      expires_in: json.expires_in,
      scope: json.scope,
    }
  }

  private async refreshStoredAccessToken(agentConfig: LinearBridgeAgentConfig): Promise<string | null> {
    const stored = await this.getStoredOAuthCredential(agentConfig)
    const refreshToken = stored?.refreshToken?.trim()
    const clientId = resolveSecret(agentConfig.oauthClientId, agentConfig.oauthClientIdEnv)
    const clientSecret = resolveSecret(agentConfig.oauthClientSecret, agentConfig.oauthClientSecretEnv)
    if (!refreshToken || !clientId || !clientSecret) return null

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    })
    const response = await this.deps.fetchImpl(LINEAR_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    })
    if (!response.ok) return null

    const json = await response.json() as Partial<LinearTokenResponse> & { error?: string }
    if (!json.access_token) return null

    const nextTokens: LinearTokenResponse = {
      access_token: json.access_token,
      refresh_token: json.refresh_token || refreshToken,
      token_type: json.token_type || stored?.tokenType,
      expires_in: json.expires_in,
      scope: json.scope,
    }
    await this.saveOAuthCredential(agentConfig, nextTokens)
    return nextTokens.access_token
  }

  private async saveOAuthCredential(agentConfig: LinearBridgeAgentConfig, tokens: LinearTokenResponse): Promise<void> {
    await this.credentialManager.set({
      type: 'source_oauth',
      workspaceId: this.workspaceId,
      sourceId: buildOAuthCredentialSourceId(agentConfig.slug),
    }, {
      value: tokens.access_token,
      refreshToken: tokens.refresh_token,
      tokenType: tokens.token_type,
      expiresAt: typeof tokens.expires_in === 'number' ? Date.now() + (tokens.expires_in * 1000) : undefined,
      clientId: resolveSecret(agentConfig.oauthClientId, agentConfig.oauthClientIdEnv) || undefined,
      clientSecret: resolveSecret(agentConfig.oauthClientSecret, agentConfig.oauthClientSecretEnv) || undefined,
      source: 'native',
    })
  }

  private async getStoredOAuthCredential(agentConfig: LinearBridgeAgentConfig): Promise<StoredCredential | null> {
    const sourceId = buildOAuthCredentialSourceId(agentConfig.slug)
    const primaryId = {
      type: 'source_oauth' as const,
      workspaceId: this.workspaceId,
      sourceId,
    }
    const primary = await this.credentialManager.get(primaryId)
    if (primary) return primary

    const ids = await this.credentialManager.list({ type: 'source_oauth' })
    for (const id of ids) {
      if (id.sourceId !== sourceId) continue
      const credential = await this.credentialManager.get(id)
      if (credential?.value?.trim()) {
        return credential
      }
    }
    return null
  }

  private async getStoredAccessToken(agentConfig: LinearBridgeAgentConfig): Promise<string | null> {
    const stored = await this.getStoredOAuthCredential(agentConfig)
    return stored?.value?.trim() || null
  }

  private async fetchLinearViewer(agentConfig: LinearBridgeAgentConfig): Promise<{ id?: string } | null> {
    const data = await this.linearGraphql(agentConfig, `
      query LinearViewer {
        viewer {
          id
        }
      }
    `, {})
    const viewer = (data as { viewer?: { id?: string } })?.viewer
    return viewer ?? null
  }

  private async updateAgentConfig(
    slug: string,
    updater: (agent: LinearBridgeAgentConfig) => LinearBridgeAgentConfig,
  ): Promise<void> {
    const config = await this.readConfig()
    const nextAgents = config.agents.map(agent => agent.slug === slug ? updater(agent) : agent)
    await writeFile(this.configPath, JSON.stringify({
      ...config,
      agents: nextAgents,
    }, null, 2), 'utf-8')
  }

  private enqueueAgentSession(agentSessionId: string, task: () => Promise<void>): void {
    const previous = this.inFlightAgentSessions.get(agentSessionId) ?? Promise.resolve()
    const next = previous
      .catch(() => {})
      .then(task)
      .finally(() => {
        if (this.inFlightAgentSessions.get(agentSessionId) === next) {
          this.inFlightAgentSessions.delete(agentSessionId)
        }
      })
    this.inFlightAgentSessions.set(agentSessionId, next)
  }

  private async withIssueLock<T>(issueId: string | undefined, task: () => Promise<T>): Promise<T> {
    if (!issueId) return await task()
    if (this.inFlightIssues.has(issueId)) {
      throw new Error(`Issue ${issueId} is already being processed`)
    }
    this.inFlightIssues.add(issueId)
    try {
      return await task()
    } finally {
      this.inFlightIssues.delete(issueId)
    }
  }

  private async fetchIssueSnapshot(agentConfig: LinearBridgeAgentConfig, event: LinearBridgeNormalizedEvent): Promise<LinearIssueSnapshot | null> {
    const issueLookup = event.issueIdentifier || event.issueId
    if (!issueLookup) return null

    const data = await this.linearGraphql(agentConfig, `
      query BridgeIssue($id: String!) {
        issue(id: $id) {
          id
          identifier
          title
          description
          url
          team { id states(first: 50) { nodes { id name type } } }
          state { name }
          comments(first: 20) { nodes { body } }
        }
      }
    `, { id: issueLookup })

    const issue = (data as {
      issue?: {
        id: string
        identifier: string
        title: string
        description?: string | null
        url: string
        team?: { id?: string; states?: { nodes?: Array<{ id: string; name: string; type?: string | null }> } } | null
        state?: { name?: string | null } | null
        comments?: { nodes?: Array<{ body?: string | null }> } | null
      } | null
    }).issue

    if (!issue) return null

    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description || '',
      url: issue.url,
      teamId: issue.team?.id || undefined,
      stateName: issue.state?.name || undefined,
      teamStates: (issue.team?.states?.nodes ?? []).map(state => ({
        id: state.id,
        name: state.name,
        type: state.type || undefined,
      })),
      comments: (issue.comments?.nodes ?? [])
        .map(node => node.body?.trim())
        .filter((body): body is string => !!body && !isLinearAgentSessionPlaceholderComment(body)),
    }
  }

  private async ensureBridgeCodexHome(): Promise<string> {
    const bridgeHome = join(this.serviceDir, 'codex-home')
    const skillsDir = join(bridgeHome, 'skills')
    const logDir = join(bridgeHome, 'log')
    await mkdir(bridgeHome, { recursive: true })
    await mkdir(skillsDir, { recursive: true })
    await mkdir(logDir, { recursive: true })

    const sourceAuth = join(homedir(), '.codex', 'auth.json')
    const targetAuth = join(bridgeHome, 'auth.json')
    if (existsSync(sourceAuth)) {
      try {
        await rm(targetAuth, { force: true })
      } catch {}
      try {
        await symlink(sourceAuth, targetAuth)
      } catch {
        try {
          await copyFile(sourceAuth, targetAuth)
        } catch {}
      }
    }

    const bridgeConfig = [
      'model = "gpt-5.4"',
      'model_reasoning_effort = "medium"',
      '[features]',
      'multi_agent = false',
      'parallel = false',
      '',
    ].join('\n')
    await writeFile(join(bridgeHome, 'config.toml'), bridgeConfig, 'utf-8')
    return bridgeHome
  }

  private async buildBridgeCodexEnv(agentConfig: LinearBridgeAgentConfig): Promise<NodeJS.ProcessEnv> {
    const bridgeHome = await this.ensureBridgeCodexHome()
    return {
      ...process.env,
      CODEX_HOME: bridgeHome,
      TERM: 'xterm-256color',
      LINEAR_API_KEY: (await this.getStoredAccessToken(agentConfig)) ?? process.env.LINEAR_API_KEY ?? '',
    }
  }

  private async materializeIssueWorkspace(sourceRepoPath: string, workspacePath: string): Promise<void> {
    await mkdir(join(this.serviceDir, 'workspaces'), { recursive: true })
    await rm(workspacePath, { recursive: true, force: true })
    await mkdir(workspacePath, { recursive: true })

    await execFileAsync('rsync', [
      '-a',
      '--exclude',
      '.next',
      '--exclude',
      'node_modules',
      '--exclude',
      '.git',
      '--exclude',
      '.DS_Store',
      '--exclude',
      'sessions',
      '--exclude',
      '.linear-agent',
      '--exclude',
      'dist',
      '--exclude',
      '*.map',
      `${sourceRepoPath}/`,
      `${workspacePath}/`,
    ])
  }

  private async writeRunRecord(record: LinearBridgeRunRecord): Promise<void> {
    const runsDir = join(this.serviceDir, 'runs')
    await mkdir(runsDir, { recursive: true })
    const name = record.issueIdentifier || record.agentSessionId
    await writeFile(join(runsDir, `${name}.json`), JSON.stringify(record, null, 2), 'utf-8')
  }

  private resolveReviewStateId(issue: LinearIssueSnapshot | null | undefined): string | null {
    if (!issue) return null
    const preferredNames = ['Needs Review', 'Human Review', 'In Review', 'Review']
    for (const name of preferredNames) {
      const match = issue.teamStates.find(state => state.name === name)
      if (match) return match.id
    }
    return null
  }

  private resolveDoneStateId(issue: LinearIssueSnapshot | null | undefined): string | null {
    if (!issue) return null
    const preferredNames = ['Done', 'Completed', 'Closed']
    for (const name of preferredNames) {
      const match = issue.teamStates.find(state => state.name === name)
      if (match) return match.id
    }
    return null
  }

  private async createIssueComment(agentConfig: LinearBridgeAgentConfig, issueId: string, body: string): Promise<void> {
    await this.linearGraphql(agentConfig, `
      mutation BridgeCommentCreate($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) {
          success
        }
      }
    `, { issueId, body })
  }

  private async moveIssueToState(agentConfig: LinearBridgeAgentConfig, issueId: string, stateId: string): Promise<void> {
    await this.linearGraphql(agentConfig, `
      mutation BridgeIssueMove($issueId: String!, $stateId: String!) {
        issueUpdate(id: $issueId, input: { stateId: $stateId }) {
          success
        }
      }
    `, { issueId, stateId })
  }

  private async addIssueLabels(agentConfig: LinearBridgeAgentConfig, issueId: string, labels: string[]): Promise<void> {
    if (labels.length === 0) return
    await this.linearGraphql(agentConfig, `
      mutation BridgeIssueLabelUpdate($issueId: String!, $labels: [String!]!) {
        issueUpdate(id: $issueId, input: { labelIds: $labels }) {
          success
        }
      }
    `, { issueId, labels })
  }

  private async createFollowupIssue(
    agentConfig: LinearBridgeAgentConfig,
    issue: LinearIssueSnapshot,
    title: string,
    description: string,
  ): Promise<void> {
    if (!issue.teamId) return
    await this.linearGraphql(agentConfig, `
      mutation BridgeIssueCreate($title: String!, $description: String!, $teamId: String!) {
        issueCreate(input: { title: $title, description: $description, teamId: $teamId }) {
          success
        }
      }
    `, {
      title,
      description,
      teamId: issue.teamId,
    })
  }

  private async processEvent(
    agentConfig: LinearBridgeAgentConfig,
    event: LinearBridgeNormalizedEvent,
  ): Promise<void> {
    await this.appendEvent({
      type: 'bridge-stage',
      slug: agentConfig.slug,
      agentSessionId: event.agentSessionId,
      issueIdentifier: event.issueIdentifier,
      stage: 'process_event_start',
      action: event.action,
    })
    await this.safeCreateActivity(
      agentConfig,
      event.agentSessionId,
      'thought',
      event.action === 'created'
        ? `Opening ${agentConfig.target.kind === 'craft' ? 'Craft' : 'Codex'} session...`
        : `Forwarding follow-up to ${agentConfig.target.kind === 'craft' ? 'Craft' : 'Codex'}...`,
      true,
    )
    await this.appendEvent({
      type: 'bridge-stage',
      slug: agentConfig.slug,
      agentSessionId: event.agentSessionId,
      issueIdentifier: event.issueIdentifier,
      stage: 'thought_activity_written',
      action: event.action,
    })

    if (agentConfig.target.kind === 'craft') {
      const craftAgent = agentConfig as LinearBridgeAgentConfig & { target: CraftTargetConfig }
      await this.appendEvent({
        type: 'bridge-stage',
        slug: agentConfig.slug,
        agentSessionId: event.agentSessionId,
        issueIdentifier: event.issueIdentifier,
        stage: 'route_craft',
      })
      await this.handleCraftTarget(craftAgent, event)
      return
    }

    const config = await this.readConfig()
    const codexAgent = agentConfig as LinearBridgeAgentConfig & { target: CodexTargetConfig }
    await this.appendEvent({
      type: 'bridge-stage',
      slug: agentConfig.slug,
      agentSessionId: event.agentSessionId,
      issueIdentifier: event.issueIdentifier,
      stage: 'route_codex',
    })
    await this.handleCodexTarget(config, codexAgent, event)
  }

  private async handleCraftTarget(
    agentConfig: LinearBridgeAgentConfig & { target: CraftTargetConfig },
    event: LinearBridgeNormalizedEvent,
  ): Promise<void> {
    await this.appendEvent({
      type: 'craft-stage',
      slug: agentConfig.slug,
      agentSessionId: event.agentSessionId,
      issueIdentifier: event.issueIdentifier,
      stage: 'start',
      action: event.action,
    })
    const config = await this.readConfig()
    await this.appendEvent({
      type: 'craft-stage',
      slug: agentConfig.slug,
      agentSessionId: event.agentSessionId,
      issueIdentifier: event.issueIdentifier,
      stage: 'issue_snapshot_fetch_start',
      issueId: event.issueId,
    })
    const issue = await this.fetchIssueSnapshot(agentConfig, event)
    await this.appendEvent({
      type: 'craft-stage',
      slug: agentConfig.slug,
      agentSessionId: event.agentSessionId,
      issueIdentifier: issue?.identifier ?? event.issueIdentifier,
      stage: 'issue_snapshot_loaded',
      issueId: issue?.id ?? event.issueId,
      stateName: issue?.stateName,
      commentCount: issue?.comments.length ?? 0,
    })
    const mapKey = buildSessionMapKey(agentConfig.slug, event.agentSessionId)
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
      await this.appendEvent({
        type: 'craft-stage',
        slug: agentConfig.slug,
        agentSessionId: event.agentSessionId,
        issueIdentifier: issue?.identifier ?? event.issueIdentifier,
        stage: 'session_create_start',
      })
      const sessionName = buildCraftSessionName(event, agentConfig.target.namePrefix || 'Linear')
      session = await this.sessionManager.createSession(this.workspaceId, {
        name: sessionName,
        permissionMode: agentConfig.target.permissionMode,
        llmConnection: agentConfig.target.llmConnection,
        model: agentConfig.target.model,
        labels: resolveLinearSessionLabels(this.workspaceRootPath, agentConfig.target.labels),
        workingDirectory: agentConfig.target.workingDirectory,
      })
      this.sessionManager.notifySessionCreated?.(session.id)
      await this.appendEvent({
        type: 'craft-stage',
        slug: agentConfig.slug,
        agentSessionId: event.agentSessionId,
        issueIdentifier: issue?.identifier ?? event.issueIdentifier,
        stage: 'session_create_complete',
        craftSessionId: session.id,
      })
    }

    const externalUrl = agentConfig.target.externalUrlTemplate?.trim()
      ? renderTemplate(agentConfig.target.externalUrlTemplate, {
        workspaceId: this.workspaceId,
        sessionId: session.id,
      })
      : buildCraftRedirectUrl(config.publicBaseUrl || 'https://macbookair.tail6a946f.ts.net', this.workspaceId, session.id)
    await this.safeUpdateExternalUrl(
      agentConfig,
      event.agentSessionId,
      agentConfig.target.openLabel || 'Open in Craft',
      externalUrl,
    )

    await this.updateSessionMap(mapKey, {
      agentSlug: agentConfig.slug,
      targetKind: 'craft',
      craftSessionId: session.id,
      lastPromptAt: this.deps.now(),
      updatedAt: this.deps.now(),
    })

    const prompt = event.action === 'created'
      ? (event.promptContext || event.prompt)
      : event.prompt
    const previousAssistantId = getLatestAssistantId(session)
    await this.appendEvent({
      type: 'craft-stage',
      slug: agentConfig.slug,
      agentSessionId: event.agentSessionId,
      issueIdentifier: issue?.identifier ?? event.issueIdentifier,
      stage: 'send_message',
      craftSessionId: session.id,
      promptPreview: prompt.slice(0, 300),
    })

    await this.sessionManager.sendMessage(session.id, prompt)
    await this.appendEvent({
      type: 'craft-stage',
      slug: agentConfig.slug,
      agentSessionId: event.agentSessionId,
      issueIdentifier: issue?.identifier ?? event.issueIdentifier,
      stage: 'send_message_complete',
      craftSessionId: session.id,
    })
    const finalSession = await this.sessionManager.getSession(session.id)
    const finalReply = extractLatestAssistantReply(finalSession, previousAssistantId)
    if (!finalReply) {
      await this.appendEvent({
        type: 'craft-stage',
        slug: agentConfig.slug,
        agentSessionId: event.agentSessionId,
        issueIdentifier: issue?.identifier ?? event.issueIdentifier,
        stage: 'no_final_reply',
        craftSessionId: session.id,
      })
      throw new Error('Craft session completed without a final assistant reply')
    }

    await this.safeCreateActivity(
      agentConfig,
      event.agentSessionId,
      'response',
      finalReply,
    )

    if (issue?.id) {
      await this.createIssueComment(agentConfig, issue.id, finalReply)
      const reviewStateId = this.resolveReviewStateId(issue)
      if (reviewStateId) {
        await this.moveIssueToState(agentConfig, issue.id, reviewStateId)
      }
    }

    await this.appendEvent({
      type: 'craft-exec',
      slug: agentConfig.slug,
      agentSessionId: event.agentSessionId,
      sessionId: session.id,
      finalMessage: finalReply.slice(-4000),
    })
  }

  private async handleCodexTarget(
    config: LinearBridgeConfig,
    agentConfig: LinearBridgeAgentConfig & { target: CodexTargetConfig },
    event: LinearBridgeNormalizedEvent,
  ): Promise<void> {
    await this.appendEvent({
      type: 'codex-stage',
      slug: agentConfig.slug,
      agentSessionId: event.agentSessionId,
      issueIdentifier: event.issueIdentifier,
      stage: 'start',
      action: event.action,
    })
    await this.appendEvent({
      type: 'codex-stage',
      slug: agentConfig.slug,
      agentSessionId: event.agentSessionId,
      issueIdentifier: event.issueIdentifier,
      stage: 'issue_snapshot_fetch_start',
      issueId: event.issueId,
    })
    const issue = await this.fetchIssueSnapshot(agentConfig, event)
    await this.appendEvent({
      type: 'codex-stage',
      slug: agentConfig.slug,
      agentSessionId: event.agentSessionId,
      issueIdentifier: issue?.identifier ?? event.issueIdentifier,
      stage: 'issue_snapshot_loaded',
      issueId: issue?.id ?? event.issueId,
      stateName: issue?.stateName,
      commentCount: issue?.comments.length ?? 0,
    })
    await this.appendEvent({
      type: 'codex-stage',
      slug: agentConfig.slug,
      agentSessionId: event.agentSessionId,
      issueIdentifier: issue?.identifier ?? event.issueIdentifier,
      stage: 'issue_lock_attempt',
      issueId: issue?.id ?? event.issueId,
    })
    await this.withIssueLock(issue?.id ?? event.issueId, async () => {
      await this.appendEvent({
        type: 'codex-stage',
        slug: agentConfig.slug,
        agentSessionId: event.agentSessionId,
        issueIdentifier: issue?.identifier ?? event.issueIdentifier,
        stage: 'issue_lock_acquired',
        issueId: issue?.id ?? event.issueId,
      })
      const sourceRepoPath = resolveCodexWorkspacePath(this.workspaceRootPath, agentConfig.target.workspacePath)
      const mapKey = buildSessionMapKey(agentConfig.slug, event.agentSessionId)
      const sessionMap = await this.readSessionMap()
      const existingEntry = sessionMap.mappings[mapKey]
      const codexThreadId = existingEntry?.codexThreadId?.trim() || undefined
      const issueWorkspaceName = sanitizeWorkspaceSegment(issue?.identifier || event.issueIdentifier || event.agentSessionId)
      const workspacePath = existingEntry?.workspacePath
        || join(this.serviceDir, 'workspaces', issueWorkspaceName)
      const prompt = buildCodexBridgePrompt(event, issue)
      await this.appendEvent({
        type: 'codex-stage',
        slug: agentConfig.slug,
        agentSessionId: event.agentSessionId,
        issueIdentifier: issue?.identifier ?? event.issueIdentifier,
        stage: 'prompt_built',
        promptPreview: prompt.slice(0, 400),
        existingThreadId: codexThreadId ?? null,
        existingWorkspacePath: existingEntry?.workspacePath ?? null,
      })
      const runRecord: LinearBridgeRunRecord = {
        agentSessionId: event.agentSessionId,
        issueId: issue?.id ?? event.issueId,
        issueIdentifier: issue?.identifier ?? event.issueIdentifier,
        issueUrl: issue?.url ?? event.issueUrl,
        workspacePath,
        startedAt: new Date(this.deps.now()).toISOString(),
        prompt,
      }

      if (event.action === 'created' || !existingEntry?.workspacePath) {
        await this.appendEvent({
          type: 'codex-stage',
          slug: agentConfig.slug,
          agentSessionId: event.agentSessionId,
          issueIdentifier: issue?.identifier ?? event.issueIdentifier,
          stage: 'workspace_materialize_start',
          workspacePath,
          sourceRepoPath,
        })
        await this.materializeIssueWorkspace(sourceRepoPath, workspacePath)
        await this.appendEvent({
          type: 'codex-stage',
          slug: agentConfig.slug,
          agentSessionId: event.agentSessionId,
          issueIdentifier: issue?.identifier ?? event.issueIdentifier,
          stage: 'workspace_materialize_complete',
          workspacePath,
        })
      }

      if (agentConfig.target.externalUrlTemplate?.trim()) {
        const url = renderTemplate(agentConfig.target.externalUrlTemplate, {
          workspacePath,
          workspaceName: basename(workspacePath),
          sessionId: codexThreadId,
          agentSessionId: event.agentSessionId,
        })
        await this.safeUpdateExternalUrl(
          agentConfig,
          event.agentSessionId,
          agentConfig.target.openLabel || 'Open in Codex',
          url,
        )
      }

      if (agentConfig.target.launchDesktopApp && !codexThreadId) {
        spawnDetached(
          this.deps.spawnProcess,
          config.codexBin,
          ['app', workspacePath],
          workspacePath,
        )
      }

      const args = codexThreadId
        ? buildCodexResumeArgs(agentConfig.target, codexThreadId)
        : buildCodexExecArgs(agentConfig.target, workspacePath)
      const bridgeEnv = await this.buildBridgeCodexEnv(agentConfig)
      await this.appendEvent({
        type: 'codex-stage',
        slug: agentConfig.slug,
        agentSessionId: event.agentSessionId,
        issueIdentifier: issue?.identifier ?? event.issueIdentifier,
        stage: 'codex_launch',
        workspacePath,
        codexThreadId: codexThreadId ?? null,
        args,
        codexHome: bridgeEnv.CODEX_HOME,
        hasLinearApiKey: Boolean(bridgeEnv.LINEAR_API_KEY),
      })

      const result = await runCommand(
        this.deps.spawnProcess,
        config.codexBin,
        [...args, prompt],
        {
          cwd: workspacePath,
          env: bridgeEnv,
        },
      )
      await this.appendEvent({
        type: 'codex-stage',
        slug: agentConfig.slug,
        agentSessionId: event.agentSessionId,
        issueIdentifier: issue?.identifier ?? event.issueIdentifier,
        stage: 'codex_process_complete',
        exitCode: result.exitCode,
        stdoutPreview: result.stdout.slice(0, 400),
        stderrPreview: result.stderr.slice(0, 400),
      })

      if (result.exitCode !== 0) {
        runRecord.finishedAt = new Date(this.deps.now()).toISOString()
        runRecord.durationMs = Date.parse(runRecord.finishedAt) - Date.parse(runRecord.startedAt)
        runRecord.error = result.stderr.trim() || `Codex exited with code ${result.exitCode}`
        await this.writeRunRecord(runRecord)
        throw new Error(runRecord.error)
      }

      const parsed = parseCodexJsonStream(result.stdout)
      const finalMessage = parsed.finalMessage?.trim() || extractCodexFinalMessage(result.stdout)
      if (!finalMessage) {
        runRecord.finishedAt = new Date(this.deps.now()).toISOString()
        runRecord.durationMs = Date.parse(runRecord.finishedAt) - Date.parse(runRecord.startedAt)
        runRecord.error = 'Codex completed without a final message'
        await this.writeRunRecord(runRecord)
        throw new Error('Codex completed without a final message')
      }

      runRecord.finishedAt = new Date(this.deps.now()).toISOString()
      runRecord.durationMs = Date.parse(runRecord.finishedAt) - Date.parse(runRecord.startedAt)
      runRecord.codexThreadId = parsed.threadId || codexThreadId || null
      const structured = parseBridgeStatusTag(finalMessage)
      runRecord.finalMessage = structured.body
      runRecord.statusTag = structured.statusTag
      runRecord.usage = parsed.usage
      await this.appendEvent({
        type: 'codex-stage',
        slug: agentConfig.slug,
        agentSessionId: event.agentSessionId,
        issueIdentifier: issue?.identifier ?? event.issueIdentifier,
        stage: 'codex_result_parsed',
        statusTag: structured.statusTag,
        codexThreadId: parsed.threadId || codexThreadId,
        usage: parsed.usage,
      })

      await this.updateSessionMap(
        mapKey,
        {
          agentSlug: agentConfig.slug,
          targetKind: 'codex',
          codexThreadId: parsed.threadId || codexThreadId,
          workspacePath,
          lastPromptAt: this.deps.now(),
          updatedAt: this.deps.now(),
        },
      )

      await this.writeRunRecord(runRecord)

      const resultsConfig = agentConfig.target.results
      const artifactLinksSection = resultsConfig?.appendArtifactLinksSection
        ? `\n\nArtifacts:\n- Workspace: ${workspacePath}`
        : ''
      const finalResponseBody = `${structured.body}${artifactLinksSection}`.trim()

      if (resultsConfig?.addAgentResponse !== false) {
        await this.safeCreateActivity(
          agentConfig,
          event.agentSessionId,
          'response',
          finalResponseBody,
        )
        await this.appendEvent({
          type: 'codex-stage',
          slug: agentConfig.slug,
          agentSessionId: event.agentSessionId,
          issueIdentifier: issue?.identifier ?? event.issueIdentifier,
          stage: 'agent_response_written',
        })
      }

      if (issue?.id) {
        if (resultsConfig?.addIssueComment !== false) {
          await this.createIssueComment(agentConfig, issue.id, finalResponseBody)
          await this.appendEvent({
            type: 'codex-stage',
            slug: agentConfig.slug,
            agentSessionId: event.agentSessionId,
            issueIdentifier: issue.identifier,
            stage: 'issue_comment_written',
            issueId: issue.id,
          })
        }
        if (resultsConfig?.addLabels?.length) {
          await this.addIssueLabels(agentConfig, issue.id, resultsConfig.addLabels)
          await this.appendEvent({
            type: 'codex-stage',
            slug: agentConfig.slug,
            agentSessionId: event.agentSessionId,
            issueIdentifier: issue.identifier,
            stage: 'issue_labels_written',
            labels: resultsConfig.addLabels,
          })
        }
        if (structured.statusTag === 'completed') {
          if (resultsConfig?.moveToReviewOnCompleted !== false) {
            const reviewStateId = this.resolveReviewStateId(issue)
            if (reviewStateId) {
              await this.moveIssueToState(agentConfig, issue.id, reviewStateId)
              await this.appendEvent({
                type: 'codex-stage',
                slug: agentConfig.slug,
                agentSessionId: event.agentSessionId,
                issueIdentifier: issue.identifier,
                stage: 'issue_moved_to_review',
                stateId: reviewStateId,
              })
            } else if (resultsConfig?.moveToDoneOnCompletedIfNoReview) {
              const doneStateId = this.resolveDoneStateId(issue)
              if (doneStateId) {
                await this.moveIssueToState(agentConfig, issue.id, doneStateId)
                await this.appendEvent({
                  type: 'codex-stage',
                  slug: agentConfig.slug,
                  agentSessionId: event.agentSessionId,
                  issueIdentifier: issue.identifier,
                  stage: 'issue_moved_to_done',
                  stateId: doneStateId,
                })
              }
            }
          }
        } else if (structured.statusTag === 'blocked' && resultsConfig?.createFollowupIssueOnBlocked) {
          await this.createFollowupIssue(
            agentConfig,
            issue,
            `${resultsConfig.followupIssueTitlePrefix || 'Follow-up:'} ${issue.identifier}`,
            finalResponseBody,
          )
        }
      }

      await this.appendEvent({
        type: 'codex-exec',
        slug: agentConfig.slug,
        agentSessionId: event.agentSessionId,
        sessionId: parsed.threadId || codexThreadId,
        durationMs: runRecord.durationMs,
        statusTag: structured.statusTag,
        usage: parsed.usage,
        finalMessage: finalResponseBody.slice(-4000),
        stdout: result.stdout.trim().slice(-2000),
        stderr: result.stderr.trim().slice(-2000),
      })
    })
  }

  private async safeCreateActivity(
    agentConfig: LinearBridgeAgentConfig,
    agentSessionId: string,
    type: 'thought' | 'response' | 'error',
    body: string,
    ephemeral = false,
  ): Promise<void> {
    try {
      await this.linearGraphql(agentConfig, `
        mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
          agentActivityCreate(input: $input) {
            success
          }
        }
      `, {
        input: {
          agentSessionId,
          content: {
            type,
            body,
          },
          ...(ephemeral ? { ephemeral: true } : {}),
        },
      })
    } catch (error) {
      this.deps.logger.warn('[linear-agent] failed to create activity', {
        slug: agentConfig.slug,
        agentSessionId,
        type,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async safeUpdateExternalUrl(
    agentConfig: LinearBridgeAgentConfig,
    agentSessionId: string,
    label: string,
    url: string,
  ): Promise<void> {
    try {
      await this.linearGraphql(agentConfig, `
        mutation AgentSessionUpdate($agentSessionId: String!, $input: AgentSessionUpdateInput!) {
          agentSessionUpdate(id: $agentSessionId, input: $input) {
            success
          }
        }
      `, {
        agentSessionId,
        input: {
          externalUrls: [{ label, url }],
        },
      })
    } catch (error) {
      this.deps.logger.warn('[linear-agent] failed to update external url', {
        slug: agentConfig.slug,
        agentSessionId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async linearGraphql(
    agentConfig: LinearBridgeAgentConfig,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<unknown> {
    const explicitApiToken = resolveSecret(agentConfig.apiToken, agentConfig.apiTokenEnv)
    let accessToken = explicitApiToken || await this.getStoredAccessToken(agentConfig) || resolveLinearApiTokenFallback(agentConfig)
    if (!accessToken) {
      throw new Error(`Missing Linear API token for bridge agent "${agentConfig.slug}"`)
    }

    const config = await this.readConfig()
    let response = await this.deps.fetchImpl(config.apiBaseUrl, {
      method: 'POST',
      headers: {
        Authorization: buildLinearAuthorizationHeader(accessToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    })

    if ((response.status === 401 || response.status === 403) && !explicitApiToken) {
      const refreshed = await this.refreshStoredAccessToken(agentConfig)
      if (refreshed) {
        accessToken = refreshed
        response = await this.deps.fetchImpl(config.apiBaseUrl, {
          method: 'POST',
          headers: {
            Authorization: buildLinearAuthorizationHeader(accessToken),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ query, variables }),
        })
      }
    }

    if (!response.ok) {
      throw new Error(`Linear GraphQL request failed with ${response.status}`)
    }

    const json = await response.json() as { errors?: Array<{ message?: string }>; data?: unknown }
    if (Array.isArray(json.errors) && json.errors.length > 0) {
      throw new Error(json.errors.map(error => error.message || 'Unknown Linear GraphQL error').join('; '))
    }
    return json.data
  }
}

function resolveCodexWorkspacePath(workspaceRootPath: string, configuredPath: string | undefined): string {
  if (!configuredPath || configuredPath === '.' || configuredPath === 'workspace_root') {
    return workspaceRootPath
  }
  return configuredPath
}

function buildCodexBridgePrompt(event: LinearBridgeNormalizedEvent, issue?: LinearIssueSnapshot | null): string {
  const header = [
    issue?.identifier ? `You are handling Linear issue ${issue.identifier}.` : (event.issueIdentifier ? `You are handling Linear issue ${event.issueIdentifier}.` : 'You are handling a Linear agent request.'),
    issue?.title ? `Title: ${issue.title}` : (event.issueTitle ? `Title: ${event.issueTitle}` : null),
    issue?.stateName ? `Current state: ${issue.stateName}` : null,
    issue?.url ? `Issue URL: ${issue.url}` : (event.issueUrl ? `Issue URL: ${event.issueUrl}` : null),
    '',
    'Rules:',
    '- Work only inside the provided workspace for this issue.',
    '- Treat the latest follow-up message as the primary instruction.',
    '- If the request is actionable, do the work directly instead of explaining the repository.',
    '- Do not analyze bridge/config files unless the user explicitly asked about them.',
    '- Prefer the smallest correct change.',
    '- If you changed files or external state, say exactly what changed.',
    '- If a real blocker exists, say exactly what blocked you and what is needed.',
    '- Keep the final answer concise and suitable for posting back to Linear.',
    '- Start the final answer with exactly one status line: STATUS: completed | STATUS: needs_input | STATUS: blocked | STATUS: info',
    '',
    'Issue body:',
    issue?.description || '(no issue description)',
    '',
    'Recent comments:',
    issue?.comments?.slice(-5).join('\n\n') || '(no recent comments)',
    '',
    event.action === 'prompted' ? 'Latest follow-up from Linear:' : 'Initial directive from Linear:',
    event.prompt,
  ].filter(Boolean)

  return header.join('\n')
}

function extractCodexFinalMessage(stdout: string): string {
  const text = stdout.trim()
  if (!text) return ''

  const tokenMarker = '\ntokens used'
  const beforeTokens = text.includes(tokenMarker)
    ? text.slice(0, text.lastIndexOf(tokenMarker)).trim()
    : text

  const lines = beforeTokens
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)

  const filtered = lines.filter(line => {
    if (line === 'codex') return false
    if (/^mcp(:|\s)/i.test(line)) return false
    if (/^\d[\d,]*$/.test(line)) return false
    if (/record_discrepancy|failed to open state db|migration \d+ was previously applied/i.test(line)) return false
    return true
  })

  return filtered.join('\n').trim()
}

interface LinearTokenResponse {
  access_token: string
  refresh_token?: string
  token_type?: string
  expires_in?: number
  scope?: string | string[]
}

function parseBridgeStatusTag(message: string): { statusTag: string; body: string } {
  const trimmed = message.trim()
  const match = trimmed.match(/^STATUS:\s*(completed|needs_input|blocked|info)\s*\n+/i)
  if (!match) return { statusTag: 'info', body: trimmed }
  return {
    statusTag: match[1]!.toLowerCase(),
    body: trimmed.slice(match[0].length).trim(),
  }
}

function extractLatestAssistantReply(session: LinearBridgeSessionLike | null, previousAssistantId?: string): string | null {
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

function getLatestAssistantId(session: LinearBridgeSessionLike | null): string | undefined {
  const messages = session?.messages ?? []
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role === 'assistant' && !message.isIntermediate) {
      return message.id
    }
  }
  return undefined
}
