/**
 * Send To Session Tool (send_to_session)
 *
 * Session-scoped tool that sends a message to another session and optionally
 * waits for that session's assistant response.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { SendToSessionResult } from './base-agent.ts';

export type SendToSessionFn = (input: Record<string, unknown>) => Promise<SendToSessionResult>;

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

export interface SendToSessionToolOptions {
  sessionId: string;
  /**
   * Lazy resolver for the send-to-session callback.
   * Called at execution time to get the current callback from the session registry.
   */
  getSendToSessionFn: () => SendToSessionFn | undefined;
}

export function createSendToSessionTool(options: SendToSessionToolOptions) {
  return tool(
    'send_to_session',
    `Send a message to another session and optionally wait for a response.

Use this when you need a different session to continue work, gather context, or answer a focused question.

The target session must be in the same workspace.
If waitForResponse=true, this tool waits until the target session returns an assistant response.

Attachments must be absolute file paths on disk.`,
    {
      targetSessionId: z.string().describe('Target session ID to receive the message'),
      message: z.string().describe('Message to send to the target session'),
      attachments: z.array(z.object({
        path: z.string().describe('Absolute file path on disk'),
        name: z.string().optional().describe('Display name (defaults to file basename)'),
      })).optional().describe('Files to include with the message'),
      waitForResponse: z.boolean().optional().default(false)
        .describe('Wait for the target session assistant response before returning'),
    },
    async (args) => {
      const sendToSessionFn = options.getSendToSessionFn();
      if (!sendToSessionFn) {
        return errorResponse('send_to_session is not available in this context.');
      }

      try {
        const result = await sendToSessionFn(args as Record<string, unknown>);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        if (error instanceof Error) {
          return errorResponse(`send_to_session failed: ${error.message}`);
        }
        throw error;
      }
    }
  );
}
