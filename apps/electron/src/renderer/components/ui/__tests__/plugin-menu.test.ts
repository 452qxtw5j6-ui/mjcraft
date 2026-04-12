import { beforeAll, describe, expect, it, mock } from 'bun:test'

mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: () => ({}) }))

let isValidPluginTrigger: (text: string, position: number) => boolean

beforeAll(async () => {
  const mod = await import('../plugin-menu')
  isValidPluginTrigger = mod.isValidPluginTrigger
})

describe('isValidPluginTrigger', () => {
  it('allows % at the start of input', () => {
    expect(isValidPluginTrigger('%', 0)).toBe(true)
    expect(isValidPluginTrigger('%seo', 0)).toBe(true)
  })

  it('allows % after whitespace', () => {
    expect(isValidPluginTrigger('run %', 4)).toBe(true)
    expect(isValidPluginTrigger('run %seo', 4)).toBe(true)
  })

  it('allows % after opening punctuation', () => {
    expect(isValidPluginTrigger('(%seo', 1)).toBe(true)
    expect(isValidPluginTrigger('"%seo', 1)).toBe(true)
    expect(isValidPluginTrigger("'%seo", 1)).toBe(true)
  })

  it('rejects % inside words', () => {
    expect(isValidPluginTrigger('foo%bar', 3)).toBe(false)
    expect(isValidPluginTrigger('100%real', 3)).toBe(false)
  })

  it('rejects invalid positions', () => {
    expect(isValidPluginTrigger('abc', -1)).toBe(false)
  })
})
