import { randomUUID } from 'node:crypto'
import type { SessionManager } from '@craft-agent/server-core/sessions'
import type {
  BrowserConsoleEntry,
  BrowserConsoleOptions,
  BrowserDownloadEntry,
  BrowserDownloadOptions,
  BrowserInstanceSnapshot,
  BrowserKeyArgs,
  BrowserNetworkEntry,
  BrowserNetworkOptions,
  BrowserScreenshotOptions,
  BrowserScreenshotRegionTarget,
  BrowserWaitArgs,
  BrowserWaitResult,
  IBrowserPaneManager,
} from '@craft-agent/server-core/handlers'
import type { BrowserPaneFns } from '@craft-agent/shared/agent/browser-tools'
import type {
  BrowserInstanceInfo,
  RemoteBrowserInvokeArgs,
  RemoteBrowserInvokeResult,
  RemoteBrowserSnapshot,
  RemoteBrowserWindowInfo,
} from '@craft-agent/shared/protocol'
import { CLIENT_BROWSER_HOST_INVOKE, requestClientBrowserHost } from '@craft-agent/server-core/transport'
import type { ConnectedClientInfo, WsRpcServer } from '@craft-agent/server-core/transport'
import log from '../main/logger'

const remoteBrowserLog = log.scope('remote-browser-pane')

interface RemoteBrowserInstanceRecord extends BrowserInstanceInfo {
  ownerClientId: string | null
}

function toBaseInfo(record: RemoteBrowserInstanceRecord): BrowserInstanceInfo {
  return {
    id: record.id,
    url: record.url,
    title: record.title,
    favicon: record.favicon,
    isLoading: record.isLoading,
    canGoBack: record.canGoBack,
    canGoForward: record.canGoForward,
    boundSessionId: record.boundSessionId,
    ownerType: record.ownerType,
    ownerSessionId: record.ownerSessionId,
    isVisible: record.isVisible,
    agentControlActive: record.agentControlActive,
    themeColor: record.themeColor,
  }
}

export class RemoteBrowserPaneAdapter implements IBrowserPaneManager {
  private readonly instances = new Map<string, RemoteBrowserInstanceRecord>()
  private readonly sessionToInstanceId = new Map<string, string>()
  private sessionPathResolver: ((sessionId: string) => string | null) | null = null

  constructor(
    private readonly transport: WsRpcServer,
    private readonly sessionManager: SessionManager,
  ) {}

  createSessionBrowserPaneFns(sessionId: string): BrowserPaneFns {
    return {
      openPanel: async (options) => {
        const record = await this.ensureRemoteWindow(sessionId, !options?.background)
        return { instanceId: record.id }
      },
      navigate: async (url) => {
        const result = await this.invokeForSession(sessionId, 'navigate', { url })
        const info = this.requireInfo(result, sessionId)
        return { url: info.url, title: info.title }
      },
      snapshot: async () => {
        const result = await this.invokeForSession(sessionId, 'snapshot', {})
        const snapshot = result.snapshot
        if (!snapshot) throw new Error('Snapshot result missing payload')
        this.applyResultInfo(sessionId, result)
        return snapshot
      },
      click: async (ref, options) => {
        await this.invokeForSession(sessionId, 'click', {
          ref,
          waitFor: options?.waitFor,
          timeoutMs: options?.timeoutMs,
        })
      },
      clickAt: async (x, y) => {
        await this.invokeForSession(sessionId, 'click_at', { x, y })
      },
      drag: async (x1, y1, x2, y2) => {
        await this.invokeForSession(sessionId, 'drag', { x1, y1, x2, y2 })
      },
      fill: async (ref, value) => {
        await this.invokeForSession(sessionId, 'fill', { ref, value })
      },
      type: async (text) => {
        await this.invokeForSession(sessionId, 'type', { text })
      },
      select: async (ref, value) => {
        await this.invokeForSession(sessionId, 'select', { ref, value })
      },
      setClipboard: async (text) => {
        await this.invokeForSession(sessionId, 'set_clipboard', { text })
      },
      getClipboard: async () => {
        const result = await this.invokeForSession(sessionId, 'get_clipboard', {})
        return result.clipboard ?? ''
      },
      screenshot: async (args) => {
        const result = await this.invokeForSession(sessionId, 'screenshot', {
          annotate: args?.annotate,
          format: args?.format,
          jpegQuality: args?.jpegQuality,
          includeLastAction: args?.includeLastAction,
          includeMetadata: args?.includeMetadata,
        })
        return {
          imageBuffer: Buffer.from(this.requireImageBuffer(result)),
          imageFormat: result.imageFormat ?? 'jpeg',
          metadata: result.metadata,
        }
      },
      screenshotRegion: async (args) => {
        const result = await this.invokeForSession(sessionId, 'screenshot_region', { target: args })
        return {
          imageBuffer: Buffer.from(this.requireImageBuffer(result)),
          imageFormat: result.imageFormat ?? 'jpeg',
          metadata: result.metadata,
        }
      },
      getConsoleLogs: async (args) => {
        const result = await this.invokeForSession(sessionId, 'console_logs', {
          level: args?.level,
          limit: args?.limit,
        })
        return result.consoleLogs ?? []
      },
      windowResize: async (args) => {
        const result = await this.invokeForSession(sessionId, 'window_resize', {
          width: args.width,
          height: args.height,
        })
        return result.resizeResult ?? { width: args.width, height: args.height }
      },
      getNetworkLogs: async (args) => {
        const result = await this.invokeForSession(sessionId, 'network_logs', {
          limit: args?.limit,
          status: args?.status,
          method: args?.method,
          resourceType: args?.resourceType,
        })
        return result.networkLogs ?? []
      },
      waitFor: async (args) => {
        const result = await this.invokeForSession(sessionId, 'wait_for', {
          kind: args.kind,
          value: args.value,
          timeoutMs: args.timeoutMs,
          pollMs: args.pollMs,
          idleMs: args.idleMs,
        })
        if (!result.waitResult) throw new Error('wait_for result missing payload')
        return result.waitResult
      },
      sendKey: async (args) => {
        await this.invokeForSession(sessionId, 'send_key', {
          key: args.key,
          modifiers: args.modifiers,
        })
      },
      getDownloads: async (args) => {
        const result = await this.invokeForSession(sessionId, 'downloads', {
          action: args?.action,
          limit: args?.limit,
          timeoutMs: args?.timeoutMs,
        })
        return result.downloads ?? []
      },
      upload: async (ref, filePaths) => {
        await this.invokeForSession(sessionId, 'upload', { ref, filePaths })
      },
      scroll: async (direction, amount) => {
        await this.invokeForSession(sessionId, 'scroll', { direction, amount })
      },
      goBack: async () => {
        await this.invokeForSession(sessionId, 'go_back', {})
      },
      goForward: async () => {
        await this.invokeForSession(sessionId, 'go_forward', {})
      },
      evaluate: async (expression) => {
        const result = await this.invokeForSession(sessionId, 'evaluate', { expression })
        return result.evaluateResult
      },
      focusWindow: async (requestedInstanceId) => {
        await this.refreshRelevantWindows(sessionId)
        const target = this.resolveWindowTarget(sessionId, requestedInstanceId, 'focus')
        const result = await this.invokeWindow(target.id, sessionId, 'focus_window', {})
        const info = this.requireInfo(result, sessionId)
        return {
          instanceId: target.id,
          title: info.title,
          url: info.url,
        }
      },
      releaseControl: async (requestedInstanceId) => {
        await this.refreshRelevantWindows(sessionId)
        if (requestedInstanceId === 'all') {
          const affectedIds = this.listInstances()
            .filter((instance) => instance.ownerSessionId === sessionId && instance.agentControlActive)
            .map((instance) => instance.id)
          this.clearAgentControl(sessionId)
          return {
            action: affectedIds.length > 0 ? 'released' : 'noop',
            requestedInstanceId,
            affectedIds,
            reason: affectedIds.length > 0 ? undefined : 'No active browser control was found for this session.',
          }
        }

        const target = this.resolveWindowTarget(sessionId, requestedInstanceId, 'release')
        const result = this.clearAgentControlForInstance(target.id, sessionId)
        return {
          action: result.released ? 'released' : 'noop',
          requestedInstanceId,
          resolvedInstanceId: target.id,
          affectedIds: result.released ? [target.id] : [],
          reason: result.reason,
        }
      },
      closeWindow: async (requestedInstanceId) => {
        await this.refreshRelevantWindows(sessionId)
        const target = this.resolveWindowTarget(sessionId, requestedInstanceId, 'close')
        await this.invokeWindow(target.id, sessionId, 'destroy_window', {})
        this.instances.delete(target.id)
        if (target.ownerSessionId) {
          this.sessionToInstanceId.delete(target.ownerSessionId)
        }
        return {
          action: 'closed',
          requestedInstanceId,
          resolvedInstanceId: target.id,
          affectedIds: [target.id],
        }
      },
      hideWindow: async (requestedInstanceId) => {
        await this.refreshRelevantWindows(sessionId)
        const target = this.resolveWindowTarget(sessionId, requestedInstanceId, 'hide')
        await this.invokeWindow(target.id, sessionId, 'hide_window', {})
        return {
          action: 'hidden',
          requestedInstanceId,
          resolvedInstanceId: target.id,
          affectedIds: [target.id],
        }
      },
      listWindows: async () => {
        await this.refreshRelevantWindows(sessionId)
        return this.listInstances()
      },
      detectChallenge: async () => {
        const result = await this.invokeForSession(sessionId, 'detect_challenge', {})
        return result.challenge ?? { detected: false, provider: 'none', signals: [] }
      },
    }
  }

  setSessionPathResolver(fn: (sessionId: string) => string | null): void {
    this.sessionPathResolver = fn
  }

  destroyForSession(sessionId: string): void {
    const instanceId = this.sessionToInstanceId.get(sessionId)
    if (!instanceId) return
    this.destroyInstance(instanceId)
    this.sessionToInstanceId.delete(sessionId)
  }

  async clearVisualsForSession(sessionId: string): Promise<void> {
    this.clearAgentControl(sessionId)
  }

  unbindAllForSession(_sessionId: string): void {
    // Remote dedicated Playwright windows stay bound to their session so release/hide
    // can preserve ownership and cookie state between turns.
  }

  getOrCreateForSession(sessionId: string): string {
    const record = this.ensureRecord(sessionId)
    void this.ensureRemoteWindow(sessionId, false).catch((error: unknown) => {
      remoteBrowserLog.warn(`[remote-browser] background ensure failed session=${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
    })
    return record.id
  }

  setAgentControl(sessionId: string, meta: { displayName?: string; intent?: string }): void {
    const instanceId = this.sessionToInstanceId.get(sessionId)
    if (!instanceId) return
    const record = this.instances.get(instanceId)
    if (!record) return
    record.agentControlActive = true
    record.title = record.title || meta.displayName || record.title
  }

  createForSession(sessionId: string, options?: { show?: boolean }): string {
    const record = this.ensureRecord(sessionId)
    if (options?.show) {
      record.isVisible = true
    }
    void this.ensureRemoteWindow(sessionId, options?.show ?? false).catch((error: unknown) => {
      remoteBrowserLog.warn(`[remote-browser] ensure window failed session=${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
    })
    return record.id
  }

  getInstance(id: string): BrowserInstanceSnapshot | undefined {
    const record = this.instances.get(id)
    if (!record) return undefined
    return {
      ownerType: record.ownerType,
      ownerSessionId: record.ownerSessionId,
      isVisible: record.isVisible,
      title: record.title,
      currentUrl: record.url,
    }
  }

  listInstances(): BrowserInstanceInfo[] {
    return Array.from(this.instances.values()).map((record) => toBaseInfo(record))
  }

  focusBoundForSession(sessionId: string): string {
    const record = this.ensureRecord(sessionId)
    record.isVisible = true
    void this.ensureRemoteWindow(sessionId, true).catch((error: unknown) => {
      remoteBrowserLog.warn(`[remote-browser] focus ensure failed session=${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
    })
    return record.id
  }

  bindSession(id: string, sessionId: string): void {
    const record = this.instances.get(id)
    if (!record) return
    record.boundSessionId = sessionId
    record.ownerType = 'session'
    record.ownerSessionId = sessionId
    this.sessionToInstanceId.set(sessionId, id)
  }

  focus(id: string): void {
    const record = this.instances.get(id)
    if (!record) return
    record.isVisible = true
    if (record.ownerSessionId) {
      void this.invokeWindow(id, record.ownerSessionId, 'focus_window', {}).catch((error: unknown) => {
        remoteBrowserLog.warn(`[remote-browser] focus failed id=${id}: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
  }

  destroyInstance(id: string): void {
    const record = this.instances.get(id)
    if (!record) return
    this.instances.delete(id)
    if (record.ownerSessionId) {
      this.sessionToInstanceId.delete(record.ownerSessionId)
    }
    if (record.ownerClientId && record.ownerSessionId) {
      void requestClientBrowserHost(this.transport, record.ownerClientId, {
        op: 'destroy_window',
        instanceId: id,
      }).catch((error: unknown) => {
        remoteBrowserLog.warn(`[remote-browser] destroy failed id=${id}: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
  }

  hide(id: string): void {
    const record = this.instances.get(id)
    if (!record) return
    record.isVisible = false
    if (record.ownerClientId && record.ownerSessionId) {
      void requestClientBrowserHost(this.transport, record.ownerClientId, {
        op: 'hide_window',
        instanceId: id,
      }).catch((error: unknown) => {
        remoteBrowserLog.warn(`[remote-browser] hide failed id=${id}: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
  }

  clearAgentControl(sessionId: string): void {
    const instanceId = this.sessionToInstanceId.get(sessionId)
    if (!instanceId) return
    const record = this.instances.get(instanceId)
    if (record) {
      record.agentControlActive = false
    }
  }

  clearAgentControlForInstance(instanceId: string, sessionId?: string): { released: boolean; reason?: string } {
    const record = this.instances.get(instanceId)
    if (!record) {
      return { released: false, reason: `Browser window "${instanceId}" not found.` }
    }
    if (sessionId && record.ownerSessionId && record.ownerSessionId !== sessionId) {
      return { released: false, reason: `Browser window "${instanceId}" is owned by session ${record.ownerSessionId}.` }
    }
    const released = record.agentControlActive
    record.agentControlActive = false
    return {
      released,
      reason: released ? undefined : 'No active browser control was found for this window.',
    }
  }

  async navigate(id: string, url: string): Promise<{ url: string; title: string }> {
    const record = this.requireRecord(id)
    const result = await this.invokeWindow(id, record.ownerSessionId ?? '', 'navigate', { url })
    const info = this.requireInfo(result, record.ownerSessionId ?? '')
    return { url: info.url, title: info.title }
  }

  async goBack(id: string): Promise<void> {
    const record = this.requireRecord(id)
    await this.invokeWindow(id, record.ownerSessionId ?? '', 'go_back', {})
  }

  async goForward(id: string): Promise<void> {
    const record = this.requireRecord(id)
    await this.invokeWindow(id, record.ownerSessionId ?? '', 'go_forward', {})
  }

  async getAccessibilitySnapshot(id: string): Promise<RemoteBrowserSnapshot> {
    const record = this.requireRecord(id)
    const result = await this.invokeWindow(id, record.ownerSessionId ?? '', 'snapshot', {})
    if (!result.snapshot) throw new Error('Snapshot result missing payload')
    return result.snapshot
  }

  async clickElement(id: string, ref: string, options?: { waitFor?: 'none' | 'navigation' | 'network-idle'; timeoutMs?: number }): Promise<void> {
    const record = this.requireRecord(id)
    await this.invokeWindow(id, record.ownerSessionId ?? '', 'click', {
      ref,
      waitFor: options?.waitFor,
      timeoutMs: options?.timeoutMs,
    })
  }

  async clickAtCoordinates(id: string, x: number, y: number): Promise<void> {
    const record = this.requireRecord(id)
    await this.invokeWindow(id, record.ownerSessionId ?? '', 'click_at', { x, y })
  }

  async drag(id: string, x1: number, y1: number, x2: number, y2: number): Promise<void> {
    const record = this.requireRecord(id)
    await this.invokeWindow(id, record.ownerSessionId ?? '', 'drag', { x1, y1, x2, y2 })
  }

  async fillElement(id: string, ref: string, value: string): Promise<void> {
    const record = this.requireRecord(id)
    await this.invokeWindow(id, record.ownerSessionId ?? '', 'fill', { ref, value })
  }

  async typeText(id: string, text: string): Promise<void> {
    const record = this.requireRecord(id)
    await this.invokeWindow(id, record.ownerSessionId ?? '', 'type', { text })
  }

  async selectOption(id: string, ref: string, value: string): Promise<void> {
    const record = this.requireRecord(id)
    await this.invokeWindow(id, record.ownerSessionId ?? '', 'select', { ref, value })
  }

  async setClipboard(id: string, text: string): Promise<void> {
    const record = this.requireRecord(id)
    await this.invokeWindow(id, record.ownerSessionId ?? '', 'set_clipboard', { text })
  }

  async getClipboard(id: string): Promise<string> {
    const record = this.requireRecord(id)
    const result = await this.invokeWindow(id, record.ownerSessionId ?? '', 'get_clipboard', {})
    return result.clipboard ?? ''
  }

  async scroll(id: string, direction: 'up' | 'down' | 'left' | 'right', amount?: number): Promise<void> {
    const record = this.requireRecord(id)
    await this.invokeWindow(id, record.ownerSessionId ?? '', 'scroll', { direction, amount })
  }

  async sendKey(id: string, args: BrowserKeyArgs): Promise<void> {
    const record = this.requireRecord(id)
    await this.invokeWindow(id, record.ownerSessionId ?? '', 'send_key', args)
  }

  async uploadFile(id: string, ref: string, filePaths: string[]): Promise<unknown> {
    const record = this.requireRecord(id)
    await this.invokeWindow(id, record.ownerSessionId ?? '', 'upload', { ref, filePaths })
    return undefined
  }

  async evaluate(id: string, expression: string): Promise<unknown> {
    const record = this.requireRecord(id)
    const result = await this.invokeWindow(id, record.ownerSessionId ?? '', 'evaluate', { expression })
    return result.evaluateResult
  }

  async screenshot(id: string, options?: BrowserScreenshotOptions): Promise<{ imageBuffer: Buffer; imageFormat: 'png' | 'jpeg'; metadata?: Record<string, unknown> }> {
    const record = this.requireRecord(id)
    const result = await this.invokeWindow(id, record.ownerSessionId ?? '', 'screenshot', {
      annotate: options?.annotate,
      format: options?.format,
      jpegQuality: options?.jpegQuality,
      includeLastAction: options?.includeLastAction,
      includeMetadata: options?.includeMetadata,
    })
    return {
      imageBuffer: Buffer.from(this.requireImageBuffer(result)),
      imageFormat: result.imageFormat ?? 'jpeg',
      metadata: result.metadata,
    }
  }

  async screenshotRegion(id: string, target: BrowserScreenshotRegionTarget): Promise<{ imageBuffer: Buffer; imageFormat: 'png' | 'jpeg'; metadata?: Record<string, unknown> }> {
    const record = this.requireRecord(id)
    const result = await this.invokeWindow(id, record.ownerSessionId ?? '', 'screenshot_region', { target })
    return {
      imageBuffer: Buffer.from(this.requireImageBuffer(result)),
      imageFormat: result.imageFormat ?? 'jpeg',
      metadata: result.metadata,
    }
  }

  getConsoleLogs(id: string, options?: BrowserConsoleOptions): BrowserConsoleEntry[] {
    const record = this.instances.get(id)
    if (!record) return []
    void this.invokeWindow(id, record.ownerSessionId ?? '', 'console_logs', options ?? {}).catch(() => {})
    return []
  }

  windowResize(id: string, width: number, height: number): { width: number; height: number } {
    const record = this.instances.get(id)
    if (record?.ownerSessionId) {
      void this.invokeWindow(id, record.ownerSessionId, 'window_resize', { width, height }).catch(() => {})
    }
    return { width, height }
  }

  getNetworkLogs(id: string, options?: BrowserNetworkOptions): BrowserNetworkEntry[] {
    const record = this.instances.get(id)
    if (!record?.ownerSessionId) return []
    void this.invokeWindow(id, record.ownerSessionId, 'network_logs', options ?? {}).catch(() => {})
    return []
  }

  async waitFor(id: string, args: BrowserWaitArgs): Promise<BrowserWaitResult> {
    const record = this.requireRecord(id)
    const result = await this.invokeWindow(id, record.ownerSessionId ?? '', 'wait_for', {
      kind: args.kind,
      value: args.value,
      timeoutMs: args.timeoutMs,
      pollMs: args.pollMs,
      idleMs: args.idleMs,
    })
    if (!result.waitResult) throw new Error('wait_for result missing payload')
    return result.waitResult
  }

  async getDownloads(id: string, options?: BrowserDownloadOptions): Promise<BrowserDownloadEntry[]> {
    const record = this.requireRecord(id)
    const result = await this.invokeWindow(id, record.ownerSessionId ?? '', 'downloads', options ?? {})
    return result.downloads ?? []
  }

  async detectSecurityChallenge(id: string): Promise<{ detected: boolean; provider: string; signals: string[] }> {
    const record = this.requireRecord(id)
    const result = await this.invokeWindow(id, record.ownerSessionId ?? '', 'detect_challenge', {})
    return result.challenge ?? { detected: false, provider: 'none', signals: [] }
  }

  private ensureRecord(sessionId: string): RemoteBrowserInstanceRecord {
    const existingId = this.sessionToInstanceId.get(sessionId)
    if (existingId) {
      const existing = this.instances.get(existingId)
      if (existing) return existing
    }

    const record: RemoteBrowserInstanceRecord = {
      id: `remote-browser-${randomUUID().slice(0, 8)}`,
      url: 'about:blank',
      title: 'Remote Browser',
      favicon: null,
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      boundSessionId: sessionId,
      ownerType: 'session',
      ownerSessionId: sessionId,
      isVisible: false,
      agentControlActive: false,
      themeColor: null,
      ownerClientId: null,
    }
    this.instances.set(record.id, record)
    this.sessionToInstanceId.set(sessionId, record.id)
    return record
  }

  private requireRecord(instanceId: string): RemoteBrowserInstanceRecord {
    const record = this.instances.get(instanceId)
    if (!record) throw new Error(`Browser instance not found: ${instanceId}`)
    return record
  }

  private async ensureRemoteWindow(sessionId: string, show: boolean): Promise<RemoteBrowserInstanceRecord> {
    const record = this.ensureRecord(sessionId)
    const client = await this.resolveOwningClient(sessionId, record.ownerClientId)
    const result = await requestClientBrowserHost(this.transport, client.clientId, {
      op: 'ensure_window',
      instanceId: record.id,
      show,
    })
    record.ownerClientId = client.clientId
    this.applyResultInfo(sessionId, result, record.id)
    return this.requireRecord(record.id)
  }

  private async invokeForSession(sessionId: string, op: RemoteBrowserInvokeArgs['op'], payload: Omit<RemoteBrowserInvokeArgs, 'op' | 'instanceId'>): Promise<RemoteBrowserInvokeResult> {
    const record = await this.ensureRemoteWindow(sessionId, false)
    return await this.invokeWindow(record.id, sessionId, op, payload)
  }

  private async invokeWindow(
    instanceId: string,
    sessionId: string,
    op: RemoteBrowserInvokeArgs['op'],
    payload: Omit<RemoteBrowserInvokeArgs, 'op' | 'instanceId'>,
  ): Promise<RemoteBrowserInvokeResult> {
    const record = this.requireRecord(instanceId)
    const attempt = async (): Promise<RemoteBrowserInvokeResult> => {
      const client = await this.resolveOwningClient(sessionId, record.ownerClientId)
      record.ownerClientId = client.clientId
      return await requestClientBrowserHost(this.transport, client.clientId, {
        op,
        instanceId,
        ...payload,
      })
    }

    try {
      const result = await attempt()
      this.applyResultInfo(sessionId, result, instanceId)
      return result
    } catch (error) {
      const code = (error as { code?: string })?.code
      if (code === 'CLIENT_DISCONNECTED' && record.ownerClientId) {
        record.ownerClientId = null
        const result = await attempt()
        this.applyResultInfo(sessionId, result, instanceId)
        return result
      }
      throw error
    }
  }

  private async resolveOwningClient(sessionId: string, preferredClientId: string | null): Promise<ConnectedClientInfo> {
    const clients = this.transport.listClients()
      .filter((client) => client.capabilities.includes(CLIENT_BROWSER_HOST_INVOKE))
    if (preferredClientId) {
      const preferred = clients.find((client) => client.clientId === preferredClientId)
      if (preferred) return preferred
    }

    const session = await this.sessionManager.getSession(sessionId)
    const workspaceId = session?.workspaceId
    const workspaceClients = clients
      .filter((client) => !workspaceId || client.workspaceId === workspaceId)
      .sort((a, b) => b.connectedAt - a.connectedAt)
    const selected = workspaceClients[0]
    if (!selected) {
      throw new Error('No connected thin client with browser host capability is available for this workspace.')
    }
    return selected
  }

  private applyResultInfo(sessionId: string, result: RemoteBrowserInvokeResult, instanceId?: string): void {
    if (!result.info || !instanceId) return
    const record = this.instances.get(instanceId)
    if (!record) return
    this.mergeRemoteInfo(record, result.info)
    if (!record.ownerSessionId) {
      record.ownerSessionId = sessionId
    }
  }

  private mergeRemoteInfo(record: RemoteBrowserInstanceRecord, info: RemoteBrowserWindowInfo): void {
    record.url = info.url
    record.title = info.title
    record.favicon = info.favicon
    record.isLoading = info.isLoading
    record.canGoBack = info.canGoBack
    record.canGoForward = info.canGoForward
    record.isVisible = info.isVisible
  }

  private async refreshRelevantWindows(sessionId: string): Promise<void> {
    const relevant = Array.from(this.instances.values()).filter((record) => record.ownerSessionId === sessionId)
    const clientIds = Array.from(new Set(relevant.map((record) => record.ownerClientId).filter((value): value is string => !!value)))
    for (const clientId of clientIds) {
      const result = await requestClientBrowserHost(this.transport, clientId, { op: 'list_windows' }).catch(() => null)
      if (!result?.windows) continue
      const windows = new Map(result.windows.map((info: RemoteBrowserWindowInfo) => [info.id, info]))
      for (const record of relevant.filter((item) => item.ownerClientId === clientId)) {
        const info = windows.get(record.id)
        if (info) {
          this.mergeRemoteInfo(record, info)
        }
      }
    }
  }

  private resolveWindowTarget(sessionId: string, requestedInstanceId: string | undefined, command: 'focus' | 'release' | 'close' | 'hide'): RemoteBrowserInstanceRecord {
    if (requestedInstanceId) {
      const explicit = this.instances.get(requestedInstanceId)
      if (!explicit) {
        throw new Error(`Browser window "${requestedInstanceId}" not found. Use "windows" to list available windows.`)
      }
      if (explicit.ownerSessionId && explicit.ownerSessionId !== sessionId) {
        throw new Error(`Browser window "${explicit.id}" is owned by session ${explicit.ownerSessionId}.`)
      }
      return explicit
    }

    const bound = Array.from(this.instances.values()).find((record) => record.boundSessionId === sessionId)
    if (bound) return bound

    const owned = Array.from(this.instances.values()).find((record) => record.ownerSessionId === sessionId)
    if (owned) return owned

    throw new Error(`No ${command} target is currently associated with this session. Use "open" first.`)
  }

  private requireInfo(result: RemoteBrowserInvokeResult, sessionId: string): RemoteBrowserWindowInfo {
    if (result.info) return result.info
    const instanceId = this.sessionToInstanceId.get(sessionId)
    if (!instanceId) throw new Error('Remote browser window is not initialized.')
    const record = this.instances.get(instanceId)
    if (!record) throw new Error('Remote browser window is not initialized.')
    return {
      id: record.id,
      url: record.url,
      title: record.title,
      favicon: record.favicon,
      isLoading: record.isLoading,
      canGoBack: record.canGoBack,
      canGoForward: record.canGoForward,
      isVisible: record.isVisible,
    }
  }

  private requireImageBuffer(result: RemoteBrowserInvokeResult): Uint8Array {
    if (!result.imageBuffer) {
      throw new Error('Screenshot result missing image payload')
    }
    return result.imageBuffer
  }
}
