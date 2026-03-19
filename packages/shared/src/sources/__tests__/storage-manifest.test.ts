import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enableDebug } from '../../utils/debug.ts';
import { loadCliManifest } from '../storage.ts';

describe('loadCliManifest', () => {
  let workspaceRoot: string;
  let stderrOutput = '';
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-manifest-test-'));
    stderrOutput = '';
    enableDebug();
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrOutput += chunk.toString();
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = originalStderrWrite;
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test('logs and returns null for invalid manifest params', () => {
    const sourceDir = join(workspaceRoot, 'sources', 'duckdb-cli');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'manifest.json'), JSON.stringify({
      version: 1,
      operations: [
        {
          name: 'query',
          description: 'Run query',
          params: {
            sql: {
              type: 'string',
              required: true,
            },
          },
        },
      ],
    }, null, 2));

    const manifest = loadCliManifest(workspaceRoot, 'duckdb-cli');

    expect(manifest).toBeNull();
    expect(stderrOutput).toContain('Invalid manifest for duckdb-cli');
    expect(stderrOutput).toContain('must declare either position or flag');
  });

  test('logs and returns null for malformed manifest json', () => {
    const sourceDir = join(workspaceRoot, 'sources', 'duckdb-cli');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'manifest.json'), '{ invalid json');

    const manifest = loadCliManifest(workspaceRoot, 'duckdb-cli');

    expect(manifest).toBeNull();
    expect(stderrOutput).toContain('Failed to load manifest for duckdb-cli');
  });
});
