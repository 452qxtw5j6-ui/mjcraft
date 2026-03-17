import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import type { BackendConfig } from '../backend/types.ts';
import { McpClientPool } from '../../mcp/mcp-pool.ts';
import type { LoadedSource } from '../../sources/types.ts';

const actualClaudeSdk = await import('@anthropic-ai/claude-agent-sdk');

let capturedClaudeQueryOptions: Record<string, unknown> | null = null;
let capturedClaudePrompt: unknown = null;
const piSubprocessWrites: Array<Record<string, unknown>> = [];

function installModuleMocks(): void {
  mock.module('@anthropic-ai/claude-agent-sdk', () => ({
    ...actualClaudeSdk,
    query: ({ prompt, options }: { prompt: unknown; options: Record<string, unknown> }) => {
      capturedClaudePrompt = prompt;
      capturedClaudeQueryOptions = options;
      return (async function* () {})();
    },
  }));

  mock.module('node:child_process', () => ({
    spawn: () => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        stdin: {
          writable: boolean;
          write: (chunk: string) => boolean;
          end: () => void;
        };
        kill: () => boolean;
        exitCode: number | null;
        killed: boolean;
      };

      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.exitCode = null;
      child.killed = false;
      child.kill = () => {
        child.killed = true;
        return true;
      };
      child.stdin = {
        writable: true,
        write: (chunk: string) => {
          for (const line of chunk.split('\n').filter(Boolean)) {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            piSubprocessWrites.push(parsed);

            if (parsed.type === 'set_auto_compaction') {
              child.stdout.write(`${JSON.stringify({
                type: 'set_auto_compaction_result',
                id: parsed.id,
                success: true,
                enabled: parsed.enabled,
              })}\n`);
            } else if (parsed.type === 'prompt') {
              queueMicrotask(() => {
                child.emit('exit', 0, null);
              });
            }
          }
          return true;
        },
        end: () => {},
      };

      queueMicrotask(() => {
        child.stdout.write(`${JSON.stringify({
          type: 'ready',
          sessionId: 'pi-mock-session',
          callbackPort: 7777,
        })}\n`);
      });

      return child;
    },
  }));
}

function createCliLoadedSource(workspaceRootPath: string): LoadedSource {
  return {
    config: {
      id: 'googleworkspace-cli',
      name: 'googleworkspace-cli',
      slug: 'googleworkspace-cli',
      enabled: true,
      provider: 'googleworkspace-cli',
      type: 'cli',
      cli: {
        command: 'npx',
        args: ['-y', '@googleworkspace/cli'],
      },
    },
    guide: null,
    folderPath: join(workspaceRootPath, 'sources', 'googleworkspace-cli'),
    workspaceRootPath,
    workspaceId: 'ws-cli-backend-test',
  };
}

function createCliMcpConfig() {
  return {
    'googleworkspace-cli': {
      type: 'cli' as const,
      command: 'npx',
      args: ['-y', '@googleworkspace/cli'],
    },
  };
}

function createBaseConfig(provider: 'anthropic' | 'pi', workspaceRootPath: string, mcpPool: McpClientPool): BackendConfig {
  return {
    provider,
    providerType: provider,
    authType: 'api_key',
    connectionSlug: `${provider}-cli-test`,
    workspace: {
      id: 'ws-cli-backend-test',
      name: 'CLI Backend Test',
      rootPath: workspaceRootPath,
      createdAt: Date.now(),
    } as BackendConfig['workspace'],
    session: {
      id: `${provider}-session`,
      workspaceRootPath,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: workspaceRootPath,
      permissionMode: 'allow-all',
    } as BackendConfig['session'],
    model: provider === 'anthropic' ? 'claude-sonnet-4-5-20250929' : 'gpt-4o',
    isHeadless: true,
    mcpPool,
  };
}

async function createPool(workspaceRootPath: string): Promise<McpClientPool> {
  const pool = new McpClientPool({
    workspaceRootPath,
    sessionPath: join(workspaceRootPath, 'sessions', 'test-session'),
  });
  await pool.sync(createCliMcpConfig(), {});
  return pool;
}

beforeEach(() => {
  installModuleMocks();
  capturedClaudeQueryOptions = null;
  capturedClaudePrompt = null;
  piSubprocessWrites.length = 0;
});

afterEach(() => {
  mock.restore();
  capturedClaudeQueryOptions = null;
  capturedClaudePrompt = null;
  piSubprocessWrites.length = 0;
});

describe('CLI source backend recognition', () => {
  it('ClaudeAgent includes CLI source proxy server in SDK query options', async () => {
    const workspaceRootPath = '/tmp/claude-cli-backend-test';
    const pool = await createPool(workspaceRootPath);
    const { ClaudeAgent } = await import('../claude-agent.ts');

    const agent = new ClaudeAgent(createBaseConfig('anthropic', workspaceRootPath, pool));
    agent.setAllSources([createCliLoadedSource(workspaceRootPath)]);
    await agent.setSourceServers(createCliMcpConfig(), {}, ['googleworkspace-cli']);

    const events = [];
    for await (const event of agent.chat('List the available tools for the enabled source.')) {
      events.push(event);
    }

    expect(events.some(event => event.type === 'complete')).toBe(true);
    const mcpServers = capturedClaudeQueryOptions?.mcpServers as Record<string, unknown> | undefined;
    expect(mcpServers).toBeDefined();
    expect(Object.keys(mcpServers ?? {})).toContain('googleworkspace-cli');
    expect(typeof capturedClaudePrompt).toBe('string');
    expect(String(capturedClaudePrompt)).toContain('<sources>');
    expect(String(capturedClaudePrompt)).toContain('Active: googleworkspace-cli');

    agent.destroy();
  });

  it('PiAgent registers CLI source proxy tool with subprocess', async () => {
    const workspaceRootPath = '/tmp/pi-cli-backend-test';
    const pool = await createPool(workspaceRootPath);
    const { PiAgent } = await import('../pi-agent.ts');

    const agent = new PiAgent({
      ...createBaseConfig('pi', workspaceRootPath, pool),
      runtime: {
        paths: {
          node: process.execPath,
          piServer: '/tmp/fake-pi-server.js',
        },
        piAuthProvider: 'openai',
      },
    });

    agent.setAllSources([createCliLoadedSource(workspaceRootPath)]);
    await agent.setSourceServers(createCliMcpConfig(), {}, ['googleworkspace-cli']);
    await (agent as unknown as { ensureSubprocess: () => Promise<void> }).ensureSubprocess();

    const registerMessages = piSubprocessWrites.filter(msg => msg.type === 'register_tools');
    const flattenedTools = registerMessages.flatMap(msg => (msg.tools as Array<{ name: string }>) ?? []);
    expect(flattenedTools.some(tool => tool.name === 'mcp__googleworkspace-cli__run')).toBe(true);

    await (async () => {
      const chat = agent.chat('List my Google Workspace files from the connected source.');
      for await (const event of chat) {
        if (event.type === 'complete' || event.type === 'error' || event.type === 'typed_error') {
          break;
        }
      }
    })();

    const promptMessage = piSubprocessWrites.find(msg => msg.type === 'prompt');
    expect(promptMessage).toBeDefined();
    expect(String(promptMessage?.systemPrompt ?? '')).toContain('<sources>');
    expect(String(promptMessage?.systemPrompt ?? '')).toContain('Active: googleworkspace-cli');

    agent.destroy();
  });
});
