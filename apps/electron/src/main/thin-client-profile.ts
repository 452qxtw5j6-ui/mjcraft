import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'

const DEFAULT_SERVER_URL = 'ws://127.0.0.1:9100'

export interface BundledThinClientProfile {
  appName?: string
  deeplinkScheme?: string
  defaultServerUrl?: string
  connectionConfigPath?: string
}

export interface ThinClientConnectionConfig {
  serverUrl?: string
  serverToken?: string
  workspaceId?: string
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function expandHomePath(filePath: string, homeDir = homedir()): string {
  if (filePath === '~') return homeDir
  if (filePath.startsWith('~/')) return join(homeDir, filePath.slice(2))
  return filePath
}

function parseJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function sanitizeProfile(data: Record<string, unknown>): BundledThinClientProfile {
  return {
    appName: isNonEmptyString(data.appName) ? data.appName.trim() : undefined,
    deeplinkScheme: isNonEmptyString(data.deeplinkScheme) ? data.deeplinkScheme.trim() : undefined,
    defaultServerUrl: isNonEmptyString(data.defaultServerUrl) ? data.defaultServerUrl.trim() : undefined,
    connectionConfigPath: isNonEmptyString(data.connectionConfigPath) ? data.connectionConfigPath.trim() : undefined,
  }
}

function sanitizeConnectionConfig(data: Record<string, unknown>): ThinClientConnectionConfig {
  return {
    serverUrl: isNonEmptyString(data.serverUrl) ? data.serverUrl.trim() : undefined,
    serverToken: typeof data.serverToken === 'string' ? data.serverToken : undefined,
    workspaceId: isNonEmptyString(data.workspaceId) ? data.workspaceId.trim() : undefined,
  }
}

export function getBundledThinClientProfilePath(resourcesPath = process.resourcesPath): string {
  return join(resourcesPath, 'app', 'resources', 'thin-client', 'profile.json')
}

export function loadBundledThinClientProfile(resourcesPath = process.resourcesPath): BundledThinClientProfile | null {
  const filePath = getBundledThinClientProfilePath(resourcesPath)
  if (!existsSync(filePath)) return null

  const parsed = parseJsonFile(filePath)
  if (!parsed) return null
  return sanitizeProfile(parsed)
}

export function getThinClientConnectionConfigPath(
  profile: BundledThinClientProfile,
  homeDir = homedir(),
): string | null {
  if (!profile.connectionConfigPath) return null
  return expandHomePath(profile.connectionConfigPath, homeDir)
}

export function loadThinClientConnectionConfig(
  profile: BundledThinClientProfile,
  homeDir = homedir(),
): ThinClientConnectionConfig | null {
  const filePath = getThinClientConnectionConfigPath(profile, homeDir)
  if (!filePath) return null

  if (!existsSync(filePath)) {
    mkdirSync(dirname(filePath), { recursive: true })
    const initialConfig: ThinClientConnectionConfig = {
      serverUrl: profile.defaultServerUrl || DEFAULT_SERVER_URL,
      serverToken: '',
      workspaceId: '',
    }
    writeFileSync(filePath, `${JSON.stringify(initialConfig, null, 2)}\n`, 'utf-8')
    return initialConfig
  }

  const parsed = parseJsonFile(filePath)
  if (!parsed) {
    return {
      serverUrl: profile.defaultServerUrl || DEFAULT_SERVER_URL,
      serverToken: '',
      workspaceId: '',
    }
  }

  return sanitizeConnectionConfig(parsed)
}

export function applyThinClientProfileToEnv(
  resourcesPath = process.resourcesPath,
  homeDir = homedir(),
): boolean {
  const profile = loadBundledThinClientProfile(resourcesPath)
  if (!profile) return false

  process.env.CRAFT_THIN_CLIENT = '1'

  if (!process.env.CRAFT_APP_NAME && profile.appName) {
    process.env.CRAFT_APP_NAME = profile.appName
  }
  if (!process.env.CRAFT_DEEPLINK_SCHEME && profile.deeplinkScheme) {
    process.env.CRAFT_DEEPLINK_SCHEME = profile.deeplinkScheme
  }

  const connection = loadThinClientConnectionConfig(profile, homeDir)
  const defaultServerUrl = profile.defaultServerUrl || DEFAULT_SERVER_URL

  if (!process.env.CRAFT_SERVER_URL) {
    process.env.CRAFT_SERVER_URL = connection?.serverUrl || defaultServerUrl
  }
  if (process.env.CRAFT_SERVER_TOKEN === undefined) {
    process.env.CRAFT_SERVER_TOKEN = connection?.serverToken ?? ''
  }
  if (!process.env.CRAFT_WORKSPACE_ID && connection?.workspaceId) {
    process.env.CRAFT_WORKSPACE_ID = connection.workspaceId
  }

  return true
}

export function isThinClientMode(): boolean {
  return process.env.CRAFT_THIN_CLIENT === '1'
}
