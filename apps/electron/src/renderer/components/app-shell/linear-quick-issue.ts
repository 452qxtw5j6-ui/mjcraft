import type { ContentBadge, LoadedSource, LlmConnectionWithStatus, ThinkingLevel } from '../../../shared/types'

export interface PromptBuildResult {
  prompt: string
  badges: ContentBadge[]
}

export interface LinearQuickIssueRuntimeOptions {
  llmConnections: LlmConnectionWithStatus[]
  sources: LoadedSource[]
}

export interface LinearQuickIssueSessionDefaults {
  model?: string
  llmConnection?: string
  thinkingLevel: ThinkingLevel
  enabledSourceSlugs: string[]
}

const FAST_MODEL_CANDIDATES = [
  'claude-haiku-4-5-20251001',
  'claude-haiku-4-5',
  'claude-haiku',
  'pi/gpt-5.3-codex-spark',
  'gpt-5.3-codex-spark',
  'pi/gpt-5.1-codex-mini',
  'gpt-5.1-codex-mini',
  'pi/gpt-5-mini',
  'gpt-5-mini',
  'pi/gpt-4.1-mini',
  'gpt-4.1-mini',
  'pi/gpt-4o-mini',
  'gpt-4o-mini',
]
const GPT_54_MODEL_CANDIDATES = ['pi/gpt-5.4', 'gpt-5.4']
const PREFERRED_MODEL_CANDIDATES = [...FAST_MODEL_CANDIDATES, ...GPT_54_MODEL_CANDIDATES]
const LINEAR_SOURCE_SLUG_CANDIDATES = ['linear-cli', 'linear']

function normalizeModelId(model: string): string {
  return model.startsWith('pi/') ? model.slice(3) : model
}

function getModelCandidatePriority(modelId: string): number {
  const normalized = normalizeModelId(modelId)
  const index = PREFERRED_MODEL_CANDIDATES.findIndex(candidate =>
    normalizeModelId(candidate) === normalized,
  )
  if (index >= 0) return index
  if (normalized.includes('mini')) return 20
  if (normalized.includes('haiku')) return 30
  if (normalized.includes('flash')) return 40
  if (normalized.includes('codex')) return 60
  if (normalized.includes('sonnet')) return 80
  if (normalized === 'gpt-5.4') return 120
  return Number.POSITIVE_INFINITY
}

export function resolveLinearQuickIssueDefaults(
  options: LinearQuickIssueRuntimeOptions,
): LinearQuickIssueSessionDefaults {
  const sourceSlug = resolveLinearQuickIssueSourceSlug(options.sources)
  const { llmConnection, model } = resolveLinearQuickIssueConnection(options.llmConnections)

  return {
    model,
    llmConnection,
    thinkingLevel: 'off',
    enabledSourceSlugs: sourceSlug ? [sourceSlug] : [],
  }
}

export function resolveLinearQuickIssueSourceSlug(sources: LoadedSource[]): string | undefined {
  const bySlug = LINEAR_SOURCE_SLUG_CANDIDATES
    .map(candidate => sources.find(source => source.config.slug === candidate))
    .find(Boolean)
  if (bySlug) return bySlug.config.slug

  const linearCliSource = sources.find(source =>
    source.config.type === 'cli' &&
    source.config.provider === 'linear',
  )
  if (linearCliSource) return linearCliSource.config.slug

  const fuzzyMatch = sources.find(source =>
    source.config.type === 'cli' &&
    (
      source.config.slug.toLowerCase().includes('linear') ||
      source.config.name.toLowerCase().includes('linear')
    ),
  )
  return fuzzyMatch?.config.slug
}

export function resolveLinearQuickIssueConnection(
  llmConnections: LlmConnectionWithStatus[],
): { llmConnection?: string; model?: string } {
  const authenticated = llmConnections.filter(connection => connection.isAuthenticated)
  const candidates = authenticated
    .map((connection) => {
      const bestModel = (connection.models ?? [])
        .map(model => typeof model === 'string' ? model : model.id)
        .sort((a, b) => getModelCandidatePriority(a) - getModelCandidatePriority(b))[0]

      return {
        connection,
        model: bestModel,
        priority: bestModel ? getModelCandidatePriority(bestModel) : Number.POSITIVE_INFINITY,
      }
    })
    .filter(candidate => candidate.model && Number.isFinite(candidate.priority))
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority
      return a.connection.slug.localeCompare(b.connection.slug)
    })

  const preferredConnection = candidates[0]

  if (!preferredConnection) {
    return {}
  }

  return {
    llmConnection: preferredConnection.connection.slug,
    model: preferredConnection.model,
  }
}

export function buildLinearQuickIssuePrompt(
  userInstructions: string,
  options?: { sourceSlug?: string },
): PromptBuildResult {
  const metadataSection = `<linear_issue_request>
<goal>Capture the user's idea immediately as a Linear issue.</goal>
${options?.sourceSlug ? `<preferred_source>${options.sourceSlug}</preferred_source>
` : ''}<workflow>
- Treat rough notes as issue drafts, not brainstorming prompts.
- Make a best-effort issue from the first user message alone.
- Prefer exactly one direct issues_create call.
- Do not call help, read the CLI guide, or use generic CLI run unless direct issue creation fails.
- Do not inspect existing issues unless duplicate detection is absolutely necessary.
- Turn the note into a crisp title and a short Markdown description.
- Infer team, project, and labels from existing Linear context when safe.
- Ask at most one short question only if the issue would otherwise go to the wrong team or project.
- After creation, reply with the issue id and one-line summary.
</workflow>
</linear_issue_request>

`

  const prompt = metadataSection + userInstructions
  const badges: ContentBadge[] = [
    {
      type: 'context',
      label: 'Context',
      rawText: metadataSection,
      start: 0,
      end: metadataSection.length,
      collapsedLabel: 'Context',
    },
  ]

  return { prompt, badges }
}
