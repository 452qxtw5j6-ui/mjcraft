import { beforeEach, describe, expect, it, mock } from 'bun:test';

const validateAnthropicConnectionMock = mock(async () => ({ success: true as const }));

mock.module('../../../../../config/llm-validation.ts', () => ({
  validateAnthropicConnection: validateAnthropicConnectionMock,
}));

const { anthropicDriver } = await import('../anthropic.ts');

describe('anthropicDriver.validateStoredConnection', () => {
  beforeEach(() => {
    validateAnthropicConnectionMock.mockClear();
  });

  it('falls back to the provider default model when stored defaultModel is blank', async () => {
    const credentialManager = {
      getLlmApiKey: mock(async () => 'sk-ant-test'),
    };

    const result = await anthropicDriver.validateStoredConnection!({
      slug: 'anthropic-api',
      connection: {
        slug: 'anthropic-api',
        name: 'Anthropic (API Key)',
        providerType: 'anthropic',
        authType: 'api_key',
        defaultModel: '   ',
        createdAt: Date.now(),
      },
      credentialManager: credentialManager as any,
    });

    expect(result).toEqual({ success: true });
    expect(validateAnthropicConnectionMock).toHaveBeenCalledTimes(1);
    expect(validateAnthropicConnectionMock).toHaveBeenCalledWith(expect.objectContaining({
      model: 'claude-opus-4-6',
      apiKey: 'sk-ant-test',
    }));
  });
});
