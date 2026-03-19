/**
 * Persona Types
 *
 * Personas are workspace-scoped role packages that bind a behavioral lens
 * (`persona.md`) to curated skill/source visibility.
 */

export const PERSONA_SCHEMA_VERSION = 1 as const
export const AUTHOR_PERSONA_ID = 'author' as const
export const SEO_PERSONA_ID = 'seo' as const

export interface PersonaConfig {
  version: number
  id: string
  name: string
  injectPrompt: boolean
  personaPromptFile: string
  linkedLabelId?: string
  primarySkill?: string
  visibleSkills?: string[]
  defaultSkills?: string[]
  visibleSources?: string[]
  defaultSources?: string[]
}

export type PersonaSource = 'builtin' | 'workspace'

export interface LoadedPersona {
  id: string
  name: string
  config: PersonaConfig
  source: PersonaSource
  folderPath?: string
  promptContent?: string
  readmeContent?: string
}

export interface ResolvedPersonaBindings {
  id: string
  name: string
  source: PersonaSource
  injectPrompt: boolean
  linkedLabelId?: string
  primarySkill?: string
  promptContent?: string
  visibleSkills: string[]
  defaultSkills: string[]
  visibleSources: string[]
  defaultSources: string[]
}
