import { describe, expect, it } from 'bun:test'
import type { LoadedSource } from '@craft-agent/shared/sources'
import {
  resolveRequestedSource,
  shouldAttemptSourceResolution,
} from '../source-intent-resolver.ts'

function makeSource(
  slug: string,
  provider: string,
  name: string,
  tagline?: string,
  guideRaw?: string,
): LoadedSource {
  return {
    workspaceId: 'ws-test',
    workspaceRootPath: '/test/workspace',
    folderPath: `/test/workspace/sources/${slug}`,
    config: {
      id: `${slug}-id`,
      name,
      slug,
      enabled: true,
      provider,
      type: 'mcp',
      tagline,
      mcp: { transport: 'http', url: `https://${slug}.example.com/mcp`, authType: 'none' },
    },
    guide: guideRaw ? { raw: guideRaw } : null,
    isBuiltin: false,
  } as LoadedSource
}

describe('source-intent-resolver', () => {
  const sources = [
    makeSource(
      'notion',
      'notion',
      'Notion MCP',
      'Notion 워크스페이스 페이지/데이터를 MCP로 조회·편집',
      '# Notion MCP\n\nNotion 공식 Remote MCP 서버 연결입니다.\n',
    ),
    makeSource(
      'mixpanel',
      'mixpanel',
      'Mixpanel MCP',
      'Mixpanel 프로젝트 데이터에 안전하게 접근',
      '# Mixpanel MCP\n\nMixpanel 공식 Remote MCP 서버 연결입니다.\n',
    ),
    makeSource(
      'duckdb',
      'duckdb',
      'DuckDB',
      'mktdb 스키마 기준 데이터분석 전용 DuckDB MCP 서버',
      '# DuckDB\n\nmarketing_shared.duckdb를 대상으로 하는 데이터분석 전용 MCP 소스입니다.\n',
    ),
  ]

  it('detects source-backed request intent', () => {
    expect(shouldAttemptSourceResolution('노션에서 마케팅팀 할 일 찾아')).toBe(true)
    expect(shouldAttemptSourceResolution('믹스패널 데이터 보여줘')).toBe(true)
    expect(shouldAttemptSourceResolution('노션에 데이터 보니까 그렇지 않네')).toBe(false)
  })

  it('uses the helper model to resolve source without hardcoded aliases', async () => {
    const result = await resolveRequestedSource(
      '노션에서 마케팅팀 할 일 찾아',
      sources,
      async () => 'notion',
    )
    expect(result?.sourceSlug).toBe('notion')
    expect(result?.score).toBe(100)
  })

  it('falls back to metadata scoring when helper model is unavailable', async () => {
    const result = await resolveRequestedSource(
      'DuckDB에서 spend 조회해줘',
      sources,
      async () => {
        throw new Error('model unavailable')
      },
    )
    expect(result?.sourceSlug).toBe('duckdb')
  })

  it('does not resolve a source for commentary', async () => {
    const result = await resolveRequestedSource(
      '믹스패널 썼잖아',
      sources,
      async () => 'mixpanel',
    )
    expect(result).toBeNull()
  })

  it('does not resolve when the user already explicitly mentioned a source', async () => {
    const result = await resolveRequestedSource(
      '[source:notion] 여기서 찾아줘',
      sources,
      async () => 'notion',
    )
    expect(result).toBeNull()
  })
})
