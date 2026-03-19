import { describe, expect, it } from 'bun:test'

import { validateEnabledSourcesForPersona } from './SessionManager.ts'

describe('validateEnabledSourcesForPersona', () => {
  it('rejects explicit sources that are hidden by the persona', () => {
    expect(() => validateEnabledSourcesForPersona(
      ['hidden-source'],
      {
        name: 'SEO',
        visibleSources: ['allowed-source'],
      },
    )).toThrow('Sources not available in persona "SEO": hidden-source')
  })
})
