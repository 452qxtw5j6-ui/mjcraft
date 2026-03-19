import {
  AUTHOR_PERSONA_ID,
  type LoadedPersona,
  type ResolvedPersonaBindings,
} from './types.ts'

function unique(values: string[] | undefined): string[] {
  return Array.from(new Set((values ?? []).filter(Boolean)))
}

function collectReservedValues(
  personas: LoadedPersona[],
  key: 'visibleSkills' | 'defaultSkills' | 'visibleSources' | 'defaultSources',
): Set<string> {
  const reserved = new Set<string>()

  for (const persona of personas) {
    if (persona.id === AUTHOR_PERSONA_ID) continue
    for (const value of persona.config[key] ?? []) {
      if (value) reserved.add(value)
    }
  }

  return reserved
}

/**
 * Resolve a persona into runtime/UI bindings using currently available workspace assets.
 *
 * The synthetic Author persona exposes any skill/source that is not explicitly
 * reserved by another on-disk persona.
 */
export function resolvePersonaBindings(
  personas: LoadedPersona[],
  personaId: string | undefined,
  availableSkillSlugs: string[],
  availableSourceSlugs: string[],
): ResolvedPersonaBindings {
  const authorPersona = personas.find((persona) => persona.id === AUTHOR_PERSONA_ID)
  const selectedPersona = personas.find((persona) => persona.id === personaId)
    ?? authorPersona
    ?? personas[0]

  if (!selectedPersona) {
    return {
      id: AUTHOR_PERSONA_ID,
      name: 'Author',
      source: 'builtin',
      injectPrompt: false,
      visibleSkills: [...availableSkillSlugs],
      defaultSkills: [],
      visibleSources: [...availableSourceSlugs],
      defaultSources: [],
    }
  }

  if (selectedPersona.id === AUTHOR_PERSONA_ID) {
    const reservedSkillSlugs = collectReservedValues(personas, 'visibleSkills')
    const reservedDefaultSkills = collectReservedValues(personas, 'defaultSkills')
    const reservedSourceSlugs = collectReservedValues(personas, 'visibleSources')
    const reservedDefaultSources = collectReservedValues(personas, 'defaultSources')

    for (const persona of personas) {
      if (persona.id === AUTHOR_PERSONA_ID) continue
      if (persona.config.primarySkill) {
        reservedSkillSlugs.add(persona.config.primarySkill)
        reservedDefaultSkills.add(persona.config.primarySkill)
      }
    }

    return {
      id: selectedPersona.id,
      name: selectedPersona.name,
      source: selectedPersona.source,
      injectPrompt: false,
      linkedLabelId: selectedPersona.config.linkedLabelId,
      promptContent: selectedPersona.promptContent,
      visibleSkills: availableSkillSlugs.filter(
        (slug) => !reservedSkillSlugs.has(slug) && !reservedDefaultSkills.has(slug),
      ),
      defaultSkills: [],
      visibleSources: availableSourceSlugs.filter(
        (slug) => !reservedSourceSlugs.has(slug) && !reservedDefaultSources.has(slug),
      ),
      defaultSources: [],
    }
  }

  const visibleSkills = unique(selectedPersona.config.visibleSkills).filter((slug) =>
    availableSkillSlugs.includes(slug),
  )
  const defaultSkills = unique(selectedPersona.config.defaultSkills).filter((slug) =>
    visibleSkills.includes(slug),
  )
  const visibleSources = unique(selectedPersona.config.visibleSources).filter((slug) =>
    availableSourceSlugs.includes(slug),
  )
  const defaultSources = unique(selectedPersona.config.defaultSources).filter((slug) =>
    visibleSources.includes(slug),
  )
  const primarySkill = selectedPersona.config.primarySkill && visibleSkills.includes(selectedPersona.config.primarySkill)
    ? selectedPersona.config.primarySkill
    : undefined

  return {
    id: selectedPersona.id,
    name: selectedPersona.name,
    source: selectedPersona.source,
    injectPrompt: selectedPersona.config.injectPrompt,
    linkedLabelId: selectedPersona.config.linkedLabelId,
    primarySkill,
    promptContent: selectedPersona.promptContent,
    visibleSkills,
    defaultSkills,
    visibleSources,
    defaultSources,
  }
}
