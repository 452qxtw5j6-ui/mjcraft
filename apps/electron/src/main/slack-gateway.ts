import { getCredentialManager } from '@craft-agent/shared/credentials'
import {
  TokenRefreshManager,
  getSourceCredentialManager,
  loadWorkspaceSources,
  type LoadedSource,
} from '@craft-agent/shared/sources'
import log from './logger'

const slackGatewayLog = log.scope('slack-gateway')
const SLACK_BOT_TOKEN_SOURCE_ID = 'slack-bot-bot-token'

export interface SlackGatewayClientLike {
  chat: {
    postMessage(args: {
      channel: string
      text: string
      thread_ts?: string
    }): Promise<{ ok?: boolean; ts?: string; error?: string }>
    update(args: {
      channel: string
      ts: string
      text: string
    }): Promise<{ ok?: boolean; error?: string }>
    getPermalink?(args: {
      channel: string
      message_ts: string
    }): Promise<{ ok?: boolean; permalink?: string; error?: string }>
  }
}

interface SlackGatewayDependencies {
  fetchImpl: typeof fetch
  loadSources: typeof loadWorkspaceSources
  sourceCredentialManager: ReturnType<typeof getSourceCredentialManager>
  rawCredentialManager: ReturnType<typeof getCredentialManager>
  logger: {
    info: (...args: unknown[]) => void
    warn: (...args: unknown[]) => void
    error: (...args: unknown[]) => void
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function extractBearerToken(value: string): string {
  const trimmed = value.trim()
  return trimmed.toLowerCase().startsWith('bearer ')
    ? trimmed.slice('bearer '.length).trim()
    : trimmed
}

function getAuthorizationFromCredential(credential: unknown): string | null {
  if (typeof credential === 'string' && credential.trim()) {
    return extractBearerToken(credential)
  }
  if (credential && typeof credential === 'object') {
    const auth = (credential as Record<string, unknown>).Authorization
      ?? (credential as Record<string, unknown>).authorization
    if (typeof auth === 'string' && auth.trim()) {
      return extractBearerToken(auth)
    }
  }
  return null
}

export class SlackGateway {
  private readonly workspaceId: string
  private readonly workspaceRootPath: string
  private readonly sourceSlug: string
  private readonly deps: SlackGatewayDependencies
  private readonly tokenRefreshManager: TokenRefreshManager

  constructor(options: {
    workspaceId: string
    workspaceRootPath: string
    sourceSlug?: string
    deps?: Partial<SlackGatewayDependencies>
  }) {
    this.workspaceId = options.workspaceId
    this.workspaceRootPath = options.workspaceRootPath
    this.sourceSlug = options.sourceSlug ?? 'slack'

    const sourceCredentialManager = options.deps?.sourceCredentialManager ?? getSourceCredentialManager()
    this.deps = {
      fetchImpl: options.deps?.fetchImpl ?? fetch,
      loadSources: options.deps?.loadSources ?? loadWorkspaceSources,
      sourceCredentialManager,
      rawCredentialManager: options.deps?.rawCredentialManager ?? getCredentialManager(),
      logger: options.deps?.logger ?? slackGatewayLog,
    }
    this.tokenRefreshManager = new TokenRefreshManager(sourceCredentialManager, {
      log: (message) => this.deps.logger.info(message),
    })
  }

  async postMessage(
    args: { channel: string; text: string; threadTs?: string },
    client?: SlackGatewayClientLike,
  ): Promise<{ ts: string }> {
    if (client) {
      const response = await client.chat.postMessage({
        channel: args.channel,
        text: args.text,
        thread_ts: args.threadTs,
      })
      if (!response.ts) {
        throw new Error(`Slack chat.postMessage failed: ${response.error ?? 'missing ts'}`)
      }
      return { ts: response.ts }
    }

    const response = await this.requestSlack<{ ok?: boolean; ts?: string; error?: string }>('chat.postMessage', {
      channel: args.channel,
      text: args.text,
      ...(args.threadTs ? { thread_ts: args.threadTs } : {}),
    })
    if (!response.ok || !response.ts) {
      throw new Error(`Slack chat.postMessage failed: ${response.error ?? 'missing ts'}`)
    }
    return { ts: response.ts }
  }

  async updateMessage(
    args: { channel: string; ts: string; text: string },
    client?: SlackGatewayClientLike,
  ): Promise<void> {
    if (client) {
      const response = await client.chat.update({
        channel: args.channel,
        ts: args.ts,
        text: args.text,
      })
      if (response && typeof response === 'object' && 'ok' in response && response.ok === false) {
        throw new Error(`Slack chat.update failed: ${String((response as { error?: string }).error ?? 'unknown')}`)
      }
      return
    }

    const response = await this.requestSlack<{ ok?: boolean; error?: string }>('chat.update', {
      channel: args.channel,
      ts: args.ts,
      text: args.text,
    })
    if (!response.ok) {
      throw new Error(`Slack chat.update failed: ${response.error ?? 'unknown'}`)
    }
  }

  async getPermalink(
    args: { channel: string; messageTs: string },
    client?: SlackGatewayClientLike,
  ): Promise<string> {
    if (client?.chat.getPermalink) {
      const response = await client.chat.getPermalink({
        channel: args.channel,
        message_ts: args.messageTs,
      })
      if (!response.ok || !response.permalink) {
        throw new Error(`Slack chat.getPermalink failed: ${response.error ?? 'missing permalink'}`)
      }
      return response.permalink
    }

    const response = await this.requestSlack<{ ok?: boolean; permalink?: string; error?: string }>('chat.getPermalink', {
      channel: args.channel,
      message_ts: args.messageTs,
    })
    if (!response.ok || !response.permalink) {
      throw new Error(`Slack chat.getPermalink failed: ${response.error ?? 'missing permalink'}`)
    }
    return response.permalink
  }

  private findSlackSource(): LoadedSource | null {
    const sources = this.deps.loadSources(this.workspaceRootPath)
    return sources.find(source => source.config.slug === this.sourceSlug && source.config.type === 'api') ?? null
  }

  private async getBotToken(): Promise<string> {
    const slackSource = this.findSlackSource()
    if (slackSource) {
      const refreshed = await this.tokenRefreshManager.ensureFreshToken(slackSource)
      if (refreshed.success && refreshed.token) {
        return extractBearerToken(refreshed.token)
      }

      const apiCredential = await this.deps.sourceCredentialManager.getApiCredential(slackSource)
      const fromCredential = getAuthorizationFromCredential(apiCredential)
      if (fromCredential) return fromCredential
    }

    const fallback = await this.deps.rawCredentialManager.get({
      type: 'source_apikey',
      workspaceId: this.workspaceId,
      sourceId: SLACK_BOT_TOKEN_SOURCE_ID,
    })
    if (fallback?.value) return fallback.value

    if (slackSource) {
      const apiCredential = await this.deps.sourceCredentialManager.getApiCredential(slackSource)
      const fromCredential = getAuthorizationFromCredential(apiCredential)
      if (fromCredential) return fromCredential
    }

    throw new Error('Slack bot token is missing')
  }

  private async requestSlack<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const token = await this.getBotToken()
    const url = `https://slack.com/api/${method}`

    let lastError: Error | null = null
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await this.deps.fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(body),
      })

      const rawText = await response.text()
      let payload: Record<string, unknown> = {}
      try {
        payload = rawText ? JSON.parse(rawText) as Record<string, unknown> : {}
      } catch {
        payload = {}
      }

      if (response.ok) return payload as T

      const retryAfter = Number(response.headers.get('retry-after') || '0')
      const error = new Error(`Slack ${method} HTTP ${response.status}: ${rawText}`)
      lastError = error

      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        await sleep(retryAfter > 0 ? retryAfter * 1000 : 500 * (attempt + 1))
        continue
      }
      break
    }

    throw lastError ?? new Error(`Slack ${method} failed`)
  }
}
