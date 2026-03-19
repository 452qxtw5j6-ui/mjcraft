import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import {
  AUTHOR_PERSONA_ID,
  SEO_PERSONA_ID,
  ensureDefaultPersonas,
  loadPersona,
  loadPersonaPromptForInjection,
  loadWorkspacePersonas,
  resolvePersonaBindings,
} from '../index.ts'

describe('personas storage', () => {
  let workspaceRoot: string

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'persona-storage-'))
    mkdirSync(join(workspaceRoot, 'skills'), { recursive: true })
    mkdirSync(join(workspaceRoot, 'skills', 'seo-audit'), { recursive: true })
    mkdirSync(join(workspaceRoot, 'sources', 'notion'), { recursive: true })
    mkdirSync(join(workspaceRoot, 'sources', 'linear'), { recursive: true })
    writeFileSync(
      join(workspaceRoot, 'skills', 'seo-audit', 'SKILL.md'),
      `---
name: SEO Audit
description: Audit SEO issues
requiredSources:
  - notion
---

# SEO Audit
`,
      'utf-8',
    )
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('seeds SEO and includes built-in Author', () => {
    ensureDefaultPersonas(workspaceRoot)

    const personas = loadWorkspacePersonas(workspaceRoot)
    expect(personas.map((persona) => persona.id)).toContain(AUTHOR_PERSONA_ID)
    expect(personas.map((persona) => persona.id)).toContain(SEO_PERSONA_ID)
  })

  it('loads built-in Author without prompt injection', () => {
    const author = loadPersona(workspaceRoot, AUTHOR_PERSONA_ID)
    expect(author?.config.injectPrompt).toBe(false)
  })

  it('only injects prompt content when injectPrompt is enabled', () => {
    ensureDefaultPersonas(workspaceRoot)

    expect(loadPersonaPromptForInjection(workspaceRoot, AUTHOR_PERSONA_ID)).toBeUndefined()
    expect(loadPersonaPromptForInjection(workspaceRoot, SEO_PERSONA_ID)).toContain('# SEO Persona')

    const personasDir = join(workspaceRoot, 'personas', SEO_PERSONA_ID)
    writeFileSync(join(personasDir, 'persona.json'), JSON.stringify({
      version: 1,
      id: SEO_PERSONA_ID,
      name: 'SEO',
      injectPrompt: false,
      personaPromptFile: 'persona.md',
      visibleSkills: [],
      defaultSkills: [],
      visibleSources: [],
      defaultSources: [],
    }, null, 2))

    expect(loadPersonaPromptForInjection(workspaceRoot, SEO_PERSONA_ID)).toBeUndefined()
  })

  it('resolves Author visibility by excluding persona-owned skills and sources', () => {
    ensureDefaultPersonas(workspaceRoot)

    const personasDir = join(workspaceRoot, 'personas', SEO_PERSONA_ID)
    writeFileSync(join(personasDir, 'persona.json'), JSON.stringify({
      version: 1,
      id: SEO_PERSONA_ID,
      name: 'SEO',
      injectPrompt: true,
      personaPromptFile: 'persona.md',
      visibleSkills: ['seo-audit'],
      defaultSkills: [],
      visibleSources: ['notion'],
      defaultSources: [],
    }, null, 2))

    const personas = loadWorkspacePersonas(workspaceRoot)
    const resolved = resolvePersonaBindings(personas, AUTHOR_PERSONA_ID, ['seo-audit', 'general-writing'], ['notion', 'linear'])

    expect(resolved.visibleSkills).toEqual(['general-writing'])
    expect(resolved.visibleSources).toEqual(['linear'])
  })
})
