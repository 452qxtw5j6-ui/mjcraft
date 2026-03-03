import { beforeAll, describe, expect, it } from 'bun:test';

let injectMetadataIntoToolSchema: typeof import('../unified-network-interceptor.ts').injectMetadataIntoToolSchema;

describe('unified-network-interceptor schema metadata injection', () => {
  beforeAll(async () => {
    process.env.CRAFT_INTERCEPTOR_DISABLE_AUTO_INSTALL = '1';
    ({ injectMetadataIntoToolSchema } = await import('../unified-network-interceptor.ts'));
  });

  it('injects metadata fields into empty/zero-arg schemas', () => {
    const schema = { type: 'object' };
    const result = injectMetadataIntoToolSchema(schema);

    expect(result.properties._displayName).toBeDefined();
    expect(result.properties._intent).toBeDefined();
    expect(result.required).toContain('_displayName');
    expect(result.required).toContain('_intent');
  });

  it('preserves existing properties and required keys while prepending metadata keys', () => {
    const schema = {
      type: 'object',
      properties: {
        url: { type: 'string' },
      },
      required: ['url'],
    };

    const result = injectMetadataIntoToolSchema(schema);

    expect(result.properties.url).toEqual({ type: 'string' });
    expect(result.required).toEqual(['_displayName', '_intent', 'url']);
  });

  it('does not duplicate metadata keys when already present in required', () => {
    const schema = {
      properties: {
        _displayName: { type: 'string', description: 'custom display name schema' },
        _intent: { type: 'string', description: 'custom intent schema' },
      },
      required: ['_intent', '_displayName'],
    };

    const result = injectMetadataIntoToolSchema(schema);

    expect(result.required).toEqual(['_displayName', '_intent']);
    expect(result.properties._displayName).toEqual({ type: 'string', description: 'custom display name schema' });
    expect(result.properties._intent).toEqual({ type: 'string', description: 'custom intent schema' });
  });
});
