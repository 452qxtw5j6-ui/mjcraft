import { describe, expect, it } from 'bun:test'
import { RemoteBrowserPaneAdapter } from '../remote-browser-pane-adapter'
import { CLIENT_BROWSER_HOST_INVOKE } from '@craft-agent/server-core/transport'
import type { RemoteBrowserInvokeArgs, RemoteBrowserWindowInfo } from '@craft-agent/shared/protocol'

interface FakeClient {
  clientId: string
  workspaceId: string | null
  webContentsId: number | null
  capabilities: string[]
  connectedAt: number
}

function createWindowInfo(id: string, isVisible: boolean): RemoteBrowserWindowInfo {
  return {
    id,
    url: 'about:blank',
    title: 'Remote Browser',
    favicon: null,
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    isVisible,
  }
}

describe('RemoteBrowserPaneAdapter', () => {
  it('selects the newest capable client, reuses the same window, and preserves hide/release semantics', async () => {
    const clients: FakeClient[] = [
      {
        clientId: 'client-old',
        workspaceId: 'ws-1',
        webContentsId: 1,
        capabilities: [CLIENT_BROWSER_HOST_INVOKE],
        connectedAt: 10,
      },
      {
        clientId: 'client-new',
        workspaceId: 'ws-1',
        webContentsId: 2,
        capabilities: [CLIENT_BROWSER_HOST_INVOKE],
        connectedAt: 20,
      },
    ]
    const windowsByClient = new Map<string, Map<string, RemoteBrowserWindowInfo>>()
    const invoked: Array<{ clientId: string; request: RemoteBrowserInvokeArgs }> = []

    const transport = {
      listClients: () => clients,
      invokeClient: async (clientId: string, _channel: string, request: RemoteBrowserInvokeArgs) => {
        invoked.push({ clientId, request })
        const windows = windowsByClient.get(clientId) ?? new Map<string, RemoteBrowserWindowInfo>()
        windowsByClient.set(clientId, windows)

        switch (request.op) {
          case 'ensure_window': {
            const id = String(request.instanceId)
            const current = windows.get(id) ?? createWindowInfo(id, !!request.show)
            current.isVisible = !!request.show
            windows.set(id, current)
            return { info: current }
          }
          case 'focus_window': {
            const current = windows.get(String(request.instanceId))
            if (!current) throw new Error('missing window')
            current.isVisible = true
            return { info: current }
          }
          case 'hide_window': {
            const current = windows.get(String(request.instanceId))
            if (!current) throw new Error('missing window')
            current.isVisible = false
            return { info: current }
          }
          case 'destroy_window': {
            windows.delete(String(request.instanceId))
            return {}
          }
          case 'list_windows':
            return { windows: [...windows.values()] }
          default:
            throw new Error(`unexpected op ${request.op}`)
        }
      },
    }

    const sessionManager = {
      getSession: async () => ({
        id: 'sess-1',
        workspaceId: 'ws-1',
        workspaceName: 'Workspace',
        messages: [],
        lastMessageAt: Date.now(),
        isProcessing: false,
      }),
    }

    const adapter = new RemoteBrowserPaneAdapter(transport as any, sessionManager as any)
    const browserFns = adapter.createSessionBrowserPaneFns('sess-1')

    const opened = await browserFns.openPanel({ background: false })
    expect(opened.instanceId).toContain('remote-browser-')
    expect(invoked[0]?.clientId).toBe('client-new')
    expect(invoked[0]?.request.op).toBe('ensure_window')
    expect(invoked[0]?.request.show).toBe(true)

    const hidden = await browserFns.hideWindow()
    expect(hidden.action).toBe('hidden')
    const windowsAfterHide = await browserFns.listWindows()
    expect(windowsAfterHide[0]?.isVisible).toBe(false)

    const reopened = await browserFns.openPanel({ background: false })
    expect(reopened.instanceId).toBe(opened.instanceId)
    const windowsAfterReopen = await browserFns.listWindows()
    expect(windowsAfterReopen[0]?.isVisible).toBe(true)

    adapter.setAgentControl('sess-1', { displayName: 'Agent' })
    let windowsWithControl = await browserFns.listWindows()
    expect(windowsWithControl[0]?.agentControlActive).toBe(true)

    const released = await browserFns.releaseControl()
    expect(released.action).toBe('released')
    windowsWithControl = await browserFns.listWindows()
    expect(windowsWithControl[0]?.agentControlActive).toBe(false)
    expect(windowsWithControl[0]?.boundSessionId).toBe('sess-1')
  })
})
