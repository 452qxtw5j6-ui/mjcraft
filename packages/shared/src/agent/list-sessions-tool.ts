/**
 * List Sessions Tool (list_sessions)
 *
 * Session-scoped tool that lists available sessions in the current workspace.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { ListSessionsResult } from './base-agent.ts';

export type ListSessionsFn = (input: Record<string, unknown>) => Promise<ListSessionsResult>;

// Tool result type - matches what the SDK expects
type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

function errorResponse(message: string): ToolResult {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}

export interface ListSessionsToolOptions {
  sessionId: string;
  /**
   * Lazy resolver for the list-sessions callback.
   * Called at execution time to get the current callback from the session registry.
   */
  getListSessionsFn: () => ListSessionsFn | undefined;
}

export function createListSessionsTool(options: ListSessionsToolOptions) {
  return tool(
    'list_sessions',
    `List available sessions in the current workspace.

Use this before send_to_session when you need to discover valid targetSessionId values.

Returns session metadata including ID, name, status, and last activity time.`,
    {
      includeArchived: z.boolean().optional().default(false)
        .describe('Include archived sessions in results (default: false)'),
      limit: z.number().int().min(1).max(200).optional().default(50)
        .describe('Maximum number of sessions to return (default: 50)'),
    },
    async (args) => {
      const listSessionsFn = options.getListSessionsFn();
      if (!listSessionsFn) {
        return errorResponse('list_sessions is not available in this context.');
      }

      try {
        const result = await listSessionsFn(args as Record<string, unknown>);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        if (error instanceof Error) {
          return errorResponse(`list_sessions failed: ${error.message}`);
        }
        throw error;
      }
    }
  );
}
