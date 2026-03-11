import type { LoadedSource } from '@craft-agent/shared/sources'

const REQUEST_VERB_RE =
  /(찾아|찾아줘|찾아봐|찾아보자|찾아보죠|검색|검색해|검색해줘|조회|조회해|조회해줘|불러와|불러와줘|불러와봐|가져와|가져와줘|가져와봐|보여줘|보여주|열어|열어줘|확인해|확인해줘|알려줘|업데이트|업데이트해|등록|등록해|추가|추가해|수정|수정해)/
const REQUEST_ENDING_RE = /(해줘|해주세요|해봐|해보자|보여줘|찾아줘|알려줘|열어줘|확인해줘|가져와줘|불러와줘|조회해줘|검색해줘|해보죠|하자|보자)\s*[.!?~]*$/i
const NEGATIVE_CONTEXT_RE = /(보니까|봤더니|썼잖아|했잖아|그렇지 않네|그렇네|같더라|같아요|같네|아닌가|아니네|였는데|보니)\s*[.!?~]*$/i
const EXPLICIT_SOURCE_MENTION_RE = /\[source:[\w-]+\]/i

export interface ResolvedSourceIntent {
  sourceSlug: string
  score: number
  guideSummary?: string
}

export type SourceResolverCallback = (prompt: string) => Promise<string | null>

function compact(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`"'“”‘’()[\]{}<>/\\|:;,.!?~_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractGuideSummary(raw?: string | null): string | undefined {
  if (!raw) return undefined

  const lines = raw
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#') && !line.startsWith('##'))

  const firstParagraph = lines.find(line => !line.startsWith('- ') && !line.startsWith('* '))
  return firstParagraph?.slice(0, 220)
}

function buildSourceDescriptor(source: LoadedSource): string {
  const summary = extractGuideSummary(source.guide?.raw) ?? source.config.tagline ?? ''
  return [
    `slug: ${source.config.slug}`,
    `name: ${source.config.name}`,
    `provider: ${source.config.provider}`,
    summary ? `summary: ${summary}` : null,
  ].filter(Boolean).join('\n')
}

function buildResolverPrompt(message: string, sources: LoadedSource[]): string {
  const sourceBlocks = sources
    .map(source => buildSourceDescriptor(source))
    .join('\n\n')

  return [
    'Choose at most one source slug for the user request.',
    'Return exactly one slug from the list, or NONE.',
    'Choose a source only if the user is clearly asking to use that external system or data source now.',
    'Do not choose a source for commentary, recollection, opinions, or result interpretation.',
    '',
    `User request: ${message}`,
    '',
    'Available sources:',
    sourceBlocks,
  ].join('\n')
}

function parseResolverChoice(response: string | null, validSlugs: Set<string>): string | null {
  if (!response) return null

  const trimmed = response.trim()
  if (!trimmed) return null

  const firstLine = trimmed.split('\n')[0]?.trim() ?? ''
  if (!firstLine) return null

  if (/^none$/i.test(firstLine)) return null
  if (validSlugs.has(firstLine)) return firstLine

  const compacted = compact(firstLine)
  for (const slug of validSlugs) {
    if (compacted === compact(slug)) return slug
  }

  const matches = [...validSlugs].filter(slug => compacted.includes(compact(slug)))
  return matches.length === 1 ? matches[0]! : null
}

function getMetadataScore(message: string, source: LoadedSource): number {
  const normalized = compact(message)
  const fields = [
    source.config.slug,
    source.config.name,
    source.config.provider,
    source.config.tagline,
    extractGuideSummary(source.guide?.raw),
  ].filter(Boolean) as string[]

  let score = 0
  for (const field of fields) {
    const term = compact(field)
    if (!term) continue
    if (normalized.includes(term)) {
      score += Math.max(2, Math.min(8, term.length))
    }
    for (const token of term.split(' ')) {
      if (token.length >= 3 && normalized.includes(token)) {
        score += 1
      }
    }
  }
  return score
}

export function shouldAttemptSourceResolution(message: string): boolean {
  const trimmed = message.trim()
  if (!trimmed || EXPLICIT_SOURCE_MENTION_RE.test(trimmed)) return false

  const hasVerb = REQUEST_VERB_RE.test(trimmed)
  const hasRequestEnding = REQUEST_ENDING_RE.test(trimmed)
  const negativeContext = NEGATIVE_CONTEXT_RE.test(trimmed)

  if (negativeContext && !hasRequestEnding) return false
  return hasVerb || hasRequestEnding
}

export async function resolveRequestedSource(
  message: string,
  loadedSources: LoadedSource[],
  resolveWithModel?: SourceResolverCallback,
): Promise<ResolvedSourceIntent | null> {
  if (!shouldAttemptSourceResolution(message) || loadedSources.length === 0) {
    return null
  }

  const validSlugs = new Set(loadedSources.map(source => source.config.slug))

  if (resolveWithModel) {
    try {
      const choice = parseResolverChoice(
        await resolveWithModel(buildResolverPrompt(message, loadedSources)),
        validSlugs,
      )
      if (choice) {
        const source = loadedSources.find(item => item.config.slug === choice)
        return {
          sourceSlug: choice,
          score: 100,
          guideSummary: extractGuideSummary(source?.guide?.raw) ?? source?.config.tagline,
        }
      }
    } catch {
      // Fall through to lexical scoring when the helper model is unavailable.
    }
  }

  let best: ResolvedSourceIntent | null = null
  let secondBest = 0

  for (const source of loadedSources) {
    const score = getMetadataScore(message, source)
    if (score <= 0) continue

    if (!best || score > best.score) {
      secondBest = best?.score ?? 0
      best = {
        sourceSlug: source.config.slug,
        score,
        guideSummary: extractGuideSummary(source.guide?.raw) ?? source.config.tagline,
      }
    } else if (score > secondBest) {
      secondBest = score
    }
  }

  if (!best) return null
  if (best.score < 3) return null
  if (secondBest > 0 && best.score - secondBest < 2) return null

  return best
}
