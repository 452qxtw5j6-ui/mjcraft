/**
 * Headless server startup logic.
 * Imported dynamically by index.ts after virtual module shims are registered.
 */

import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { startHeadlessServer } from '@craft-agent/server-core/bootstrap'
import { registerAllRpcHandlers } from '../main/handlers/index'
import { cleanupSessionFileWatchForClient } from '@craft-agent/server-core/handlers/rpc'
import { SessionManager, setSessionPlatform, setSessionRuntimeHooks } from '@craft-agent/server-core/sessions'
import { initModelRefreshService, setFetcherPlatform } from '@craft-agent/server-core/model-fetchers'
import { setSearchPlatform, setImageProcessor } from '@craft-agent/server-core/services'
import type { HandlerDeps } from '../main/handlers/handler-deps'
import type { WsRpcTlsOptions } from '@craft-agent/server-core/transport'
import { getWorkspaces, loadStoredConfig } from '@craft-agent/shared/config'
import { SlackBotService } from '../main/slack-bot'
import { NotionTaskService } from '../main/notion-task-service'

const bundledAssetsRoot = join(import.meta.dir, '..', '..')

let slackBotService: SlackBotService | null = null
let notionTaskService: NotionTaskService | null = null
let mutableDeps: HandlerDeps | null = null

let tls: WsRpcTlsOptions | undefined
const tlsCertPath = process.env.CRAFT_RPC_TLS_CERT
const tlsKeyPath = process.env.CRAFT_RPC_TLS_KEY
if (tlsCertPath || tlsKeyPath) {
  if (!tlsCertPath || !tlsKeyPath) {
    throw new Error('TLS requires both CRAFT_RPC_TLS_CERT and CRAFT_RPC_TLS_KEY.')
  }
  tls = {
    cert: readFileSync(tlsCertPath),
    key: readFileSync(tlsKeyPath),
    ...(process.env.CRAFT_RPC_TLS_CA ? { ca: readFileSync(process.env.CRAFT_RPC_TLS_CA) } : {}),
  }
}

const instance = await (async (): Promise<{ host: string; port: number; token: string; stop: () => Promise<void> }> => {
  try {
    return await startHeadlessServer<SessionManager, HandlerDeps>({
      bundledAssetsRoot,
      tls,
      applyPlatformToSubsystems: (platform) => {
        setFetcherPlatform(platform)
        setSessionPlatform(platform)
        setSessionRuntimeHooks({
          updateBadgeCount: () => {},
          captureException: (error) => {
            const err = error instanceof Error ? error : new Error(String(error))
            platform.captureError?.(err)
          },
        })
        setSearchPlatform(platform)
        setImageProcessor(platform.imageProcessor)
      },
      initModelRefreshService: () => initModelRefreshService(async (slug: string) => {
        const { getCredentialManager } = await import('@craft-agent/shared/credentials')
        const manager = getCredentialManager()
        const [apiKey, oauth] = await Promise.all([
          manager.getLlmApiKey(slug).catch(() => null),
          manager.getLlmOAuth(slug).catch(() => null),
        ])
        return {
          apiKey: apiKey ?? undefined,
          oauthAccessToken: oauth?.accessToken,
          oauthRefreshToken: oauth?.refreshToken,
          oauthIdToken: oauth?.idToken,
        }
      }),
      createSessionManager: () => new SessionManager(),
      createHandlerDeps: ({ sessionManager, platform, oauthFlowStore }) => {
        mutableDeps = {
          sessionManager,
          platform,
          // windowManager: undefined — headless, no GUI windows
          // browserPaneManager: undefined — headless, no browser automation
          oauthFlowStore,
          notionTaskService: null,
        }
        return mutableDeps
      },
      registerAllRpcHandlers,
      setSessionEventSink: (sessionManager, sink) => {
        sessionManager.setEventSink(sink)
      },
      initializeSessionManager: async (sessionManager) => {
        await sessionManager.initialize()
      },
      cleanupSessionManager: async (sessionManager) => {
        try {
          await sessionManager.flushAllSessions()
        } finally {
          sessionManager.cleanup()
        }
      },
      cleanupClientResources: cleanupSessionFileWatchForClient,
    })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
})()

const configuredWorkspaces = getWorkspaces()
const activeWorkspaceId = loadStoredConfig()?.activeWorkspaceId
const integrationWorkspace =
  (activeWorkspaceId && configuredWorkspaces.find(ws => ws.id === activeWorkspaceId))
  || configuredWorkspaces[0]

if (integrationWorkspace && mutableDeps) {
  try {
    slackBotService = new SlackBotService({
      workspaceId: integrationWorkspace.id,
      workspaceRootPath: integrationWorkspace.rootPath,
      sessionManager: mutableDeps.sessionManager,
    })
    await slackBotService.start()
  } catch (error) {
    console.error('Slack bot startup failed; continuing headless startup without Slack integration:', error instanceof Error ? error.message : String(error))
    if (slackBotService) {
      await slackBotService.stop().catch(() => {})
    }
    slackBotService = null
  }

  try {
    notionTaskService = new NotionTaskService({
      workspaceId: integrationWorkspace.id,
      workspaceRootPath: integrationWorkspace.rootPath,
      sessionManager: mutableDeps.sessionManager,
    })
    mutableDeps.notionTaskService = notionTaskService
    await notionTaskService.start()
  } catch (error) {
    console.error('Notion task service startup failed; continuing headless startup without Notion queue:', error instanceof Error ? error.message : String(error))
    if (notionTaskService) {
      await notionTaskService.stop().catch(() => {})
    }
    notionTaskService = null
    mutableDeps.notionTaskService = null
  }
} else {
  console.warn('Skipping Slack/Notion services startup: no workspace available')
}

console.log(`CRAFT_SERVER_URL=${tls ? 'wss' : 'ws'}://${instance.host}:${instance.port}`)
console.log(`CRAFT_SERVER_TOKEN=${instance.token}`)

const shutdown = async () => {
  if (slackBotService) {
    await slackBotService.stop().catch(() => {})
    slackBotService = null
  }
  if (notionTaskService) {
    await notionTaskService.stop().catch(() => {})
    notionTaskService = null
    if (mutableDeps) mutableDeps.notionTaskService = null
  }
  await instance.stop()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
