import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleSourceTest } from './source-test.ts';
import type { SourceConfig } from '../types.ts';

function createCtx(workspacePath: string, source: SourceConfig) {
  return {
    sessionId: 'test-session',
    workspacePath,
    get sourcesPath() { return join(workspacePath, 'sources'); },
    get skillsPath() { return join(workspacePath, 'skills'); },
    plansFolderPath: join(workspacePath, 'plans'),
    callbacks: {
      onPlanSubmitted: () => {},
      onAuthRequest: () => {},
    },
    fs: {
      exists: (path: string) => existsSync(path),
      readFile: (path: string) => readFileSync(path, 'utf-8'),
      readFileBuffer: (path: string) => readFileSync(path),
      writeFile: (path: string, content: string) => writeFileSync(path, content),
      isDirectory: (path: string) => existsSync(path) && statSync(path).isDirectory(),
      readdir: (path: string) => readdirSync(path),
      stat: (path: string) => {
        const s = statSync(path);
        return { size: s.size, isDirectory: () => s.isDirectory() };
      },
    },
    validators: undefined,
    loadSourceConfig: (slug: string) => slug === source.slug ? source : null,
  } as const;
}

describe('source_test for CLI sources', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'source-test-cli-'));
    mkdirSync(join(tempDir, 'sources', 'duckdb-cli'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('does not report cli as an invalid source type', async () => {
    const source: SourceConfig = {
      id: 'duckdb-cli_test',
      name: 'DuckDB CLI',
      slug: 'duckdb-cli',
      enabled: true,
      provider: 'duckdb',
      type: 'cli',
      cli: {
        command: 'python3',
        args: ['duckdb_safe.py'],
        timeoutMs: 60000,
      },
      tagline: 'DuckDB CLI',
      connectionStatus: 'connected',
    };

    writeFileSync(
      join(tempDir, 'sources', 'duckdb-cli', 'config.json'),
      JSON.stringify(source, null, 2),
    );
    writeFileSync(
      join(tempDir, 'sources', 'duckdb-cli', 'guide.md'),
      '# DuckDB CLI\n\nGuide text.',
    );
    writeFileSync(join(tempDir, 'sources', 'duckdb-cli', 'icon.png'), 'fake');

    const result = await handleSourceTest(createCtx(tempDir, source), { sourceSlug: 'duckdb-cli' });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('Config schema valid');
    expect(text).not.toContain('Invalid type: cli');
  });
});
