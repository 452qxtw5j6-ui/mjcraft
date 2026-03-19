import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { validatePersona } from '@craft-agent/shared/config'
import { loadWorkspacePersonas } from '@craft-agent/shared/personas'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.personas.LIST,
] as const

export function registerPersonasHandlers(server: RpcServer, deps: HandlerDeps): void {
  server.handle(RPC_CHANNELS.personas.LIST, async (_ctx, workspaceId: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) {
      deps.platform.logger?.error(`PERSONAS_LIST: Workspace not found: ${workspaceId}`)
      return []
    }

    return loadWorkspacePersonas(workspace.rootPath).filter((persona) =>
      persona.source === 'builtin' || validatePersona(workspace.rootPath, persona.id).valid,
    )
  })
}
