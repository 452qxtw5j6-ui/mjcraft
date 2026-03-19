import { describe, test, expect } from 'bun:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ApiSourcePoolClient } from '../../mcp/api-source-pool-client.ts';
import { createCliServer } from '../cli-tools.ts';
import type { LoadedSource } from '../types.ts';

function createCliSource(overrides: Partial<LoadedSource> = {}): LoadedSource {
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
    manifest: null,
    folderPath: '/tmp/gws-test',
    workspaceRootPath: '/tmp',
    workspaceId: 'test-workspace',
    ...overrides,
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
      ...(overrides.config ?? {}),
    },
  };
}

describe('createCliServer', () => {
  test('exposes legacy run and help tools', async () => {
    const server = createCliServer(createCliSource({
      guide: { raw: '# Test CLI\n\nUse carefully.' },
    }));
    const client = new ApiSourcePoolClient(server.instance as McpServer);

    try {
      const tools = await client.listTools();
      expect(tools.map(tool => tool.name)).toEqual(['help', 'run']);
      expect(tools.find(tool => tool.name === 'run')?.description).not.toContain('Use carefully.');

      const helpResult = await client.callTool('help', {}) as {
        content?: Array<{ type: string; text?: string }>;
      };

      const helpText = helpResult.content?.find(block => block.type === 'text')?.text;
      expect(helpText).toContain('Use carefully.');
    } finally {
      await client.close();
    }
  });

  test('executes argv against the configured base command in legacy run mode', async () => {
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

  test('exposes manifest-backed tools and builds argv from structured params', async () => {
    const server = createCliServer(createCliSource({
      config: {
        id: 'duckdb-cli',
        slug: 'duckdb-cli',
        name: 'DuckDB CLI',
        enabled: true,
        provider: 'duckdb',
        type: 'cli',
        cli: {
          command: 'python3',
          args: ['-c', 'import json,sys; print(json.dumps(sys.argv[1:]))'],
        },
      },
      guide: { raw: '# DuckDB CLI\n\nFull guide.' },
      manifest: {
        version: 1,
        capabilitiesHint: ['export parquet', 'write queries'],
        operations: [
          {
            name: 'query',
            description: 'Run a SELECT query.',
            args: ['query'],
            params: {
              sql: {
                type: 'string',
                required: true,
                description: 'SELECT query text',
                flag: '--sql',
              },
              limit: {
                type: 'number',
                description: 'Row limit',
                flag: '--limit',
              },
            },
          },
          {
            name: 'tables',
            description: 'List tables.',
            args: ['tables'],
            params: {
              no_views: {
                type: 'boolean',
                description: 'Exclude views',
                flag: '--no-views',
              },
            },
          },
        ],
      },
    }));
    const client = new ApiSourcePoolClient(server.instance as McpServer);

    try {
      const tools = await client.listTools();
      expect(tools.map(tool => tool.name)).toEqual(['query', 'tables', 'help', 'run']);

      const queryResult = await client.callTool('query', {
        sql: 'select 1',
        limit: 25,
      }) as {
        content?: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };

      expect(queryResult.isError).toBeFalsy();
      const queryText = queryResult.content?.find(block => block.type === 'text')?.text;
      expect(queryText).toBe('["query", "--sql", "select 1", "--limit", "25"]');

      const tablesResult = await client.callTool('tables', { no_views: true }) as {
        content?: Array<{ type: string; text?: string }>;
      };

      const tablesText = tablesResult.content?.find(block => block.type === 'text')?.text;
      expect(tablesText).toBe('["tables", "--no-views"]');
    } finally {
      await client.close();
    }
  });
});
