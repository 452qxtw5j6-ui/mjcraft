import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { writeSessionJsonl, readSessionJsonl } from '../jsonl'
import { SESSION_PERSISTENT_FIELDS } from '../types'
import { pickSessionFields } from '../utils'

describe('session link persistence', () => {
  it('includes sessionOrigin, notionRef, and slackRef in persistent fields', () => {
    expect(SESSION_PERSISTENT_FIELDS).toContain('sessionOrigin')
    expect(SESSION_PERSISTENT_FIELDS).toContain('notionRef')
    expect(SESSION_PERSISTENT_FIELDS).toContain('slackRef')
  })

  it('pickSessionFields preserves external linkage fields', () => {
    const picked = pickSessionFields({
      id: 's1',
      sessionOrigin: 'notion',
      notionRef: { pageId: 'page-1', dataSourceId: 'db-1', pageUrl: 'https://notion.so/page-1' },
      slackRef: { channelId: 'C1', threadTs: '100', rootMessageTs: '100', permalink: 'https://slack.example/thread' },
    })

    expect(picked.sessionOrigin).toBe('notion')
    expect(picked.notionRef).toEqual({ pageId: 'page-1', dataSourceId: 'db-1', pageUrl: 'https://notion.so/page-1' })
    expect(picked.slackRef).toEqual({ channelId: 'C1', threadTs: '100', rootMessageTs: '100', permalink: 'https://slack.example/thread' })
  })

  it('round-trips session linkage through jsonl persistence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-links-'))
    const sessionFile = join(root, 'session.jsonl')

    try {
      writeSessionJsonl(sessionFile, {
        id: 'session-1',
        workspaceRootPath: root,
        sessionOrigin: 'notion',
        notionRef: { pageId: 'page-1', dataSourceId: 'db-1', pageUrl: 'https://notion.so/page-1' },
        slackRef: { channelId: 'C1', threadTs: '100', rootMessageTs: '100', permalink: 'https://slack.example/thread' },
        createdAt: 1,
        lastUsedAt: 1,
        messages: [],
        tokenUsage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          contextTokens: 0,
          costUsd: 0,
        },
      })

      const loaded = readSessionJsonl(sessionFile)
      expect(loaded?.sessionOrigin).toBe('notion')
      expect(loaded?.notionRef).toEqual({ pageId: 'page-1', dataSourceId: 'db-1', pageUrl: 'https://notion.so/page-1' })
      expect(loaded?.slackRef).toEqual({ channelId: 'C1', threadTs: '100', rootMessageTs: '100', permalink: 'https://slack.example/thread' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
