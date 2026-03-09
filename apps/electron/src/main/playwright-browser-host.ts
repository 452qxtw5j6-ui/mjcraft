import type { Browser, BrowserContext, BrowserServer, CDPSession, ConsoleMessage, Download, Page } from 'playwright'
import type {
  RemoteBrowserInvokeArgs,
  RemoteBrowserInvokeResult,
  RemoteBrowserSnapshot,
  RemoteBrowserSnapshotNode,
  RemoteBrowserWindowInfo,
} from '@craft-agent/shared/protocol'
import log from './logger'

const browserHostLog = log.scope('playwright-browser-host')

const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000
const DEFAULT_WAIT_TIMEOUT_MS = 10_000
const DEFAULT_WAIT_POLL_MS = 100
const DEFAULT_WAIT_IDLE_MS = 700
const MAX_CONSOLE_ENTRIES = 500
const MAX_NETWORK_ENTRIES = 500
const MAX_DOWNLOAD_ENTRIES = 200
const REMOTE_REF_ATTR = 'data-craft-remote-ref'

interface BrowserConsoleEntry {
  timestamp: number
  level: 'log' | 'info' | 'warn' | 'error'
  message: string
}

interface BrowserNetworkEntry {
  timestamp: number
  method: string
  url: string
  status: number
  resourceType: string
  ok: boolean
}

interface BrowserDownloadEntry {
  id: string
  timestamp: number
  url: string
  filename: string
  state: 'started' | 'completed' | 'interrupted' | 'cancelled'
  bytesReceived: number
  totalBytes: number
  mimeType: string
  savePath?: string
}

interface HostedBrowserInstance {
  id: string
  browserServer: BrowserServer
  browser: Browser
  context: BrowserContext
  page: Page
  cdp: CDPSession | null
  currentUrl: string
  title: string
  favicon: string | null
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  isVisible: boolean
  nextRefCounter: number
  consoleLogs: BrowserConsoleEntry[]
  networkLogs: BrowserNetworkEntry[]
  downloads: BrowserDownloadEntry[]
  inflightRequests: number
  lastNetworkActivityAt: number
  clipboardText: string
}

type PlaywrightModule = typeof import('playwright')

function normalizeUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return trimmed
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
  const isAbout = trimmed.startsWith('about:')
  if (hasScheme || isAbout) return trimmed
  const looksLikeHost = /^(localhost|\d{1,3}(?:\.\d{1,3}){3}|[\w-]+(?:\.[\w-]+)+)(?::\d+)?(?:\/|$)/i.test(trimmed)
  if (looksLikeHost) return `https://${trimmed}`
  return `https://duckduckgo.com/?q=${encodeURIComponent(trimmed)}`
}

function appendBounded<T>(items: T[], value: T, max: number): void {
  items.push(value)
  if (items.length > max) {
    items.splice(0, items.length - max)
  }
}

function statusBucket(status: number): '2xx' | '3xx' | '4xx' | '5xx' | 'other' {
  if (status >= 200 && status < 300) return '2xx'
  if (status >= 300 && status < 400) return '3xx'
  if (status >= 400 && status < 500) return '4xx'
  if (status >= 500 && status < 600) return '5xx'
  return 'other'
}

export class PlaywrightBrowserHost {
  private readonly instances = new Map<string, HostedBrowserInstance>()
  private playwright: PlaywrightModule | null = null

  async invoke(request: RemoteBrowserInvokeArgs): Promise<RemoteBrowserInvokeResult> {
    switch (request.op) {
      case 'ensure_window': {
        const instanceId = request.instanceId?.trim()
        if (!instanceId) throw new Error('ensure_window requires instanceId')
        const instance = await this.ensureInstance(instanceId, request.show ?? false)
        return { info: await this.toWindowInfo(instance) }
      }
      case 'destroy_window': {
        const instance = this.getRequiredInstance(request.instanceId)
        await this.closeInstance(instance)
        return {}
      }
      case 'focus_window': {
        const instance = this.getRequiredInstance(request.instanceId)
        await this.focusInstance(instance)
        return { info: await this.toWindowInfo(instance) }
      }
      case 'hide_window': {
        const instance = this.getRequiredInstance(request.instanceId)
        await this.hideInstance(instance)
        return { info: await this.toWindowInfo(instance) }
      }
      case 'list_windows':
        return { windows: await this.listWindowInfos() }
      case 'navigate': {
        const instance = this.getRequiredInstance(request.instanceId)
        const url = request.url?.trim()
        if (!url) throw new Error('navigate requires url')
        instance.isLoading = true
        await instance.page.goto(normalizeUrl(url), {
          waitUntil: 'domcontentloaded',
          timeout: DEFAULT_NAVIGATION_TIMEOUT_MS,
        })
        instance.isLoading = false
        return { info: await this.toWindowInfo(instance) }
      }
      case 'go_back': {
        const instance = this.getRequiredInstance(request.instanceId)
        instance.isLoading = true
        await instance.page.goBack({ timeout: DEFAULT_NAVIGATION_TIMEOUT_MS }).catch(() => null)
        instance.isLoading = false
        return { info: await this.toWindowInfo(instance) }
      }
      case 'go_forward': {
        const instance = this.getRequiredInstance(request.instanceId)
        instance.isLoading = true
        await instance.page.goForward({ timeout: DEFAULT_NAVIGATION_TIMEOUT_MS }).catch(() => null)
        instance.isLoading = false
        return { info: await this.toWindowInfo(instance) }
      }
      case 'snapshot': {
        const instance = this.getRequiredInstance(request.instanceId)
        const snapshot = await this.captureSnapshot(instance)
        return {
          info: await this.toWindowInfo(instance),
          snapshot,
        }
      }
      case 'click': {
        const instance = this.getRequiredInstance(request.instanceId)
        const ref = request.ref?.trim()
        if (!ref) throw new Error('click requires ref')
        const locator = await this.getLocatorForRef(instance, ref)
        if (request.waitFor === 'navigation') {
          await Promise.all([
            instance.page.waitForNavigation({ timeout: request.timeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS }),
            locator.click(),
          ])
        } else {
          await locator.click()
          if (request.waitFor === 'network-idle') {
            await this.waitForNetworkIdle(instance, request.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS, request.idleMs ?? DEFAULT_WAIT_IDLE_MS)
          }
        }
        return { info: await this.toWindowInfo(instance) }
      }
      case 'click_at': {
        const instance = this.getRequiredInstance(request.instanceId)
        await instance.page.mouse.click(request.x ?? 0, request.y ?? 0)
        return { info: await this.toWindowInfo(instance) }
      }
      case 'drag': {
        const instance = this.getRequiredInstance(request.instanceId)
        await instance.page.mouse.move(request.x1 ?? 0, request.y1 ?? 0)
        await instance.page.mouse.down()
        await instance.page.mouse.move(request.x2 ?? 0, request.y2 ?? 0)
        await instance.page.mouse.up()
        return { info: await this.toWindowInfo(instance) }
      }
      case 'fill': {
        const instance = this.getRequiredInstance(request.instanceId)
        const ref = request.ref?.trim()
        if (!ref) throw new Error('fill requires ref')
        const locator = await this.getLocatorForRef(instance, ref)
        await locator.fill(request.value ?? '')
        return { info: await this.toWindowInfo(instance) }
      }
      case 'type': {
        const instance = this.getRequiredInstance(request.instanceId)
        await instance.page.keyboard.type(request.text ?? '')
        return { info: await this.toWindowInfo(instance) }
      }
      case 'select': {
        const instance = this.getRequiredInstance(request.instanceId)
        const ref = request.ref?.trim()
        if (!ref) throw new Error('select requires ref')
        const locator = await this.getLocatorForRef(instance, ref)
        await locator.selectOption({ value: request.value ?? '' })
        return { info: await this.toWindowInfo(instance) }
      }
      case 'set_clipboard': {
        const instance = this.getRequiredInstance(request.instanceId)
        instance.clipboardText = request.text ?? ''
        await instance.page.evaluate(async (text) => {
          await navigator.clipboard.writeText(text)
        }, instance.clipboardText).catch(() => {})
        return { info: await this.toWindowInfo(instance) }
      }
      case 'get_clipboard': {
        const instance = this.getRequiredInstance(request.instanceId)
        const clipboard = await instance.page.evaluate(async () => navigator.clipboard.readText()).catch(() => instance.clipboardText)
        instance.clipboardText = String(clipboard ?? '')
        return {
          info: await this.toWindowInfo(instance),
          clipboard: instance.clipboardText,
        }
      }
      case 'screenshot': {
        const instance = this.getRequiredInstance(request.instanceId)
        const result = await this.takeScreenshot(instance, {
          annotate: request.annotate ?? false,
          format: request.format,
          jpegQuality: request.jpegQuality,
        })
        return {
          info: await this.toWindowInfo(instance),
          imageBuffer: result.imageBuffer,
          imageFormat: result.imageFormat,
          metadata: result.metadata,
        }
      }
      case 'screenshot_region': {
        const instance = this.getRequiredInstance(request.instanceId)
        const result = await this.takeScreenshotRegion(instance, request.target ?? {})
        return {
          info: await this.toWindowInfo(instance),
          imageBuffer: result.imageBuffer,
          imageFormat: result.imageFormat,
          metadata: result.metadata,
        }
      }
      case 'console_logs': {
        const instance = this.getRequiredInstance(request.instanceId)
        const level = request.level ?? 'all'
        const logs = instance.consoleLogs
          .filter((entry) => level === 'all' || entry.level === level)
          .slice(-(request.limit ?? 50))
        return { info: await this.toWindowInfo(instance), consoleLogs: logs }
      }
      case 'window_resize': {
        const instance = this.getRequiredInstance(request.instanceId)
        await this.setWindowBounds(instance, {
          width: Math.max(200, request.width ?? 1280),
          height: Math.max(200, request.height ?? 720),
          windowState: 'normal',
        })
        instance.isVisible = true
        return {
          info: await this.toWindowInfo(instance),
          resizeResult: { width: Math.max(200, request.width ?? 1280), height: Math.max(200, request.height ?? 720) },
        }
      }
      case 'network_logs': {
        const instance = this.getRequiredInstance(request.instanceId)
        const status = request.status ?? 'all'
        const method = request.method?.toUpperCase()
        const resourceType = request.resourceType
        const logs = instance.networkLogs
          .filter((entry) => {
            if (status === 'failed') return !entry.ok
            if (status !== 'all' && statusBucket(entry.status) !== status) return false
            if (method && entry.method.toUpperCase() !== method) return false
            if (resourceType && entry.resourceType !== resourceType) return false
            return true
          })
          .slice(-(request.limit ?? 50))
        return { info: await this.toWindowInfo(instance), networkLogs: logs }
      }
      case 'wait_for': {
        const instance = this.getRequiredInstance(request.instanceId)
        const waitResult = await this.waitFor(instance, request)
        return { info: await this.toWindowInfo(instance), waitResult }
      }
      case 'send_key': {
        const instance = this.getRequiredInstance(request.instanceId)
        const key = request.key?.trim()
        if (!key) throw new Error('send_key requires key')
        const modifiers = request.modifiers ?? []
        for (const modifier of modifiers) {
          await instance.page.keyboard.down(this.normalizeModifier(modifier))
        }
        await instance.page.keyboard.press(key)
        for (const modifier of [...modifiers].reverse()) {
          await instance.page.keyboard.up(this.normalizeModifier(modifier))
        }
        return { info: await this.toWindowInfo(instance) }
      }
      case 'downloads': {
        const instance = this.getRequiredInstance(request.instanceId)
        const downloads = request.action === 'wait'
          ? await this.waitForDownloads(instance, request.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS)
          : instance.downloads.slice(-(request.limit ?? 20))
        return { info: await this.toWindowInfo(instance), downloads }
      }
      case 'upload': {
        const instance = this.getRequiredInstance(request.instanceId)
        const ref = request.ref?.trim()
        if (!ref) throw new Error('upload requires ref')
        const locator = await this.getLocatorForRef(instance, ref)
        await locator.setInputFiles(request.filePaths ?? [])
        return { info: await this.toWindowInfo(instance) }
      }
      case 'scroll': {
        const instance = this.getRequiredInstance(request.instanceId)
        const amount = request.amount ?? 500
        const deltaX = request.direction === 'left' ? -amount : request.direction === 'right' ? amount : 0
        const deltaY = request.direction === 'up' ? -amount : request.direction === 'down' ? amount : 0
        await instance.page.evaluate(({ dx, dy }) => window.scrollBy(dx, dy), { dx: deltaX, dy: deltaY })
        return { info: await this.toWindowInfo(instance) }
      }
      case 'evaluate': {
        const instance = this.getRequiredInstance(request.instanceId)
        const expression = request.expression?.trim()
        if (!expression) throw new Error('evaluate requires expression')
        const evaluateResult = await instance.page.evaluate((expr) => {
          return eval(expr)
        }, expression)
        return { info: await this.toWindowInfo(instance), evaluateResult }
      }
      case 'detect_challenge': {
        const instance = this.getRequiredInstance(request.instanceId)
        return {
          info: await this.toWindowInfo(instance),
          challenge: await this.detectChallenge(instance),
        }
      }
      default:
        throw new Error(`Unsupported remote browser op: ${String((request as { op?: string }).op ?? 'unknown')}`)
    }
  }

  async dispose(): Promise<void> {
    const instances = Array.from(this.instances.values())
    for (const instance of instances) {
      await this.closeInstance(instance).catch((error) => {
        browserHostLog.warn(`[browser-host] cleanup failed id=${instance.id}: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
  }

  private getRequiredInstance(instanceId: string | undefined): HostedBrowserInstance {
    if (!instanceId) throw new Error('Browser command requires instanceId')
    const instance = this.instances.get(instanceId)
    if (!instance) throw new Error(`Remote browser window not found: ${instanceId}`)
    return instance
  }

  private async ensurePlaywright(): Promise<PlaywrightModule> {
    if (this.playwright) return this.playwright
    this.playwright = await import('playwright')
    return this.playwright
  }

  private async ensureInstance(instanceId: string, show: boolean): Promise<HostedBrowserInstance> {
    const existing = this.instances.get(instanceId)
    if (existing) {
      if (show) {
        await this.focusInstance(existing)
      }
      return existing
    }

    const { chromium } = await this.ensurePlaywright()
    const browserServer = await chromium.launchServer({
      headless: false,
      args: ['--no-first-run', '--no-default-browser-check'],
    })
    const browser = await chromium.connect(browserServer.wsEndpoint())
    const context = await browser.newContext({
      acceptDownloads: true,
      viewport: null,
    })
    await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {})
    const page = await context.newPage()

    const instance: HostedBrowserInstance = {
      id: instanceId,
      browserServer,
      browser,
      context,
      page,
      cdp: null,
      currentUrl: page.url(),
      title: '',
      favicon: null,
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      isVisible: true,
      nextRefCounter: 0,
      consoleLogs: [],
      networkLogs: [],
      downloads: [],
      inflightRequests: 0,
      lastNetworkActivityAt: Date.now(),
      clipboardText: '',
    }

    this.attachEventListeners(instance)
    this.instances.set(instanceId, instance)

    if (show) {
      await this.focusInstance(instance)
    } else {
      await this.hideInstance(instance)
    }

    return instance
  }

  private attachEventListeners(instance: HostedBrowserInstance): void {
    instance.page.on('console', (message) => {
      appendBounded(instance.consoleLogs, this.toConsoleEntry(message), MAX_CONSOLE_ENTRIES)
    })
    instance.page.on('request', (request) => {
      instance.inflightRequests += 1
      instance.lastNetworkActivityAt = Date.now()
      browserHostLog.debug(`[browser-host] request started id=${instance.id} ${request.method()} ${request.url()}`)
    })
    instance.page.on('requestfinished', async (request) => {
      instance.inflightRequests = Math.max(0, instance.inflightRequests - 1)
      instance.lastNetworkActivityAt = Date.now()
      const response = await request.response().catch(() => null)
      appendBounded(instance.networkLogs, {
        timestamp: Date.now(),
        method: request.method(),
        url: request.url(),
        status: response?.status() ?? 0,
        resourceType: request.resourceType(),
        ok: !!response?.ok(),
      }, MAX_NETWORK_ENTRIES)
    })
    instance.page.on('requestfailed', (request) => {
      instance.inflightRequests = Math.max(0, instance.inflightRequests - 1)
      instance.lastNetworkActivityAt = Date.now()
      appendBounded(instance.networkLogs, {
        timestamp: Date.now(),
        method: request.method(),
        url: request.url(),
        status: 0,
        resourceType: request.resourceType(),
        ok: false,
      }, MAX_NETWORK_ENTRIES)
    })
    instance.page.on('download', (download) => {
      void this.recordDownload(instance, download)
    })
    instance.page.on('framenavigated', (frame) => {
      if (frame === instance.page.mainFrame()) {
        instance.currentUrl = instance.page.url()
        instance.lastNetworkActivityAt = Date.now()
      }
    })
    instance.page.on('load', () => {
      void this.refreshInfo(instance)
    })
  }

  private toConsoleEntry(message: ConsoleMessage): BrowserConsoleEntry {
    const type = message.type()
    const level = type === 'warning' ? 'warn' : type === 'error' ? 'error' : type === 'info' ? 'info' : 'log'
    return {
      timestamp: Date.now(),
      level,
      message: message.text(),
    }
  }

  private async recordDownload(instance: HostedBrowserInstance, download: Download): Promise<void> {
    const entry: BrowserDownloadEntry = {
      id: `${instance.id}:${Date.now()}`,
      timestamp: Date.now(),
      url: download.url(),
      filename: download.suggestedFilename(),
      state: 'started',
      bytesReceived: 0,
      totalBytes: 0,
      mimeType: '',
    }
    appendBounded(instance.downloads, entry, MAX_DOWNLOAD_ENTRIES)
    try {
      const savePath = await download.path()
      entry.savePath = savePath ?? undefined
      entry.state = 'completed'
    } catch {
      const failure = await download.failure().catch(() => 'unknown')
      entry.state = failure === 'canceled' ? 'cancelled' : 'interrupted'
    }
  }

  private async refreshInfo(instance: HostedBrowserInstance): Promise<void> {
    instance.currentUrl = instance.page.url()
    instance.title = await instance.page.title().catch(() => instance.title)
  }

  private async toWindowInfo(instance: HostedBrowserInstance): Promise<RemoteBrowserWindowInfo> {
    await this.refreshInfo(instance)
    return {
      id: instance.id,
      url: instance.currentUrl,
      title: instance.title,
      favicon: instance.favicon,
      isLoading: instance.isLoading,
      canGoBack: instance.canGoBack,
      canGoForward: instance.canGoForward,
      isVisible: instance.isVisible,
    }
  }

  private async listWindowInfos(): Promise<RemoteBrowserWindowInfo[]> {
    return await Promise.all(Array.from(this.instances.values()).map((instance) => this.toWindowInfo(instance)))
  }

  private async focusInstance(instance: HostedBrowserInstance): Promise<void> {
    instance.isVisible = true
    await this.setWindowBounds(instance, { windowState: 'normal' }).catch(() => {})
    await instance.page.bringToFront().catch(() => {})
    await instance.page.evaluate(() => window.focus()).catch(() => {})
  }

  private async hideInstance(instance: HostedBrowserInstance): Promise<void> {
    instance.isVisible = false
    await this.setWindowBounds(instance, { windowState: 'minimized' }).catch(() => {})
  }

  private async closeInstance(instance: HostedBrowserInstance): Promise<void> {
    this.instances.delete(instance.id)
    await instance.context.close().catch(() => {})
    await instance.browser.close().catch(() => {})
    instance.browserServer.close()
  }

  private async getCdp(instance: HostedBrowserInstance): Promise<CDPSession> {
    if (instance.cdp) return instance.cdp
    instance.cdp = await instance.context.newCDPSession(instance.page)
    return instance.cdp
  }

  private async setWindowBounds(instance: HostedBrowserInstance, bounds: Record<string, unknown>): Promise<void> {
    const cdp = await this.getCdp(instance)
    const { windowId } = await cdp.send('Browser.getWindowForTarget')
    await cdp.send('Browser.setWindowBounds', { windowId, bounds })
  }

  private async captureSnapshot(instance: HostedBrowserInstance): Promise<RemoteBrowserSnapshot> {
    const snapshot = await instance.page.evaluate(({ refAttr }) => {
      const interactiveRoles = new Set([
        'button', 'link', 'textbox', 'searchbox', 'combobox',
        'checkbox', 'radio', 'switch', 'slider', 'spinbutton',
        'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
        'option', 'treeitem', 'row', 'cell', 'columnheader',
        'rowheader', 'gridcell',
      ])

      const normalizeText = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim()
      const isVisible = (el: Element) => {
        const node = el as HTMLElement
        const style = window.getComputedStyle(node)
        const rect = node.getBoundingClientRect()
        if (style.visibility === 'hidden' || style.display === 'none') return false
        if (rect.width <= 0 || rect.height <= 0) return false
        return true
      }

      const resolveRole = (el: Element) => {
        const explicitRole = el.getAttribute('role')
        if (explicitRole) return explicitRole
        const tag = el.tagName.toLowerCase()
        if (tag === 'a' && (el as HTMLAnchorElement).href) return 'link'
        if (tag === 'button') return 'button'
        if (tag === 'textarea') return 'textbox'
        if (tag === 'select') return 'combobox'
        if (tag === 'option') return 'option'
        if (tag === 'img') return 'img'
        if (/^h[1-6]$/.test(tag)) return 'heading'
        if (tag === 'input') {
          const type = (el.getAttribute('type') || 'text').toLowerCase()
          if (type === 'checkbox') return 'checkbox'
          if (type === 'radio') return 'radio'
          if (type === 'search') return 'searchbox'
          if (type === 'button' || type === 'submit' || type === 'reset') return 'button'
          return 'textbox'
        }
        if (tag === 'article') return 'article'
        if (tag === 'main') return 'main'
        if (tag === 'nav') return 'navigation'
        return 'generic'
      }

      const candidates = Array.from(document.querySelectorAll([
        'a[href]', 'button', 'input', 'textarea', 'select', 'option', 'summary',
        '[role]', '[contenteditable="true"]', 'img', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        '[aria-label]', '[aria-labelledby]',
      ].join(',')))

      const seen = new Set<Element>()
      const nodes: Array<{
        element: Element
        role: string
        name: string
        value?: string
        description?: string
        focused?: boolean
        checked?: boolean
        disabled?: boolean
      }> = []

      for (const el of candidates) {
        if (seen.has(el) || !isVisible(el)) continue
        seen.add(el)
        const role = resolveRole(el)
        const name = normalizeText(
          el.getAttribute('aria-label')
          || (el as HTMLInputElement).labels?.[0]?.textContent
          || (el as HTMLInputElement).value
          || el.textContent
          || el.getAttribute('alt')
          || el.getAttribute('title')
        )
        const value = normalizeText((el as HTMLInputElement).value)
        const description = normalizeText(el.getAttribute('placeholder') || el.getAttribute('title'))
        const checked = (el as HTMLInputElement).checked
        const disabled = (el as HTMLInputElement).disabled || el.getAttribute('aria-disabled') === 'true'
        const focused = document.activeElement === el

        if (!interactiveRoles.has(role) && role === 'generic' && !name && !value) continue
        nodes.push({ element: el, role, name, value: value || undefined, description: description || undefined, checked, disabled, focused })
      }

      return {
        url: window.location.href,
        title: document.title || '',
        nodes: nodes.map((node) => ({
          role: node.role,
          name: node.name,
          value: node.value,
          description: node.description,
          checked: node.checked,
          disabled: node.disabled,
          focused: node.focused,
          existingRef: node.element.getAttribute(refAttr) || '',
        })),
      }
    }, { refAttr: REMOTE_REF_ATTR }) as {
      url: string
      title: string
      nodes: Array<Omit<RemoteBrowserSnapshotNode, 'ref'> & { existingRef?: string }>
    }

    const nodes: RemoteBrowserSnapshotNode[] = snapshot.nodes.map((node) => ({
      ref: node.existingRef && node.existingRef.trim() ? node.existingRef : `@e${++instance.nextRefCounter}`,
      role: node.role,
      name: node.name,
      value: node.value,
      description: node.description,
      checked: node.checked,
      disabled: node.disabled,
      focused: node.focused,
    }))

    await instance.page.evaluate(({ refAttr, refs }) => {
      const candidates = Array.from(document.querySelectorAll([
        'a[href]', 'button', 'input', 'textarea', 'select', 'option', 'summary',
        '[role]', '[contenteditable="true"]', 'img', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        '[aria-label]', '[aria-labelledby]',
      ].join(',')))
      let index = 0
      for (const el of candidates) {
        const node = el as HTMLElement
        const rect = node.getBoundingClientRect()
        const style = window.getComputedStyle(node)
        if (style.visibility === 'hidden' || style.display === 'none' || rect.width <= 0 || rect.height <= 0) continue
        const nextRef = refs[index]
        if (!nextRef) break
        node.setAttribute(refAttr, nextRef)
        index += 1
      }
    }, { refAttr: REMOTE_REF_ATTR, refs: nodes.map((node) => node.ref) })

    instance.currentUrl = snapshot.url
    instance.title = snapshot.title
    return {
      url: snapshot.url,
      title: snapshot.title,
      nodes,
    }
  }

  private async getLocatorForRef(instance: HostedBrowserInstance, ref: string) {
    const locator = instance.page.locator(`[${REMOTE_REF_ATTR}="${ref}"]`).first()
    const count = await locator.count()
    if (count === 0) {
      throw new Error(`Element ref ${ref} not found. Re-run "snapshot" and retry.`)
    }
    return locator
  }

  private async takeScreenshot(
    instance: HostedBrowserInstance,
    options: { annotate?: boolean; format?: 'png' | 'jpeg'; jpegQuality?: number },
  ): Promise<{ imageBuffer: Uint8Array; imageFormat: 'png' | 'jpeg'; metadata?: Record<string, unknown> }> {
    let overlayId: string | null = null
    if (options.annotate) {
      overlayId = await this.injectAnnotationOverlay(instance)
    }
    try {
      const imageFormat = options.format ?? 'jpeg'
      const imageBuffer = await instance.page.screenshot({
        type: imageFormat,
        quality: imageFormat === 'jpeg' ? (options.jpegQuality ?? 85) : undefined,
      })
      return { imageBuffer, imageFormat }
    } finally {
      if (overlayId) {
        await instance.page.evaluate((id) => {
          document.getElementById(id)?.remove()
        }, overlayId).catch(() => {})
      }
    }
  }

  private async injectAnnotationOverlay(instance: HostedBrowserInstance): Promise<string> {
    const snapshot = await this.captureSnapshot(instance)
    const overlayId = `craft-remote-overlay-${Date.now()}`
    await instance.page.evaluate(({ overlayId, refAttr, refs }) => {
      const overlay = document.createElement('div')
      overlay.id = overlayId
      overlay.style.position = 'fixed'
      overlay.style.inset = '0'
      overlay.style.pointerEvents = 'none'
      overlay.style.zIndex = '2147483647'
      for (const ref of refs) {
        const el = document.querySelector(`[${refAttr}="${ref}"]`) as HTMLElement | null
        if (!el) continue
        const rect = el.getBoundingClientRect()
        const chip = document.createElement('div')
        chip.textContent = ref
        chip.style.position = 'fixed'
        chip.style.left = `${Math.max(0, rect.left)}px`
        chip.style.top = `${Math.max(0, rect.top)}px`
        chip.style.background = '#111827'
        chip.style.color = '#ffffff'
        chip.style.font = '12px monospace'
        chip.style.padding = '2px 4px'
        chip.style.borderRadius = '4px'
        chip.style.boxShadow = '0 1px 3px rgba(0,0,0,0.35)'
        chip.style.border = '1px solid rgba(255,255,255,0.2)'
        overlay.appendChild(chip)
      }
      document.body.appendChild(overlay)
    }, { overlayId, refAttr: REMOTE_REF_ATTR, refs: snapshot.nodes.map((node) => node.ref) })
    return overlayId
  }

  private async takeScreenshotRegion(
    instance: HostedBrowserInstance,
    target: NonNullable<RemoteBrowserInvokeArgs['target']>,
  ): Promise<{ imageBuffer: Uint8Array; imageFormat: 'png' | 'jpeg'; metadata?: Record<string, unknown> }> {
    let clip: { x: number; y: number; width: number; height: number }
    if (target.ref) {
      const locator = await this.getLocatorForRef(instance, target.ref)
      const box = await locator.boundingBox()
      if (!box) throw new Error(`Unable to resolve region for ${target.ref}`)
      const padding = target.padding ?? 0
      clip = {
        x: Math.max(0, box.x - padding),
        y: Math.max(0, box.y - padding),
        width: Math.max(1, box.width + padding * 2),
        height: Math.max(1, box.height + padding * 2),
      }
    } else if (target.selector) {
      const locator = instance.page.locator(target.selector).first()
      const box = await locator.boundingBox()
      if (!box) throw new Error(`Unable to resolve region for selector ${target.selector}`)
      const padding = target.padding ?? 0
      clip = {
        x: Math.max(0, box.x - padding),
        y: Math.max(0, box.y - padding),
        width: Math.max(1, box.width + padding * 2),
        height: Math.max(1, box.height + padding * 2),
      }
    } else {
      clip = {
        x: target.x ?? 0,
        y: target.y ?? 0,
        width: Math.max(1, target.width ?? 1),
        height: Math.max(1, target.height ?? 1),
      }
    }

    const imageFormat = target.format ?? 'jpeg'
    const imageBuffer = await instance.page.screenshot({
      type: imageFormat,
      quality: imageFormat === 'jpeg' ? (target.jpegQuality ?? 85) : undefined,
      clip,
    })
    return {
      imageBuffer,
      imageFormat,
      metadata: { clip },
    }
  }

  private async waitFor(
    instance: HostedBrowserInstance,
    args: RemoteBrowserInvokeArgs,
  ): Promise<{ ok: true; kind: string; elapsedMs: number; detail: string }> {
    const timeoutMs = Math.max(100, args.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS)
    const pollMs = Math.max(25, args.pollMs ?? DEFAULT_WAIT_POLL_MS)
    const idleMs = Math.max(100, args.idleMs ?? DEFAULT_WAIT_IDLE_MS)
    const started = Date.now()
    const kind = args.kind
    if (!kind) throw new Error('wait_for requires kind')

    const until = async (predicate: () => Promise<boolean>, detail: string) => {
      while (Date.now() - started <= timeoutMs) {
        if (await predicate()) {
          return { ok: true as const, kind, elapsedMs: Date.now() - started, detail }
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs))
      }
      throw new Error(`Wait timed out after ${timeoutMs}ms (${kind})`)
    }

    if (kind === 'selector') {
      const selector = args.value?.trim()
      if (!selector) throw new Error('wait_for selector requires value')
      return until(async () => (await instance.page.locator(selector).count()) > 0, `selector matched: ${selector}`)
    }
    if (kind === 'text') {
      const text = args.value?.trim()
      if (!text) throw new Error('wait_for text requires value')
      return until(async () => {
        const bodyText = await instance.page.evaluate(() => document.body?.innerText || '').catch(() => '')
        return String(bodyText).includes(text)
      }, `text found: ${text}`)
    }
    if (kind === 'url') {
      const needle = args.value?.trim()
      if (!needle) throw new Error('wait_for url requires value')
      return until(async () => instance.page.url().includes(needle), `url matched: ${needle}`)
    }
    if (kind === 'network-idle') {
      await this.waitForNetworkIdle(instance, timeoutMs, idleMs, pollMs)
      return { ok: true, kind, elapsedMs: Date.now() - started, detail: `network idle for ${idleMs}ms` }
    }
    throw new Error(`Unknown wait kind: ${kind}`)
  }

  private async waitForNetworkIdle(
    instance: HostedBrowserInstance,
    timeoutMs: number,
    idleMs: number,
    pollMs = DEFAULT_WAIT_POLL_MS,
  ): Promise<void> {
    const started = Date.now()
    while (Date.now() - started <= timeoutMs) {
      if (instance.inflightRequests === 0 && (Date.now() - instance.lastNetworkActivityAt) >= idleMs) {
        return
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
    throw new Error(`Wait timed out after ${timeoutMs}ms (network-idle)`)
  }

  private normalizeModifier(modifier: 'shift' | 'control' | 'alt' | 'meta'): string {
    switch (modifier) {
      case 'shift':
        return 'Shift'
      case 'control':
        return 'Control'
      case 'alt':
        return 'Alt'
      case 'meta':
        return 'Meta'
    }
  }

  private async waitForDownloads(instance: HostedBrowserInstance, timeoutMs: number): Promise<BrowserDownloadEntry[]> {
    const started = Date.now()
    const initialCount = instance.downloads.length
    while (Date.now() - started <= timeoutMs) {
      const completed = instance.downloads.filter((entry) => entry.state !== 'started')
      if (completed.length > 0 && instance.downloads.length > initialCount) {
        return completed.slice(-20)
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return instance.downloads.slice(-20)
  }

  private async detectChallenge(instance: HostedBrowserInstance): Promise<{ detected: boolean; provider: string; signals: string[] }> {
    const signals: string[] = []
    const title = await instance.page.title().catch(() => '')
    const url = instance.page.url()

    if (/^Just a moment/i.test(title)) {
      signals.push('title:just-a-moment')
    }
    if (url.includes('/cdn-cgi/challenge-platform/')) {
      signals.push('url:cdn-cgi-challenge')
    }

    const domSignals = await instance.page.evaluate(() => {
      const hits: string[] = []
      const bodyText = (document.body?.innerText || '').slice(0, 2000)
      if (/Verify you are human/i.test(bodyText)) hits.push('text:verify-human')
      if (/Checking (if the site connection is secure|your browser)/i.test(bodyText)) hits.push('text:checking-browser')
      if (/Performing security verification/i.test(bodyText)) hits.push('text:security-verification')
      if (document.querySelector('#challenge-form')) hits.push('dom:challenge-form')
      if (document.querySelector('#turnstile-wrapper')) hits.push('dom:turnstile-wrapper')
      if (document.querySelector('.cf-turnstile')) hits.push('dom:cf-turnstile')
      if (document.querySelector('iframe[src*="challenges.cloudflare.com"]')) hits.push('dom:cf-challenge-iframe')
      return hits
    }).catch(() => [] as string[])
    signals.push(...domSignals)

    const snapshot = await this.captureSnapshot(instance).catch(() => null)
    if (snapshot) {
      const actionableRoles = new Set([
        'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch',
        'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'option', 'slider', 'spinbutton', 'listbox',
      ])
      const actionableCount = snapshot.nodes.filter((node) => actionableRoles.has((node.role || '').toLowerCase()) && !node.disabled).length
      if (snapshot.nodes.length > 0 && actionableCount <= 2) {
        signals.push(`ax:near-empty(${actionableCount}/${snapshot.nodes.length})`)
      }
    }

    const detected = signals.length > 0
    const provider = detected && signals.some((signal) => signal.includes('cf-') || signal.includes('turnstile') || signal.includes('challenge'))
      ? 'cloudflare'
      : detected ? 'unknown' : 'none'
    return { detected, provider, signals }
  }
}
