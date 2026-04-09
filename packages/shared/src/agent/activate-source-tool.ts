/**
 * Activate Source Tool (activate_source)
 *
 * Session-scoped backend tool that enables an existing source for the
 * current session, then lets the backend interrupt and retry the turn
 * with the newly available source tools.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export type ActivateSourceFn = (sourceSlug: string) => Promise<boolean> | boolean;

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

export interface ActivateSourceToolOptions {
  getActivateSourceFn: () => ActivateSourceFn | undefined;
}

export function createActivateSourceTool(options: ActivateSourceToolOptions) {
  return tool(
    'activate_source',
    `Activate an existing source for the current session.

Use this when a source in \`<sources>\` is clearly relevant but inactive. After activation, the current turn should be retried so the newly available source tools can be used.`,
    {
      sourceSlug: z.string().describe('Source slug to activate for the current session'),
    },
    async (args) => {
      const activateSourceFn = options.getActivateSourceFn();
      if (!activateSourceFn) {
        return errorResponse('activate_source is not available in this context.');
      }

      const sourceSlug = args.sourceSlug as string;

      try {
        const activated = await activateSourceFn(sourceSlug);
        if (!activated) {
          return errorResponse(`Source '${sourceSlug}' could not be activated.`);
        }
        return {
          content: [{
            type: 'text',
            text: `Source '${sourceSlug}' activated for the current session. The request will be retried with the new source tools.`,
          }],
        };
      } catch (error) {
        if (error instanceof Error) {
          return errorResponse(`activate_source failed: ${error.message}`);
        }
        throw error;
      }
    }
  );
}
