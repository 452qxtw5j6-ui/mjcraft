#!/usr/bin/env bun

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { basename, dirname, join, relative, resolve } from 'path';
import matter from 'gray-matter';
import type { SkillPluginType } from '../packages/shared/src/skills/types.ts';

interface ImportOptions {
  pluginPath: string;
  workspaceRoot?: string;
  projectRoot?: string;
  convertCommands: boolean;
  dryRun: boolean;
  force: boolean;
}

interface ImportedItem {
  slug: string;
  from: string;
  to: string;
}

interface SkippedItem {
  slug: string;
  reason: string;
  path: string;
}

interface ConnectorSummary {
  name: string;
  type: string;
  url?: string;
}

interface ImportReport {
  plugin: {
    slug: string;
    path: string;
  };
  target: {
    mode: 'workspace' | 'project';
    root: string;
    skillsDir: string;
  };
  importedSkills: ImportedItem[];
  importedCommandWrappers: ImportedItem[];
  skipped: SkippedItem[];
  commandMap: Record<string, string>;
  connectors: ConnectorSummary[];
  generatedAt: string;
}

interface PluginAnnotation {
  plugin: string;
  pluginLabel: string;
  pluginType: SkillPluginType;
  pluginCommand?: string;
}

interface PluginIdentity {
  slug: string;
  label: string;
}

function printUsage(): void {
  console.log(`
Usage:
  bun run scripts/import-knowledge-work-plugin.ts \\
    --plugin <path-to-plugin-dir> \\
    [--workspace-root <workspace-root> | --project-root <project-root>] \\
    [--convert-commands] [--dry-run] [--force]

Examples:
  bun run scripts/import-knowledge-work-plugin.ts \\
    --plugin /tmp/knowledge-work-plugins/data \\
    --project-root /Users/me/dev/my-project \\
    --convert-commands

  bun run scripts/import-knowledge-work-plugin.ts \\
    --plugin /tmp/knowledge-work-plugins/data \\
    --workspace-root ~/.craft-agent/workspaces/my-workspace \\
    --dry-run
`);
}

function parseArgs(argv: string[]): ImportOptions {
  const options: ImportOptions = {
    pluginPath: '',
    convertCommands: false,
    dryRun: false,
    force: false,
  };

  const valueFlags = {
    '--plugin': 'pluginPath',
    '--workspace-root': 'workspaceRoot',
    '--project-root': 'projectRoot',
  } as const;
  const booleanFlags = {
    '--convert-commands': 'convertCommands',
    '--dry-run': 'dryRun',
    '--force': 'force',
  } as const;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }

    const valueFlag = valueFlags[arg as keyof typeof valueFlags];
    if (valueFlag) {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for ${arg}`);
      }
      (options as Record<string, unknown>)[valueFlag] = value;
      i += 1;
      continue;
    }

    const boolFlag = booleanFlags[arg as keyof typeof booleanFlags];
    if (boolFlag) {
      (options as Record<string, unknown>)[boolFlag] = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.pluginPath) {
    throw new Error('--plugin is required');
  }

  if (Boolean(options.workspaceRoot) === Boolean(options.projectRoot)) {
    throw new Error('Choose exactly one target: --workspace-root or --project-root');
  }

  return options;
}

function assertDir(path: string, name: string): void {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error(`${name} does not exist or is not a directory: ${path}`);
  }
}

function readJsonSafe<T>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function listSubdirs(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);
}

function ensureDir(path: string, dryRun: boolean): void {
  if (dryRun) return;
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

function copyDir(source: string, target: string, force: boolean, dryRun: boolean): void {
  if (dryRun) return;

  if (force && existsSync(target)) {
    rmSync(target, { recursive: true, force: true });
  }

  cpSync(source, target, {
    recursive: true,
    force,
    errorOnExist: !force,
  });
}

function toPluginLabel(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function normalizePluginSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildPluginFrontmatter(annotation: PluginAnnotation): Record<string, string> {
  const data: Record<string, string> = {
    plugin: annotation.plugin,
    pluginLabel: annotation.pluginLabel,
    pluginType: annotation.pluginType,
  };
  if (annotation.pluginCommand) {
    data.pluginCommand = annotation.pluginCommand;
  }
  return data;
}

function looksLikeSemverSegment(value: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value);
}

function resolvePluginIdentity(pluginPath: string): PluginIdentity {
  const manifestPath = join(pluginPath, '.claude-plugin', 'plugin.json');
  const manifest = readJsonSafe<{ name?: string; displayName?: string }>(manifestPath);
  if (manifest) {
    const manifestName = typeof manifest.name === 'string' ? manifest.name.trim() : '';
    const manifestDisplayName = typeof manifest.displayName === 'string'
      ? manifest.displayName.trim()
      : '';

    const slug = normalizePluginSlug(manifestName);
    if (slug) {
      return {
        slug,
        label: manifestDisplayName || toPluginLabel(slug),
      };
    }
  }

  const pathName = basename(pluginPath);
  const fallbackRaw = looksLikeSemverSegment(pathName)
    ? basename(dirname(pluginPath))
    : pathName;
  const slug = normalizePluginSlug(fallbackRaw);

  if (!slug) {
    throw new Error(`Unable to infer plugin slug from path: ${pluginPath}`);
  }

  return {
    slug,
    label: toPluginLabel(slug),
  };
}

function annotateSkillFrontmatter(skillFilePath: string, annotation: PluginAnnotation, dryRun: boolean): void {
  if (dryRun) return;
  const raw = readFileSync(skillFilePath, 'utf-8');
  const parsed = matter(raw);
  parsed.data = {
    ...parsed.data,
    ...buildPluginFrontmatter(annotation),
  };
  if (!annotation.pluginCommand) delete parsed.data.pluginCommand;

  writeFileSync(skillFilePath, matter.stringify(parsed.content, parsed.data), 'utf-8');
}

function createCommandWrapperSkill(
  pluginSlug: string,
  pluginLabel: string,
  commandSlug: string,
  commandMarkdownPath: string,
  sourceBody: string,
  commandDescription: string,
  argumentHint?: string,
): string {
  const description = commandDescription || `Claude Cowork /${commandSlug} command wrapper`;
  const frontmatter = {
    name: `${pluginSlug} /${commandSlug}`,
    description,
    ...buildPluginFrontmatter({
      plugin: pluginSlug,
      pluginLabel,
      pluginType: 'command',
      pluginCommand: commandSlug,
    }),
  };

  const usageLines = [
    `# ${pluginSlug} Command Wrapper: /${commandSlug}`,
    '',
    `Original command file: ${commandMarkdownPath}`,
    '',
    'Use this as a Craft Agent skill wrapper for the original Claude Cowork command.',
    'When invoked, treat the text after the skill mention as the command argument and follow the workflow below.',
    argumentHint ? `Original argument hint: ${argumentHint}` : 'Original argument hint: (none)',
    '',
    '## Original Command Content',
    '',
  ].join('\n');

  return matter.stringify(`${usageLines}${sourceBody.trim()}\n`, frontmatter);
}

function loadConnectors(pluginPath: string): ConnectorSummary[] {
  const mcpPath = join(pluginPath, '.mcp.json');
  const parsed = readJsonSafe<{
    mcpServers?: Record<string, { type?: string; url?: string }>;
  }>(mcpPath);
  if (!parsed?.mcpServers || typeof parsed.mcpServers !== 'object') return [];

  return Object.entries(parsed.mcpServers).map(([name, config]) => ({
    name,
    type: config?.type || 'unknown',
    url: config?.url,
  }));
}

function writeImportArtifacts(report: ImportReport, targetMetaDir: string, dryRun: boolean): void {
  const commandMapMd = [
    '# Knowledge Work Plugin Command Map',
    '',
    `- Plugin: ${report.plugin.slug}`,
    `- Source: ${report.plugin.path}`,
    `- Target: ${report.target.skillsDir}`,
    `- Generated: ${report.generatedAt}`,
    '',
    '## Slash Command -> Craft Skill Wrapper',
    '',
    ...Object.entries(report.commandMap).map(([command, skill]) => `- /${command} -> [skill:${skill}]`),
    '',
    '## Connectors (.mcp.json)',
    '',
    ...(report.connectors.length > 0
      ? report.connectors.map(conn => `- ${conn.name}: type=${conn.type}${conn.url ? `, url=${conn.url}` : ''}`)
      : ['- (none)']),
    '',
  ].join('\n');

  if (dryRun) {
    console.log(`[dry-run] Would write report artifacts to ${targetMetaDir}`);
    return;
  }

  ensureDir(targetMetaDir, false);
  writeFileSync(join(targetMetaDir, 'import-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  writeFileSync(join(targetMetaDir, 'command-map.md'), `${commandMapMd}\n`, 'utf-8');
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));

  const pluginPath = resolve(options.pluginPath);
  assertDir(pluginPath, 'Plugin path');

  const { slug: pluginSlug, label: pluginLabel } = resolvePluginIdentity(pluginPath);

  const workspaceRoot = options.workspaceRoot ? resolve(options.workspaceRoot) : undefined;
  const projectRoot = options.projectRoot ? resolve(options.projectRoot) : undefined;

  if (workspaceRoot) {
    assertDir(workspaceRoot, 'Workspace root');
  }
  if (projectRoot) {
    assertDir(projectRoot, 'Project root');
  }

  const skillsSourceDir = join(pluginPath, 'skills');
  assertDir(skillsSourceDir, 'Plugin skills directory');

  const commandsSourceDir = join(pluginPath, 'commands');

  const targetRoot = workspaceRoot || projectRoot!;
  const targetMode: 'workspace' | 'project' = workspaceRoot ? 'workspace' : 'project';
  const targetSkillsDir = workspaceRoot
    ? join(workspaceRoot, 'skills')
    : join(projectRoot!, '.agents', 'skills');

  ensureDir(targetSkillsDir, options.dryRun);

  const importedSkills: ImportedItem[] = [];
  const importedCommandWrappers: ImportedItem[] = [];
  const skipped: SkippedItem[] = [];
  const commandMap: Record<string, string> = {};

  // 1) Import native skills
  for (const skillSlug of listSubdirs(skillsSourceDir)) {
    const sourceSkillDir = join(skillsSourceDir, skillSlug);
    const sourceSkillFile = join(sourceSkillDir, 'SKILL.md');

    if (!existsSync(sourceSkillFile)) {
      skipped.push({
        slug: skillSlug,
        reason: 'Missing SKILL.md in source skill folder',
        path: sourceSkillDir,
      });
      continue;
    }

    const targetSkillDir = join(targetSkillsDir, skillSlug);

    if (existsSync(targetSkillDir) && !options.force) {
      skipped.push({
        slug: skillSlug,
        reason: 'Target skill already exists (use --force to overwrite)',
        path: targetSkillDir,
      });
      continue;
    }

    copyDir(sourceSkillDir, targetSkillDir, options.force, options.dryRun);
    const copiedSkillFile = join(targetSkillDir, 'SKILL.md');
    annotateSkillFrontmatter(copiedSkillFile, {
      plugin: pluginSlug,
      pluginLabel,
      pluginType: 'skill',
    }, options.dryRun);

    importedSkills.push({
      slug: skillSlug,
      from: sourceSkillDir,
      to: targetSkillDir,
    });
  }

  // 2) Convert commands/*.md to wrapper skills
  if (options.convertCommands && existsSync(commandsSourceDir)) {
    const commandFiles = readdirSync(commandsSourceDir, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
      .map(entry => entry.name)
      .sort((a, b) => a.localeCompare(b));

    for (const commandFile of commandFiles) {
      const commandSlug = commandFile.replace(/\.md$/, '');
      const wrapperSkillSlug = `kwp-${pluginSlug}-${commandSlug}`;
      const sourceCommandPath = join(commandsSourceDir, commandFile);
      const targetSkillDir = join(targetSkillsDir, wrapperSkillSlug);
      const targetSkillFile = join(targetSkillDir, 'SKILL.md');

      if (existsSync(targetSkillDir) && !options.force) {
        skipped.push({
          slug: wrapperSkillSlug,
          reason: 'Target command wrapper skill already exists (use --force to overwrite)',
          path: targetSkillDir,
        });
        continue;
      }

      const commandRaw = readFileSync(sourceCommandPath, 'utf-8');
      const parsed = matter(commandRaw);
      const description = typeof parsed.data.description === 'string' ? parsed.data.description : '';
      const argumentHint = typeof parsed.data['argument-hint'] === 'string'
        ? parsed.data['argument-hint']
        : undefined;

      const wrappedContent = createCommandWrapperSkill(
        pluginSlug,
        pluginLabel,
        commandSlug,
        sourceCommandPath,
        parsed.content,
        description,
        argumentHint,
      );

      if (!options.dryRun) {
        ensureDir(targetSkillDir, false);
        writeFileSync(targetSkillFile, wrappedContent, 'utf-8');
      }

      importedCommandWrappers.push({
        slug: wrapperSkillSlug,
        from: sourceCommandPath,
        to: targetSkillFile,
      });
      commandMap[commandSlug] = wrapperSkillSlug;
    }
  }

  const connectors = loadConnectors(pluginPath);

  const report: ImportReport = {
    plugin: {
      slug: pluginSlug,
      path: pluginPath,
    },
    target: {
      mode: targetMode,
      root: targetRoot,
      skillsDir: targetSkillsDir,
    },
    importedSkills,
    importedCommandWrappers,
    skipped,
    commandMap,
    connectors,
    generatedAt: new Date().toISOString(),
  };

  const targetMetaDir = targetMode === 'project'
    ? join(projectRoot!, '.agents', '.knowledge-work-plugins', pluginSlug)
    : join(workspaceRoot!, '.knowledge-work-plugins', pluginSlug);

  writeImportArtifacts(report, targetMetaDir, options.dryRun);

  const rel = (p: string) => relative(process.cwd(), p) || p;

  console.log('\n=== Knowledge Work Plugin Import Summary ===');
  console.log(`Plugin: ${pluginSlug}`);
  console.log(`Source: ${pluginPath}`);
  console.log(`Target mode: ${targetMode}`);
  console.log(`Skills target: ${targetSkillsDir}`);
  console.log(`Imported skills: ${importedSkills.length}`);
  console.log(`Imported command wrappers: ${importedCommandWrappers.length}`);
  console.log(`Skipped: ${skipped.length}`);

  if (Object.keys(commandMap).length > 0) {
    console.log('\nSlash command mapping:');
    for (const [command, skill] of Object.entries(commandMap)) {
      console.log(`  /${command} -> [skill:${skill}]`);
    }
  }

  if (connectors.length > 0) {
    console.log('\nConnectors from .mcp.json:');
    for (const conn of connectors) {
      console.log(`  - ${conn.name}: type=${conn.type}${conn.url ? `, url=${conn.url}` : ''}`);
    }
  }

  if (skipped.length > 0) {
    console.log('\nSkipped items:');
    for (const item of skipped) {
      console.log(`  - ${item.slug}: ${item.reason} (${item.path})`);
    }
  }

  console.log(`\nReport path: ${rel(join(targetMetaDir, 'import-report.json'))}`);
  console.log(`Command map path: ${rel(join(targetMetaDir, 'command-map.md'))}`);
  console.log('\nDone.');
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  printUsage();
  process.exit(1);
}
