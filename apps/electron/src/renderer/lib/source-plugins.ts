import type { LoadedSource } from '../../shared/types'

export type SourceSidebarCategory = 'api' | 'mcp' | 'local' | 'cli' | 'plugin'

export function isPluginSource(source: Pick<LoadedSource, 'config'>): boolean {
  return Boolean(source.config.plugin?.items?.length)
}

export function getPluginSkillSlugs(sources: Pick<LoadedSource, 'config'>[]): Set<string> {
  const slugs = new Set<string>()
  for (const source of sources) {
    for (const item of source.config.plugin?.items ?? []) {
      if (item.skill) slugs.add(item.skill)
    }
  }
  return slugs
}

export function getPluginSourceSlugsForSkills(
  sources: Pick<LoadedSource, 'config'>[],
  skillSlugs: string[]
): string[] {
  if (skillSlugs.length === 0) return []

  const selectedSkills = new Set(skillSlugs)
  const sourceSlugs = new Set<string>()

  for (const source of sources) {
    const pluginItems = source.config.plugin?.items ?? []
    if (pluginItems.some((item) => selectedSkills.has(item.skill))) {
      sourceSlugs.add(source.config.slug)
    }
  }

  return [...sourceSlugs]
}

export function getSourceSidebarCategory(source: Pick<LoadedSource, 'config'>): SourceSidebarCategory {
  if (isPluginSource(source)) return 'plugin'
  if (source.config.type === 'api' || source.config.type === 'mcp' || source.config.type === 'local' || source.config.type === 'cli') {
    return source.config.type
  }
  return 'local'
}
