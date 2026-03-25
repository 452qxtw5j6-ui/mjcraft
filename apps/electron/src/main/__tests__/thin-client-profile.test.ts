import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  applyThinClientProfileToEnv,
  getBundledThinClientProfilePath,
  getThinClientConnectionConfigPath,
  loadBundledThinClientProfile,
} from '../thin-client-profile'

const tempDirs: string[] = []

afterEach(async () => {
  delete process.env.CRAFT_THIN_CLIENT
  delete process.env.CRAFT_APP_NAME
  delete process.env.CRAFT_DEEPLINK_SCHEME
  delete process.env.CRAFT_SERVER_URL
  delete process.env.CRAFT_SERVER_TOKEN
  delete process.env.CRAFT_WORKSPACE_ID
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('thin client profile', () => {
  it('returns null when bundled profile is absent', () => {
    expect(loadBundledThinClientProfile('/nonexistent')).toBeNull()
  })

  it('loads bundled profile and creates a local connection template', async () => {
    const root = await mkdtemp(join(tmpdir(), 'thin-client-profile-'))
    tempDirs.push(root)

    const profilePath = getBundledThinClientProfilePath(root)
    await mkdir(join(root, 'app', 'resources', 'thin-client'), { recursive: true })
    await writeFile(profilePath, JSON.stringify({
      appName: 'Craft Agents Client',
      deeplinkScheme: 'craftagentsclient',
      defaultServerUrl: 'ws://127.0.0.1:9910',
      connectionConfigPath: '~/.craft-agent/thin-client-test.json',
    }, null, 2), 'utf-8')

    const applied = applyThinClientProfileToEnv(root, root)
    expect(applied).toBe(true)
    expect(process.env.CRAFT_THIN_CLIENT).toBe('1')
    expect(process.env.CRAFT_APP_NAME).toBe('Craft Agents Client')
    expect(process.env.CRAFT_DEEPLINK_SCHEME).toBe('craftagentsclient')
    expect(process.env.CRAFT_SERVER_URL).toBe('ws://127.0.0.1:9910')
    expect(process.env.CRAFT_SERVER_TOKEN).toBe('')

    const profile = loadBundledThinClientProfile(root)
    expect(profile).not.toBeNull()

    const configPath = getThinClientConnectionConfigPath(profile!, root)
    expect(configPath).not.toBeNull()
    const config = JSON.parse(await readFile(configPath!, 'utf-8')) as Record<string, string>
    expect(config.serverUrl).toBe('ws://127.0.0.1:9910')
    expect(config.serverToken).toBe('')
  })

  it('does not override explicit environment variables', async () => {
    const root = await mkdtemp(join(tmpdir(), 'thin-client-profile-env-'))
    tempDirs.push(root)

    const profilePath = getBundledThinClientProfilePath(root)
    await mkdir(join(root, 'app', 'resources', 'thin-client'), { recursive: true })
    await writeFile(profilePath, JSON.stringify({
      appName: 'Craft Agents Client',
      deeplinkScheme: 'craftagentsclient',
      defaultServerUrl: 'ws://127.0.0.1:9910',
      connectionConfigPath: '~/.craft-agent/thin-client-test.json',
    }, null, 2), 'utf-8')

    process.env.CRAFT_SERVER_URL = 'ws://127.0.0.1:9001'
    process.env.CRAFT_SERVER_TOKEN = 'secret'
    process.env.CRAFT_APP_NAME = 'Existing Name'

    applyThinClientProfileToEnv(root, root)

    expect(process.env.CRAFT_SERVER_URL).toBe('ws://127.0.0.1:9001')
    expect(process.env.CRAFT_SERVER_TOKEN).toBe('secret')
    expect(process.env.CRAFT_APP_NAME).toBe('Existing Name')
    expect(process.env.CRAFT_DEEPLINK_SCHEME).toBe('craftagentsclient')
  })
})
