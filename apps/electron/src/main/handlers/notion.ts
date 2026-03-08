import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from './handler-deps'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.notion.TRIGGER_POLL_NOW,
] as const

export function registerNotionHandlers(server: RpcServer, deps: HandlerDeps): void {
  server.handle(RPC_CHANNELS.notion.TRIGGER_POLL_NOW, async () => {
    const notionTaskService = deps.notionTaskService
    if (!notionTaskService) {
      return { success: false, queued: false, reason: 'service_unavailable' as const }
    }

    return notionTaskService.forcePollNow()
  })
}
