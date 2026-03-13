import { describe, expect, it } from 'bun:test'
import { formatLargeResponseMessage } from '../large-response.ts'

describe('formatLargeResponseMessage', () => {
  it('formats summarized large output with follow-up hints', () => {
    const message = formatLargeResponseMessage({
      estimatedTokens: 20001,
      relativePath: 'long_responses/output.txt',
      absolutePath: '/tmp/session/long_responses/output.txt',
      summary: 'Key facts here.',
    })

    expect(message).toContain('[Large output saved and summarized (~20001 tokens)]')
    expect(message).toContain('Full output saved: /tmp/session/long_responses/output.txt')
    expect(message).toContain('Next: use Read/Grep on that path for details')
    expect(message).toContain('transform_data inputFiles: ["long_responses/output.txt"]')
    expect(message).toContain('Key facts here.')
  })

  it('formats preview mode without summary', () => {
    const message = formatLargeResponseMessage({
      estimatedTokens: 18000,
      relativePath: 'long_responses/output.txt',
      absolutePath: '/tmp/session/long_responses/output.txt',
      preview: 'First lines',
    })

    expect(message).toContain('[Large output saved (~18000 tokens)]')
    expect(message).toContain('Preview:\nFirst lines...')
    expect(message).not.toContain('summarized')
  })

  it('formats bare saved output when neither summary nor preview exists', () => {
    const message = formatLargeResponseMessage({
      estimatedTokens: 18000,
      relativePath: 'long_responses/output.txt',
      absolutePath: '/tmp/session/long_responses/output.txt',
    })

    expect(message).toContain('[Large output saved (~18000 tokens)]')
    expect(message).toContain('Full output saved: /tmp/session/long_responses/output.txt')
    expect(message).not.toContain('Preview:')
  })
})
