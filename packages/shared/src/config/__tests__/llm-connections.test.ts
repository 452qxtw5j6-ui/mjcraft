import { describe, it, expect } from 'bun:test'
import {
  findModelDefinition,
  findPreferredOpenAiCodingModel,
  getDefaultModelsForConnection,
  getDefaultModelForConnection,
  isCompatProvider,
  isAnthropicProvider,
  isPiProvider,
  registerPiModelResolver,
} from '../llm-connections'
import { ANTHROPIC_MODELS } from '../models'

const MOCK_PI_MODELS = {
  anthropic: [
    { id: 'pi/claude-opus-4-6', name: 'Claude Opus 4.6', shortName: 'Opus', description: '', provider: 'pi' as const, contextWindow: 200_000 },
    { id: 'pi/claude-sonnet-4-6', name: 'Claude Sonnet 4.6', shortName: 'Sonnet', description: '', provider: 'pi' as const, contextWindow: 200_000 },
  ],
  openai: [
    { id: 'pi/gpt-5.4', name: 'GPT-5.4', shortName: 'GPT-5.4', description: '', provider: 'pi' as const, contextWindow: 272_000 },
    { id: 'pi/gpt-5.2', name: 'GPT-5.2', shortName: 'GPT-5.2', description: '', provider: 'pi' as const, contextWindow: 272_000 },
  ],
  'openai-codex': [
    { id: 'pi/gpt-5.4', name: 'GPT-5.4', shortName: 'GPT-5.4', description: '', provider: 'pi' as const, contextWindow: 1_050_000 },
    { id: 'pi/gpt-5.3-codex', name: 'GPT-5.3 Codex', shortName: 'Codex', description: '', provider: 'pi' as const, contextWindow: 272_000 },
  ],
} as const

registerPiModelResolver((piAuthProvider) => {
  if (!piAuthProvider) {
    return Object.values(MOCK_PI_MODELS).flat()
  }
  return [...(MOCK_PI_MODELS[piAuthProvider as keyof typeof MOCK_PI_MODELS] ?? [])]
})

// ============================================================
// getDefaultModelsForConnection
// ============================================================

describe('getDefaultModelsForConnection', () => {
  it('anthropic returns ANTHROPIC_MODELS (ModelDefinition[])', () => {
    const models = getDefaultModelsForConnection('anthropic')
    expect(models).toEqual(ANTHROPIC_MODELS)
    expect(models.length).toBeGreaterThan(0)
    // Verify they are ModelDefinition objects, not strings
    const first = models[0]!
    expect(typeof first).toBe('object')
    expect(typeof (first as any).id).toBe('string')
  })

  it('bedrock returns same models as anthropic', () => {
    expect(getDefaultModelsForConnection('bedrock')).toEqual(ANTHROPIC_MODELS)
  })

  it('vertex returns same models as anthropic', () => {
    expect(getDefaultModelsForConnection('vertex')).toEqual(ANTHROPIC_MODELS)
  })

  it('pi with piAuthProvider returns filtered models', () => {
    const models = getDefaultModelsForConnection('pi', 'anthropic')
    expect(models.length).toBeGreaterThan(0)
    // All should have pi/ prefix in their id
    for (const m of models) {
      const id = typeof m === 'string' ? m : m.id
      expect(id.startsWith('pi/')).toBe(true)
    }
  })

  it('pi without piAuthProvider returns all Pi models', () => {
    const models = getDefaultModelsForConnection('pi')
    expect(models.length).toBeGreaterThan(0)
  })

  it('anthropic_compat returns empty list (dynamic provider)', () => {
    const models = getDefaultModelsForConnection('anthropic_compat')
    expect(models).toEqual([])
  })
})

// ============================================================
// getDefaultModelForConnection
// ============================================================

describe('getDefaultModelForConnection', () => {
  it('returns first model ID for anthropic', () => {
    const modelId = getDefaultModelForConnection('anthropic')
    expect(typeof modelId).toBe('string')
    expect(modelId.length).toBeGreaterThan(0)
    // Should match the first ANTHROPIC_MODELS entry
    expect(modelId).toBe(ANTHROPIC_MODELS[0]!.id)
  })

  // Regression: Pi 'anthropic' default must be present in its own model list
  it('regression: Pi anthropic default is in its own model list', () => {
    const defaultModel = getDefaultModelForConnection('pi', 'anthropic')
    const models = getDefaultModelsForConnection('pi', 'anthropic')
    const modelIds = models.map(m => typeof m === 'string' ? m : m.id)
    expect(modelIds).toContain(defaultModel)
  })

  it('Pi openai default is in its own model list', () => {
    const defaultModel = getDefaultModelForConnection('pi', 'openai')
    const models = getDefaultModelsForConnection('pi', 'openai')
    const modelIds = models.map(m => typeof m === 'string' ? m : m.id)
    expect(modelIds).toContain(defaultModel)
  })

  it('Pi openai-codex default prefers gpt-5.4', () => {
    const defaultModel = getDefaultModelForConnection('pi', 'openai-codex')
    const models = getDefaultModelsForConnection('pi', 'openai-codex')
    const modelIds = models.map(m => typeof m === 'string' ? m : m.id)
    expect(modelIds).toContain(defaultModel)
    expect(defaultModel).toBe('pi/gpt-5.4')
  })

  it('returns empty string for anthropic_compat (dynamic provider)', () => {
    const defaultModel = getDefaultModelForConnection('anthropic_compat')
    expect(defaultModel).toBe('')
  })

  it('returns empty string for pi_compat (dynamic provider)', () => {
    const defaultModel = getDefaultModelForConnection('pi_compat')
    expect(defaultModel).toBe('')
  })
})

describe('findPreferredOpenAiCodingModel', () => {
  it('prefers gpt-5.4 when available', () => {
    const selected = findPreferredOpenAiCodingModel([
      'pi/gpt-5.3-codex',
      'pi/gpt-5.4',
      'pi/gpt-5.2-codex',
    ])
    expect(selected).toBe('pi/gpt-5.4')
  })

  it('falls back to the best codex model when gpt-5.4 is unavailable', () => {
    const selected = findPreferredOpenAiCodingModel([
      'openai/gpt-5.1-codex',
      'openai/gpt-5.3-codex',
    ])
    expect(selected).toBe('openai/gpt-5.3-codex')
  })
})

describe('findModelDefinition', () => {
  it('resolves dynamic Pi model metadata via the registered resolver', () => {
    const model = findModelDefinition('pi/gpt-5.4', {
      providerType: 'pi',
      piAuthProvider: 'openai-codex',
    })
    expect(model?.contextWindow).toBe(1_050_000)
  })
})

// ============================================================
// Provider type guards
// ============================================================

describe('isCompatProvider', () => {
  it('returns true for anthropic_compat', () => {
    expect(isCompatProvider('anthropic_compat')).toBe(true)
  })

  it('returns true for pi_compat', () => {
    expect(isCompatProvider('pi_compat')).toBe(true)
  })

  it('returns false for anthropic', () => {
    expect(isCompatProvider('anthropic')).toBe(false)
  })

  it('returns false for pi', () => {
    expect(isCompatProvider('pi')).toBe(false)
  })
})

describe('isAnthropicProvider', () => {
  it('returns true for anthropic', () => {
    expect(isAnthropicProvider('anthropic')).toBe(true)
  })

  it('returns true for anthropic_compat', () => {
    expect(isAnthropicProvider('anthropic_compat')).toBe(true)
  })

  it('returns true for bedrock', () => {
    expect(isAnthropicProvider('bedrock')).toBe(true)
  })

  it('returns true for vertex', () => {
    expect(isAnthropicProvider('vertex')).toBe(true)
  })

  it('returns false for pi', () => {
    expect(isAnthropicProvider('pi')).toBe(false)
  })
})

describe('isPiProvider', () => {
  it('returns true for pi', () => {
    expect(isPiProvider('pi')).toBe(true)
  })

  it('returns true for pi_compat', () => {
    expect(isPiProvider('pi_compat')).toBe(true)
  })

  it('returns false for anthropic', () => {
    expect(isPiProvider('anthropic')).toBe(false)
  })
})
