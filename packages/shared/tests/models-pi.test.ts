import { describe, it, expect } from 'bun:test';
import { getPiModelsForAuthProvider } from '../src/config/models-pi.ts';

describe('models-pi filtering', () => {
  it('excludes codex-mini-latest for openai models', () => {
    const models = getPiModelsForAuthProvider('openai');
    const ids = models.map(m => m.id);
    expect(ids.includes('pi/codex-mini-latest')).toBe(false);
  });

  it('excludes all gpt-4* models for openai models', () => {
    const models = getPiModelsForAuthProvider('openai');
    const ids = models.map(m => m.id);
    expect(ids.some(id => id.startsWith('pi/gpt-4'))).toBe(false);
  });

  it('overrides gpt-5.4 context window to match the Codex desktop app', () => {
    const models = getPiModelsForAuthProvider('openai-codex');
    const model = models.find(m => m.id === 'pi/gpt-5.4');
    expect(model?.contextWindow).toBe(1_050_000);
  });
});
