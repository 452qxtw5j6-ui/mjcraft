import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  buildCodexResumeArgs,
  buildCraftExternalUrl,
  LinearAgentBridgeService,
  buildLinearInstallUrl,
  normalizeLinearAgentEvent,
  resolveLinearSessionLabels,
} from '../linear-agent-bridge'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('linear-agent bridge helpers', () => {
  it('normalizes created events with structured prompt context', () => {
    const event = normalizeLinearAgentEvent({
      action: 'created',
      type: 'AgentSessionEvent',
      webhookTimestamp: 1_763_000_000_000,
      data: {
        agentSession: {
          id: 'as-1',
          promptContext: {
            issue: {
              identifier: 'ENG-42',
              title: 'Bridge mentions into external agents',
              url: 'https://linear.app/acme/issue/ENG-42/example',
            },
          },
          issue: {
            identifier: 'ENG-42',
            title: 'Bridge mentions into external agents',
            url: 'https://linear.app/acme/issue/ENG-42/example',
          },
          agent: {
            id: 'agent-1',
          },
        },
      },
    })

    expect(event).not.toBeNull()
    expect(event?.agentSessionId).toBe('as-1')
    expect(event?.linearAgentId).toBe('agent-1')
    expect(event?.issueId).toBeUndefined()
    expect(event?.issueIdentifier).toBe('ENG-42')
    expect(event?.promptContext).toContain('"identifier":"ENG-42"')
    expect(event?.prompt).toBe(event?.promptContext)
  })

  it('normalizes top-level agentSession payloads from Linear webhooks', () => {
    const event = normalizeLinearAgentEvent({
      type: 'AgentSessionEvent',
      action: 'created',
      createdAt: '2026-03-16T11:45:40.700Z',
      appUserId: 'app-user-1',
      agentSession: {
        id: 'session-1',
        comment: {
          body: '@codexsymphonyagent hi',
        },
        issue: {
          id: 'issue-1',
          identifier: 'MJA-47',
          title: 'test issue',
          url: 'https://linear.app/mjay1108/issue/MJA-47/test-issue',
        },
      },
      promptContext: '<issue identifier="MJA-47"></issue>',
      webhookTimestamp: 1773661540758,
    })

    expect(event).not.toBeNull()
    expect(event?.agentSessionId).toBe('session-1')
    expect(event?.linearAgentId).toBe('app-user-1')
    expect(event?.issueId).toBe('issue-1')
    expect(event?.issueIdentifier).toBe('MJA-47')
    expect(event?.prompt).toBe('@codexsymphonyagent hi')
  })

  it('ignores Linear placeholder comments on created events', () => {
    const event = normalizeLinearAgentEvent({
      type: 'AgentSessionEvent',
      action: 'created',
      agentSession: {
        id: 'session-2',
        comment: {
          body: 'This thread is for an agent session with codexsymphonyagent.',
        },
        issue: {
          id: 'issue-2',
          identifier: 'MJA-50',
          title: 'test44',
          url: 'https://linear.app/mjay1108/issue/MJA-50/test44',
        },
      },
      promptContext: '<issue identifier="MJA-50"><description>Fetch latest news</description></issue>',
      webhookTimestamp: 1773661540758,
    })

    expect(event).not.toBeNull()
    expect(event?.prompt).toBe('<issue identifier="MJA-50"><description>Fetch latest news</description></issue>')
  })

  it('normalizes prompted events using agent activity body', () => {
    const event = normalizeLinearAgentEvent({
      action: 'prompted',
      type: 'AgentSessionEvent',
      webhookTimestamp: '2026-03-16T10:00:00.000Z',
      data: {
        agentSession: {
          id: 'as-2',
          comment: {
            body: '@codexsymphonyagent old text',
          },
          agent: {
            id: 'agent-2',
          },
        },
        agentActivity: {
          content: {
            body: '[https://linear.app/foo](<https://linear.app/foo>) Please continue and prepare the PR',
          },
        },
      },
    })

    expect(event).not.toBeNull()
    expect(event?.action).toBe('prompted')
    expect(event?.prompt).toBe('Please continue and prepare the PR')
    expect(event?.webhookTimestamp).toBe(Date.parse('2026-03-16T10:00:00.000Z'))
  })

  it('builds Craft deep links by default', () => {
    expect(buildCraftExternalUrl('ws-1', 'sess-1')).toBe(
      'craftagents://workspace/ws-1/allSessions/session/sess-1?window=focused',
    )
  })

  it('renders custom Craft url templates', () => {
    expect(
      buildCraftExternalUrl('ws alpha', 'sess beta', 'https://bridge.local/open/{workspaceId}/{sessionId}'),
    ).toBe('https://bridge.local/open/ws alpha/sess beta')
  })

  it('builds Codex resume args with an explicit session id', () => {
    expect(buildCodexResumeArgs({
      kind: 'codex',
      sessionId: '019cef59-eefb-7002-9e2a-3ffb94f1918d',
      fullAuto: true,
      model: 'gpt-5.4',
      profile: 'default',
    })).toEqual([
      'exec',
      'resume',
      '--full-auto',
      '--json',
      '-c',
      'model_reasoning_effort="medium"',
      '--profile',
      'default',
      '--model',
      'gpt-5.4',
      '--skip-git-repo-check',
      '019cef59-eefb-7002-9e2a-3ffb94f1918d',
    ])
  })

  it('supports resuming the last Codex session when configured', () => {
    expect(buildCodexResumeArgs({
      kind: 'codex',
      useLastSession: true,
    })).toEqual([
      'exec',
      'resume',
      '--json',
      '-c',
      'model_reasoning_effort="medium"',
      '--skip-git-repo-check',
      '--last',
    ])
  })

  it('builds a Linear install url for app actor oauth', () => {
    expect(buildLinearInstallUrl({
      clientId: 'client-1',
      redirectUri: 'https://bridge.example.com/linear/callback',
      scopes: ['read', 'write', 'app:mentionable'],
      actor: 'app',
      prompt: 'consent',
      state: 'state-1',
    })).toBe(
      'https://linear.app/oauth/authorize?client_id=client-1&redirect_uri=https%3A%2F%2Fbridge.example.com%2Flinear%2Fcallback&response_type=code&scope=read%2Cwrite%2Capp%3Amentionable&actor=app&prompt=consent&state=state-1',
    )
  })

  it('adds an existing dedicated linear label for Linear-created sessions', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'linear-agent-labels-'))
    tempDirs.push(workspaceRoot)

    await mkdir(join(workspaceRoot, 'labels'), { recursive: true })
    await writeFile(join(workspaceRoot, 'labels', 'config.json'), JSON.stringify({
      version: 1,
      labels: [
        { id: 'linear', name: 'Linear', color: 'accent' },
        { id: 'bug', name: 'Bug', color: 'destructive' },
        { id: 'project', name: 'Project', color: 'foreground/50', valueType: 'string' },
      ],
    }, null, 2), 'utf-8')

    const labels = resolveLinearSessionLabels(workspaceRoot, ['project::ENG', 'linear', 'bug'])

    expect(labels).toEqual(['linear', 'project::ENG', 'bug'])
  })

  it('overwrites stale bridge config with a minimal Codex config', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'linear-agent-bridge-'))
    tempDirs.push(workspaceRoot)

    const serviceDir = join(workspaceRoot, '.linear-agent')
    const bridgeHome = join(serviceDir, 'codex-home')
    await mkdir(bridgeHome, { recursive: true })
    await writeFile(join(bridgeHome, 'config.toml'), [
      'model = "gpt-5.4"',
      '',
      '[mcp_servers.craft]',
      'transport = "streamable_http"',
      'url = "https://mcp.craft.do/links/test/mcp"',
      '',
    ].join('\n'), 'utf-8')

    const previousHome = process.env.CRAFT_LINEAR_AGENT_HOME
    process.env.CRAFT_LINEAR_AGENT_HOME = serviceDir

    const service = new LinearAgentBridgeService({
      workspaceId: 'ws-test',
      workspaceRootPath: workspaceRoot,
      sessionManager: {
        async createSession() {
          return { id: 'session-1' }
        },
        async getSession() {
          return null
        },
        async sendMessage() {},
      },
    })

    const resolvedBridgeHome = await (service as any).ensureBridgeCodexHome()
    expect(resolvedBridgeHome).toBe(bridgeHome)

    const configToml = await readFile(join(bridgeHome, 'config.toml'), 'utf-8')
    expect(configToml).toBe([
      'model = "gpt-5.4"',
      'model_reasoning_effort = "medium"',
      '[features]',
      'multi_agent = false',
      'parallel = false',
      '',
    ].join('\n'))
    expect(configToml).not.toContain('[mcp_servers.craft]')
    expect(configToml).not.toContain('streamable_http')

    if (previousHome === undefined) {
      delete process.env.CRAFT_LINEAR_AGENT_HOME
    } else {
      process.env.CRAFT_LINEAR_AGENT_HOME = previousHome
    }
  })

  it('migrates and repairs legacy session-map workspace paths into the new runtime home', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'linear-agent-legacy-root-'))
    const runtimeHome = await mkdtemp(join(tmpdir(), 'linear-agent-runtime-home-'))
    tempDirs.push(workspaceRoot, runtimeHome)

    const legacyDir = join(workspaceRoot, '.linear-agent')
    const legacyWorkspaces = join(legacyDir, 'workspaces')
    await mkdir(legacyWorkspaces, { recursive: true })
    await writeFile(join(legacyDir, 'session-map.json'), JSON.stringify({
      version: 1,
      mappings: {
        'codex:agent-1': {
          agentSlug: 'codex',
          targetKind: 'codex',
          codexThreadId: 'thread-1',
          workspacePath: join(legacyWorkspaces, 'MJA-60'),
          lastPromptAt: 1,
          updatedAt: 1,
        },
      },
    }, null, 2), 'utf-8')

    const previousHome = process.env.CRAFT_LINEAR_AGENT_HOME
    const previousAppRoot = process.env.CRAFT_APP_ROOT
    process.env.CRAFT_LINEAR_AGENT_HOME = runtimeHome
    process.env.CRAFT_APP_ROOT = workspaceRoot

    const service = new LinearAgentBridgeService({
      workspaceId: 'ws-test',
      workspaceRootPath: workspaceRoot,
      sessionManager: {
        async createSession() {
          return { id: 'session-1' }
        },
        async getSession() {
          return null
        },
        async sendMessage() {},
      },
    })

    await (service as any).ensureStorageFiles()

    const migratedSessionMap = JSON.parse(await readFile(join(runtimeHome, 'session-map.json'), 'utf-8'))
    expect(migratedSessionMap.mappings['codex:agent-1'].workspacePath).toBe(join(runtimeHome, 'workspaces', 'MJA-60'))

    if (previousHome === undefined) {
      delete process.env.CRAFT_LINEAR_AGENT_HOME
    } else {
      process.env.CRAFT_LINEAR_AGENT_HOME = previousHome
    }
    if (previousAppRoot === undefined) {
      delete process.env.CRAFT_APP_ROOT
    } else {
      process.env.CRAFT_APP_ROOT = previousAppRoot
    }
  })

  it('uses the shared config dir for the bridge runtime when no explicit override is set', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'linear-agent-config-root-'))
    const configDir = await mkdtemp(join(tmpdir(), 'linear-agent-config-dir-'))
    tempDirs.push(workspaceRoot, configDir)

    const previousHome = process.env.CRAFT_LINEAR_AGENT_HOME
    const previousConfigDir = process.env.CRAFT_CONFIG_DIR
    delete process.env.CRAFT_LINEAR_AGENT_HOME
    process.env.CRAFT_CONFIG_DIR = configDir

    const service = new LinearAgentBridgeService({
      workspaceId: 'ws-test',
      workspaceRootPath: workspaceRoot,
      sessionManager: {
        async createSession() {
          return { id: 'session-1' }
        },
        async getSession() {
          return null
        },
        async sendMessage() {},
      },
    })

    await (service as any).ensureStorageFiles()

    expect(await readFile(join(configDir, 'linear-agent', 'config.json'), 'utf-8')).toContain('"enabled": false')
    expect(await readFile(join(configDir, 'linear-agent', 'session-map.json'), 'utf-8')).toContain('"version": 1')

    if (previousHome === undefined) {
      delete process.env.CRAFT_LINEAR_AGENT_HOME
    } else {
      process.env.CRAFT_LINEAR_AGENT_HOME = previousHome
    }
    if (previousConfigDir === undefined) {
      delete process.env.CRAFT_CONFIG_DIR
    } else {
      process.env.CRAFT_CONFIG_DIR = previousConfigDir
    }
  })

  it('applies explicit Craft bridge model and thinking defaults when creating sessions', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'linear-agent-default-config-'))
    tempDirs.push(workspaceRoot)

    const createCalls: Array<Record<string, unknown> | undefined> = []
    const thinkingCalls: Array<{ sessionId: string; level: string }> = []
    let sentMessage = false
    const service = new LinearAgentBridgeService({
      workspaceId: 'ws-test',
      workspaceRootPath: workspaceRoot,
      sessionManager: {
        async createSession(_workspaceId, options) {
          createCalls.push(options as Record<string, unknown> | undefined)
          return { id: 'session-1' }
        },
        async getSession() {
          if (!sentMessage) return null
          return {
            id: 'session-1',
            messages: [
              {
                id: 'assistant-1',
                role: 'assistant',
                content: 'Final bridge reply',
                isIntermediate: false,
              },
            ],
          }
        },
        async sendMessage() {
          sentMessage = true
        },
        setSessionThinkingLevel(sessionId, level) {
          thinkingCalls.push({ sessionId, level })
        },
      },
    })

    ;(service as any).appendEvent = async () => {}
    ;(service as any).safeUpdateExternalUrl = async () => {}
    ;(service as any).safeCreateActivity = async () => {}
    ;(service as any).updateSessionMap = async () => {}
    ;(service as any).fetchIssueSnapshot = async () => null
    ;(service as any).readConfig = async () => ({
      publicBaseUrl: '',
    })

    await (service as any).handleCraftTarget({
      slug: 'craft',
      enabled: true,
      webhookPath: '/craft',
      target: {
        kind: 'craft',
        namePrefix: 'Linear',
        permissionMode: 'allow-all',
        model: 'claude-opus-4-6',
        thinkingLevel: 'medium',
        workingDirectory: 'user_default',
      },
    }, {
      action: 'created',
      eventType: 'AgentSessionEvent',
      agentSessionId: 'agent-session-1',
      prompt: 'Investigate the issue',
      issueIdentifier: 'MJA-100',
      webhookTimestamp: Date.now(),
    })

    expect(createCalls).toHaveLength(1)
    expect(createCalls[0]?.model).toBe('claude-opus-4-6')
    expect(thinkingCalls).toEqual([{ sessionId: 'session-1', level: 'medium' }])
  })

  it('posts only an issue comment for successful Craft responses', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'linear-agent-craft-publish-'))
    tempDirs.push(workspaceRoot)

    let sentMessage = false
    let activityCalls = 0
    let issueComments = 0
    const service = new LinearAgentBridgeService({
      workspaceId: 'ws-test',
      workspaceRootPath: workspaceRoot,
      sessionManager: {
        async createSession() {
          return { id: 'session-1' }
        },
        async getSession() {
          if (!sentMessage) return null
          return {
            id: 'session-1',
            messages: [
              {
                id: 'assistant-1',
                role: 'assistant',
                content: 'Final bridge reply',
                isIntermediate: false,
              },
            ],
          }
        },
        async sendMessage() {
          sentMessage = true
        },
      },
    })

    ;(service as any).appendEvent = async () => {}
    ;(service as any).safeUpdateExternalUrl = async () => {}
    ;(service as any).updateSessionMap = async () => {}
    ;(service as any).fetchIssueSnapshot = async () => ({
      id: 'issue-1',
      identifier: 'MJA-101',
      stateName: 'Todo',
      comments: [],
      teamStates: [],
    })
    ;(service as any).readConfig = async () => ({
      publicBaseUrl: '',
    })
    ;(service as any).safeCreateActivity = async () => {
      activityCalls += 1
    }
    ;(service as any).createIssueComment = async () => {
      issueComments += 1
    }

    await (service as any).handleCraftTarget({
      slug: 'craft',
      enabled: true,
      webhookPath: '/craft',
      target: {
        kind: 'craft',
        namePrefix: 'Linear',
        permissionMode: 'allow-all',
        model: 'claude-opus-4-6',
        thinkingLevel: 'medium',
        workingDirectory: 'user_default',
      },
    }, {
      action: 'created',
      eventType: 'AgentSessionEvent',
      agentSessionId: 'agent-session-2',
      prompt: 'Investigate the issue',
      issueId: 'issue-1',
      issueIdentifier: 'MJA-101',
      webhookTimestamp: Date.now(),
    })

    expect(activityCalls).toBe(0)
    expect(issueComments).toBe(1)
  })

  it('posts only an issue comment for successful Codex responses', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'linear-agent-codex-publish-'))
    tempDirs.push(workspaceRoot)

    let activityCalls = 0
    let issueComments = 0
    const service = new LinearAgentBridgeService({
      workspaceId: 'ws-test',
      workspaceRootPath: workspaceRoot,
      sessionManager: {
        async createSession() {
          return { id: 'session-1' }
        },
        async getSession() {
          return null
        },
        async sendMessage() {},
      },
    })

    ;(service as any).appendEvent = async () => {}
    ;(service as any).writeRunRecord = async () => {}
    ;(service as any).updateSessionMap = async () => {}
    ;(service as any).safeUpdateExternalUrl = async () => {}
    ;(service as any).materializeIssueWorkspace = async () => {}
    ;(service as any).buildBridgeCodexEnv = async () => ({ CODEX_HOME: '/tmp/codex-home' })
    ;(service as any).fetchIssueSnapshot = async () => ({
      id: 'issue-1',
      identifier: 'MJA-202',
      stateName: 'Todo',
      comments: [],
      teamStates: [],
    })
    ;(service as any).safeCreateActivity = async () => {
      activityCalls += 1
    }
    ;(service as any).createIssueComment = async () => {
      issueComments += 1
    }
    ;(service as any).deps.spawnProcess = (() => {
      throw new Error('spawnProcess should not be called directly in this test')
    }) as any

    const originalCreateActivity = (service as any).safeCreateActivity
    const originalCreateIssueComment = (service as any).createIssueComment

    await (service as any).withIssueLock('issue-1', async (fn: any) => fn)

    const result = {
      exitCode: 0,
      stdout: [
        JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'STATUS: completed\n\nFinal Codex reply' } }),
        JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } }),
      ].join('\n'),
      stderr: '',
    }

    ;(service as any).deps.spawnProcess = undefined

    const module = await import('../linear-agent-bridge')
    const runCommandSpy = async () => result
    ;(service as any).safeCreateActivity = originalCreateActivity
    ;(service as any).createIssueComment = originalCreateIssueComment

    const originalHandleCodexTarget = (service as any).handleCodexTarget.bind(service)
    ;(service as any).handleCodexTarget = async function (_config: any, agentConfig: any, event: any) {
      const originalRunCommand = (module as any).runCommand
      ;(module as any).runCommand = runCommandSpy
      try {
        return await originalHandleCodexTarget(_config, agentConfig, event)
      } finally {
        ;(module as any).runCommand = originalRunCommand
      }
    }

    await (service as any).handleCodexTarget({
      codexBin: 'codex',
    }, {
      slug: 'codex',
      enabled: true,
      webhookPath: '/codex',
      target: {
        kind: 'codex',
        workspacePath: '.',
        model: 'gpt-5.4',
        codexConfig: { reasoningEffort: 'medium' },
        results: {
          addAgentResponse: true,
          addIssueComment: true,
          moveToReviewOnCompleted: false,
          moveToDoneOnCompletedIfNoReview: false,
          appendArtifactLinksSection: false,
          addLabels: [],
          createFollowupIssueOnBlocked: false,
        },
      },
    }, {
      action: 'created',
      eventType: 'AgentSessionEvent',
      agentSessionId: 'agent-session-codex-1',
      prompt: 'Investigate the issue',
      issueId: 'issue-1',
      issueIdentifier: 'MJA-202',
      webhookTimestamp: Date.now(),
    })

    expect(activityCalls).toBe(0)
    expect(issueComments).toBe(1)
  })
})
