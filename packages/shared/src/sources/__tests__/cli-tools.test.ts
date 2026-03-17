import { describe, test, expect } from 'bun:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ApiSourcePoolClient } from '../../mcp/api-source-pool-client.ts';
import { createCliServer } from '../cli-tools.ts';
import type { LoadedSource } from '../types.ts';

function createCliSource(): LoadedSource {
  return {
    config: {
      id: 'gws-test',
      slug: 'gws-test',
      name: 'GWS Test',
      enabled: true,
      provider: 'googleworkspace-cli',
      type: 'cli',
      cli: {
        command: 'python3',
        args: ['-c', 'import json,sys; print(json.dumps(sys.argv[1:]))'],
      },
    },
    guide: null,
    folderPath: '/tmp/gws-test',
    workspaceRootPath: '/tmp',
    workspaceId: 'test-workspace',
  };
}

describe('createCliServer', () => {
  test('exposes a run tool and executes argv against the configured base command', async () => {
    const server = createCliServer(createCliSource());
    const client = new ApiSourcePoolClient(server.instance as McpServer);

    try {
      const tools = await client.listTools();
      expect(tools.map(tool => tool.name)).toContain('run');

      const result = await client.callTool('run', { argv: ['alpha', 'beta'] }) as {
        content?: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };

      expect(result.isError).toBeFalsy();
      const text = result.content?.find(block => block.type === 'text')?.text;
      expect(text).toBe('["alpha", "beta"]');
    } finally {
      await client.close();
    }
  });
});
