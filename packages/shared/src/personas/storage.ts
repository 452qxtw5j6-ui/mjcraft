/**
 * Persona Storage
 *
 * Workspace-scoped role packages stored at {workspaceRoot}/personas/{id}/
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'fs'
import { join, normalize } from 'path'
import {
  AUTHOR_PERSONA_ID,
  PERSONA_SCHEMA_VERSION,
  SEO_PERSONA_ID,
  type LoadedPersona,
  type PersonaConfig,
} from './types.ts'

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const normalized = Array.from(new Set(value.filter(isNonEmptyString).map((entry) => entry.trim())))
  return normalized.length > 0 ? normalized : undefined
}

function parsePersonaConfig(raw: unknown): PersonaConfig | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  if (!isNonEmptyString(value.id)) return null
  if (!isNonEmptyString(value.name)) return null
  if (typeof value.injectPrompt !== 'boolean') return null
  if (!isNonEmptyString(value.personaPromptFile)) return null

  return {
    version: typeof value.version === 'number' ? value.version : PERSONA_SCHEMA_VERSION,
    id: value.id.trim(),
    name: value.name.trim(),
    injectPrompt: value.injectPrompt,
    personaPromptFile: value.personaPromptFile.trim(),
    linkedLabelId: isNonEmptyString(value.linkedLabelId) ? value.linkedLabelId.trim() : undefined,
    primarySkill: isNonEmptyString(value.primarySkill) ? value.primarySkill.trim() : undefined,
    visibleSkills: normalizeStringArray(value.visibleSkills),
    defaultSkills: normalizeStringArray(value.defaultSkills),
    visibleSources: normalizeStringArray(value.visibleSources),
    defaultSources: normalizeStringArray(value.defaultSources),
  }
}

function getAuthorPersona(): LoadedPersona {
  return {
    id: AUTHOR_PERSONA_ID,
    name: 'Author',
    source: 'builtin',
    config: {
      version: PERSONA_SCHEMA_VERSION,
      id: AUTHOR_PERSONA_ID,
      name: 'Author',
      injectPrompt: false,
      personaPromptFile: 'persona.md',
    },
    readmeContent: '# Author Persona\n\nBuilt-in default persona. No explicit persona prompt is injected.\n',
  }
}

const SEO_PERSONA_JSON = {
  version: PERSONA_SCHEMA_VERSION,
  id: SEO_PERSONA_ID,
  name: 'SEO',
  injectPrompt: true,
  personaPromptFile: 'persona.md',
  visibleSkills: [],
  defaultSkills: [],
  visibleSources: [],
  defaultSources: [],
} as const satisfies PersonaConfig

const SEO_PERSONA_PROMPT = `# SEO Persona

## Core Lens
- Optimize for search intent clarity and useful information density.
- Prefer accurate, evidence-based recommendations over generic SEO cliches.

## Priorities
1. Search intent match
2. Topic coverage
3. Clarity and structure
4. Sustainable recommendations

## Boundaries
- Do not invent rankings, traffic, or performance data.
- Ask for missing business context when it materially affects the recommendation.
`

const SEO_PERSONA_README = `# SEO Persona

Starter SEO persona for focused search optimization work.

- Minimal initial prompt
- No default skills yet
- No default sources yet

This persona is intended to be refined over time.
`

export function ensurePersonasDir(workspaceRootPath: string): string {
  const personasDir = join(workspaceRootPath, 'personas')
  if (!existsSync(personasDir)) {
    mkdirSync(personasDir, { recursive: true })
  }
  return personasDir
}

export function getPersonaPath(workspaceRootPath: string, personaId: string): string {
  return join(ensurePersonasDir(workspaceRootPath), personaId)
}

export function ensureDefaultPersonas(workspaceRootPath: string): void {
  const personasDir = ensurePersonasDir(workspaceRootPath)
  const seoDir = join(personasDir, SEO_PERSONA_ID)
  if (!existsSync(seoDir)) {
    mkdirSync(seoDir, { recursive: true })
  }

  const personaJsonPath = join(seoDir, 'persona.json')
  if (!existsSync(personaJsonPath)) {
    writeFileSync(personaJsonPath, `${JSON.stringify(SEO_PERSONA_JSON, null, 2)}\n`, 'utf-8')
  }

  const personaPromptPath = join(seoDir, 'persona.md')
  if (!existsSync(personaPromptPath)) {
    writeFileSync(personaPromptPath, SEO_PERSONA_PROMPT, 'utf-8')
  }

  const readmePath = join(seoDir, 'README.md')
  if (!existsSync(readmePath)) {
    writeFileSync(readmePath, SEO_PERSONA_README, 'utf-8')
  }
}

function loadPersonaFromDir(personasDir: string, personaId: string): LoadedPersona | null {
  const personaDir = join(personasDir, personaId)
  if (!existsSync(personaDir) || !statSync(personaDir).isDirectory()) {
    return null
  }

  const personaConfigPath = join(personaDir, 'persona.json')
  if (!existsSync(personaConfigPath)) return null

  try {
    const parsed = JSON.parse(readFileSync(personaConfigPath, 'utf-8')) as unknown
    const config = parsePersonaConfig(parsed)
    if (!config) return null

    const personaPromptPath = join(personaDir, config.personaPromptFile)
    const readmePath = join(personaDir, 'README.md')

    return {
      id: config.id,
      name: config.name,
      config,
      source: 'workspace',
      folderPath: personaDir,
      promptContent: existsSync(personaPromptPath) ? readFileSync(personaPromptPath, 'utf-8') : undefined,
      readmeContent: existsSync(readmePath) ? readFileSync(readmePath, 'utf-8') : undefined,
    }
  } catch {
    return null
  }
}

export function loadPersona(workspaceRootPath: string, personaId: string): LoadedPersona | null {
  if (personaId === AUTHOR_PERSONA_ID) return getAuthorPersona()

  ensureDefaultPersonas(workspaceRootPath)
  return loadPersonaFromDir(ensurePersonasDir(workspaceRootPath), personaId)
}

export function loadPersonaPromptForInjection(
  workspaceRootPath: string,
  personaId: string | undefined,
): string | undefined {
  if (!personaId) return undefined
  const persona = loadPersona(workspaceRootPath, personaId)
  if (!persona?.config.injectPrompt) return undefined
  const prompt = persona.promptContent?.trim()
  return prompt ? prompt : undefined
}

export function loadWorkspacePersonas(workspaceRootPath: string): LoadedPersona[] {
  ensureDefaultPersonas(workspaceRootPath)
  const personasDir = ensurePersonasDir(workspaceRootPath)
  const personas: LoadedPersona[] = [getAuthorPersona()]

  try {
    const entries = readdirSync(personasDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const persona = loadPersonaFromDir(personasDir, entry.name)
      if (!persona) continue
      // Avoid duplicate Author if a user creates author/ on disk later.
      if (persona.id === AUTHOR_PERSONA_ID) continue
      personas.push(persona)
    }
  } catch {
    return personas
  }

  return personas.sort((a, b) => {
    if (a.id === AUTHOR_PERSONA_ID) return -1
    if (b.id === AUTHOR_PERSONA_ID) return 1
    return a.name.localeCompare(b.name)
  })
}

export function personaExists(workspaceRootPath: string, personaId: string): boolean {
  return loadPersona(workspaceRootPath, personaId) !== null
}

export function listPersonaSlugs(workspaceRootPath: string): string[] {
  return loadWorkspacePersonas(workspaceRootPath).map((persona) => persona.id)
}

export function isPersonaPromptFileWithinPersonaDir(personaDir: string, promptFile: string): boolean {
  const resolvedPersonaDir = normalize(personaDir)
  const resolvedPromptPath = normalize(join(personaDir, promptFile))
  return resolvedPromptPath === resolvedPersonaDir || resolvedPromptPath.startsWith(`${resolvedPersonaDir}/`) || resolvedPromptPath.startsWith(`${resolvedPersonaDir}\\`)
}
