/**
 * CLI Tool Factory
 *
 * Wraps a local CLI command as an in-process MCP server so the agent can treat
 * it like a first-class source tool instead of falling back to Bash.
 */

import { spawn } from 'node:child_process';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { LoadedSource } from './types.ts';
import type { SummarizeCallback } from './api-tools.ts';
import { guardLargeResult } from '../utils/large-response.ts';
import { debug } from '../utils/debug.ts';

const DEFAULT_TIMEOUT_MS = 30_000;

// Keep this list aligned with packages/shared/src/mcp/client.ts.
const BLOCKED_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'STRIPE_SECRET_KEY',
  'NPM_TOKEN',
] as const;

interface RunCliArgs {
  argv?: string[];
  stdin?: string;
  timeoutMs?: number;
  _intent?: string;
}

function getFilteredProcessEnv(extraEnv?: Record<string, string>): Record<string, string> {
  const processEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !BLOCKED_ENV_VARS.includes(key as (typeof BLOCKED_ENV_VARS)[number])) {
      processEnv[key] = value;
    }
  }

  return {
    ...processEnv,
    ...extraEnv,
  };
}

function buildCliToolDescription(source: LoadedSource): string {
  const cli = source.config.cli;
  const command = cli?.command ?? source.config.slug;
  const fixedArgs = cli?.args?.length
    ? ` ${cli.args.join(' ')}`
    : '';

  let description =
    `Run the configured CLI for source "${source.config.slug}". ` +
    `The base command is \`${command}${fixedArgs}\`.\n\n` +
    'Pass only the additional argv tokens you want appended to the configured base command. ' +
    'Do not repeat the base command itself. ' +
    'Use `argv: ["--help"]` or a subcommand help form when you need discovery.';

  if (source.guide?.raw) {
    description += `\n\n${source.guide.raw}`;
  }

  return description;
}

function formatOutput(stdout: string, stderr: string): string {
  const trimmedStdout = stdout.trim();
  const trimmedStderr = stderr.trim();

  if (trimmedStdout && trimmedStderr) {
    return `${trimmedStdout}\n\n[stderr]\n${trimmedStderr}`;
  }
  if (trimmedStdout) return trimmedStdout;
  if (trimmedStderr) return trimmedStderr;
  return 'Command completed with no output.';
}

async function runCliCommand(
  source: LoadedSource,
  args: RunCliArgs,
  sessionPath?: string,
  summarize?: SummarizeCallback
): Promise<{ text: string; isError: boolean }> {
  const cli = source.config.cli;
  if (!cli?.command) {
    return { text: 'CLI source is missing a command.', isError: true };
  }

  const commandArgs = [...(cli.args ?? []), ...(args.argv ?? [])];
  const timeoutMs = Math.min(Math.max(args.timeoutMs ?? cli.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1000), 120_000);
  const cwd = cli.cwd ?? source.workspaceRootPath;

  debug(`[cli-tools] Running ${cli.command} ${commandArgs.join(' ')}`);

  try {
    const result = await new Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
      timedOut: boolean;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      const child = spawn(cli.command!, commandArgs, {
        cwd,
        env: getFilteredProcessEnv(cli.env),
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const killTimer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });

      child.on('error', (error) => {
        clearTimeout(killTimer);
        reject(error);
      });

      child.on('close', (code, signal) => {
        clearTimeout(killTimer);
        resolve({ code, stdout, stderr, timedOut, signal });
      });

      if (args.stdin) {
        child.stdin.write(args.stdin);
      }
      child.stdin.end();
    });

    if (result.timedOut) {
      const partial = formatOutput(result.stdout, result.stderr);
      return {
        text: `CLI command timed out after ${timeoutMs}ms.\n\n${partial}`,
        isError: true,
      };
    }

    const output = formatOutput(result.stdout, result.stderr);
    if ((result.code ?? 0) !== 0) {
      const signalNote = result.signal ? ` (signal: ${result.signal})` : '';
      return {
        text: `CLI exited with code ${result.code ?? 'unknown'}${signalNote}.\n\n${output}`,
        isError: true,
      };
    }

    if (sessionPath) {
      const guarded = await guardLargeResult(output, {
        sessionPath,
        toolName: `cli_${source.config.slug}`,
        input: { argv: args.argv, stdin: args.stdin },
        intent: args._intent,
        summarize,
      });
      if (guarded) {
        return { text: guarded, isError: false };
      }
    }

    return { text: output, isError: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      text: `CLI execution failed: ${message}`,
      isError: true,
    };
  }
}

/**
 * Create an in-process MCP server that exposes a single flexible `run` tool
 * for a configured CLI source.
 */
export function createCliServer(
  source: LoadedSource,
  sessionPath?: string,
  summarize?: SummarizeCallback
) {
  return createSdkMcpServer({
    name: `cli-source-${source.config.slug}`,
    version: '1.0.0',
    tools: [
      tool(
        'run',
        buildCliToolDescription(source),
        {
          argv: z.array(z.string()).optional().describe(
            'Additional argv tokens appended after the configured base command. Do not include the base command itself.'
          ),
          stdin: z.string().optional().describe('Optional stdin content to pipe into the command.'),
          timeoutMs: z.number().int().min(1000).max(120000).optional().describe(
            'Optional timeout override in milliseconds.'
          ),
          _intent: z.string().optional().describe(
            'Describe what you are trying to accomplish with this CLI call.'
          ),
        },
        async (args: RunCliArgs) => {
          const result = await runCliCommand(source, args, sessionPath, summarize);
          return {
            content: [{ type: 'text' as const, text: result.text }],
            ...(result.isError ? { isError: true } : {}),
          };
        }
      ),
    ],
  });
}
