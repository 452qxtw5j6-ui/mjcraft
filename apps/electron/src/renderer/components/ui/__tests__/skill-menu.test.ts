import { beforeAll, describe, expect, it, mock } from 'bun:test'

mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: () => ({}) }))

let isValidSkillTrigger: (text: string, position: number) => boolean

beforeAll(async () => {
  const mod = await import('../skill-menu')
  isValidSkillTrigger = mod.isValidSkillTrigger
})

describe('isValidSkillTrigger', () => {
  it('allows $ at the start of input', () => {
    expect(isValidSkillTrigger('$', 0)).toBe(true)
    expect(isValidSkillTrigger('$review', 0)).toBe(true)
  })

  it('allows $ after whitespace', () => {
    expect(isValidSkillTrigger('run $', 4)).toBe(true)
    expect(isValidSkillTrigger('run $review', 4)).toBe(true)
  })

  it('allows $ after opening punctuation', () => {
    expect(isValidSkillTrigger('($review', 1)).toBe(true)
    expect(isValidSkillTrigger('"$review', 1)).toBe(true)
  })

  it('rejects $ inside words', () => {
    expect(isValidSkillTrigger('price$tag', 5)).toBe(false)
  })
})
