/**
 * CLI Tool Factory
 *
 * Wraps a local CLI command as an in-process MCP server so the agent can treat
 * it like a first-class source tool instead of falling back to Bash.
 */

import { spawn } from 'node:child_process';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { CliManifestOperation, CliManifestParam, LoadedSource } from './types.ts';
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

function buildCliRunDescription(source: LoadedSource): string {
  const cli = source.config.cli;
  const command = cli?.command ?? source.config.slug;
  const fixedArgs = cli?.args?.length
    ? ` ${cli.args.join(' ')}`
    : '';

  let description =
    `Run the configured CLI for source "${source.config.slug}". ` +
    `The base command is \`${command}${fixedArgs}\`.\n\n` +
    'Pass only the additional argv tokens you want appended to the configured base command. ' +
    'Do not repeat the base command itself.';

  if (source.manifest?.operations.length) {
    description += ' Prefer the structured tools for common operations. Use `help` for the full CLI guide before advanced or uncommon commands.';
    if (source.manifest.capabilitiesHint?.length) {
      description += `\n\nAdditional capabilities available via fallback run: ${source.manifest.capabilitiesHint.join(', ')}.`;
    }
  } else if (source.guide?.raw) {
    description += '\n\nUse `help` to read the full guide before exploring unfamiliar commands.';
  }

  return description;
}

function buildCliHelpDescription(source: LoadedSource): string {
  return `Show the full guide for CLI source "${source.config.slug}". Use this when you need examples, edge cases, or advanced command coverage.`;
}

function buildManifestToolDescription(source: LoadedSource, operation: CliManifestOperation): string {
  let description = operation.description;
  if (source.guide?.raw) {
    description += ' Use `help` if you need the full CLI guide.';
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

function getManifestParamValue(
  args: Record<string, unknown>,
  paramName: string,
  param: CliManifestParam
): string | number | boolean | string[] | undefined {
  const value = args[paramName];
  return value === undefined ? param.default : value as string | number | boolean | string[] | undefined;
}

function buildArgvFromOperation(operation: CliManifestOperation, args: Record<string, unknown>): string[] {
  const argv = [...(operation.args ?? [])];
  const entries = Object.entries(operation.params ?? {});

  const positionalParams = entries
    .filter(([, param]) => param.position !== undefined)
    .sort((a, b) => (a[1].position ?? 0) - (b[1].position ?? 0));
  const optionParams = entries.filter(([, param]) => param.position === undefined);

  for (const [paramName, param] of positionalParams) {
    const value = getManifestParamValue(args, paramName, param);
    if (value === undefined) {
      if (param.required) {
        throw new Error(`Missing required parameter: ${paramName}`);
      }
      continue;
    }

    if (param.type === 'boolean' || param.type === 'string[]') {
      throw new Error(`Positional parameter ${paramName} must be string or number typed`);
    }

    argv.push(String(value));
  }

  for (const [paramName, param] of optionParams) {
    const value = getManifestParamValue(args, paramName, param);
    if (value === undefined) {
      if (param.required) {
        throw new Error(`Missing required parameter: ${paramName}`);
      }
      continue;
    }

    if (!param.flag) {
      throw new Error(`Manifest parameter ${paramName} must declare a flag or position`);
    }

    if (param.type === 'boolean') {
      if (value === true) {
        argv.push(param.flag);
      }
      continue;
    }

    if (param.type === 'string[]') {
      for (const item of value as string[]) {
        argv.push(param.flag, item);
      }
      continue;
    }

    argv.push(param.flag, String(value));
  }

  return argv;
}

function buildManifestParamSchema(paramName: string, param: CliManifestParam): z.ZodTypeAny {
  let schema: z.ZodTypeAny;

  switch (param.type) {
    case 'number':
      schema = z.number();
      break;
    case 'boolean':
      schema = z.boolean();
      break;
    case 'string[]':
      schema = z.array(z.string());
      break;
    case 'string':
    default:
      schema = z.string();
      if (param.enum?.length) {
        schema = schema.refine((value) => param.enum!.includes(value), {
          message: `${paramName} must be one of: ${param.enum.join(', ')}`,
        });
      }
      break;
  }

  if (param.description) {
    schema = schema.describe(param.description);
  }

  return param.required ? schema : schema.optional();
}

function buildManifestTool(
  source: LoadedSource,
  operation: CliManifestOperation,
  sessionPath?: string,
  summarize?: SummarizeCallback
) {
  const schemaShape: Record<string, z.ZodTypeAny> = {};

  for (const [paramName, param] of Object.entries(operation.params ?? {})) {
    schemaShape[paramName] = buildManifestParamSchema(paramName, param);
  }

  schemaShape.timeoutMs = z.number().int().min(1000).max(120000).optional().describe(
    'Optional timeout override in milliseconds.'
  );
  schemaShape._intent = z.string().optional().describe(
    'Describe what you are trying to accomplish with this CLI call.'
  );

  return tool(
    operation.name,
    buildManifestToolDescription(source, operation),
    schemaShape,
    async (args: Record<string, unknown>) => {
      let argv: string[];

      try {
        argv = buildArgvFromOperation(operation, args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Invalid manifest operation arguments: ${message}` }],
          isError: true,
        };
      }

      const result = await runCliCommand(
        source,
        {
          argv,
          timeoutMs: (args.timeoutMs as number | undefined) ?? operation.timeoutMs,
          _intent: args._intent as string | undefined,
        },
        sessionPath,
        summarize
      );

      return {
        content: [{ type: 'text' as const, text: result.text }],
        ...(result.isError ? { isError: true } : {}),
      };
    }
  );
}

function buildHelpTool(source: LoadedSource) {
  return tool(
    'help',
    buildCliHelpDescription(source),
    {},
    async () => ({
      content: [{
        type: 'text' as const,
        text: source.guide?.raw ?? `No guide.md is configured for CLI source "${source.config.slug}".`,
      }],
    })
  );
}

/**
 * Create an in-process MCP server for a configured CLI source.
 * Manifest-backed CLI sources expose structured tools plus `help` and `run`.
 * Legacy CLI sources expose `help` and the flexible fallback `run` tool.
 */
export function createCliServer(
  source: LoadedSource,
  sessionPath?: string,
  summarize?: SummarizeCallback
) {
  const manifestTools = source.manifest?.operations.map((operation) =>
    buildManifestTool(source, operation, sessionPath, summarize)
  ) ?? [];

  return createSdkMcpServer({
    name: `cli-source-${source.config.slug}`,
    version: '1.0.0',
    tools: [
      ...manifestTools,
      buildHelpTool(source),
      tool(
        'run',
        buildCliRunDescription(source),
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
