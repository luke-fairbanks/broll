import { describe, expect, it, vi } from 'vitest';
import { GeminiProvider } from '../src/providers/gemini.js';
import { OpenAiProvider } from '../src/providers/openai.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import type { Provider } from '../src/providers/types.js';

const stubProvider = (name: string, configured: boolean, capabilities: Array<'image' | 'video'> = ['image']): Provider => ({
  name,
  capabilities,
  requirement: `${name.toUpperCase()}_KEY`,
  isConfigured: () => configured,
  generateImages: async () => [],
});

describe('ProviderRegistry', () => {
  it('prefers an explicitly requested provider and errors if unconfigured', () => {
    const registry = new ProviderRegistry([stubProvider('openai', true), stubProvider('mock', true)]);
    expect(registry.pick('image', 'openai').provider.name).toBe('openai');
    const registry2 = new ProviderRegistry([stubProvider('openai', false), stubProvider('mock', true)]);
    expect(() => registry2.pick('image', 'openai')).toThrow(/not configured/);
  });

  it('honors the config default when configured', () => {
    const registry = new ProviderRegistry([stubProvider('openai', true), stubProvider('gemini', true)], {
      image: 'gemini',
    });
    const choice = registry.pick('image');
    expect(choice.provider.name).toBe('gemini');
    expect(choice.reason).toContain('config');
  });

  it('falls back to the first configured real provider, then mock with a helpful reason', () => {
    const registry = new ProviderRegistry([
      stubProvider('openai', false),
      stubProvider('gemini', true),
      stubProvider('mock', true),
    ]);
    expect(registry.pick('image').provider.name).toBe('gemini');

    const keyless = new ProviderRegistry([stubProvider('openai', false), stubProvider('mock', true)]);
    const choice = keyless.pick('image');
    expect(choice.provider.name).toBe('mock');
    expect(choice.reason).toContain('OPENAI_API_KEY');
  });
});

describe('OpenAiProvider', () => {
  it('maps aspect to size, sends the key, and decodes b64 payloads', async () => {
    const png = Buffer.from('fake-png-bytes');
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.openai.com/v1/images/generations');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ model: 'gpt-image-1', prompt: 'a red barn', n: 2, size: '1024x1536' });
      return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }, { b64_json: png.toString('base64') }] }), {
        status: 200,
      });
    });

    const provider = new OpenAiProvider({ OPENAI_API_KEY: 'sk-test' } as NodeJS.ProcessEnv, fetchMock as unknown as typeof fetch);
    const out = await provider.generateImages({ prompt: 'a red barn', aspect: 'portrait', n: 2 });
    expect(out).toHaveLength(2);
    expect(out[0]!.data.equals(png)).toBe(true);
    expect(out[0]!.ext).toBe('png');
  });

  it('throws with status and body on failure', async () => {
    const fetchMock = vi.fn(async () => new Response('{"error":{"message":"billing"}}', { status: 402 }));
    const provider = new OpenAiProvider({ OPENAI_API_KEY: 'sk-test' } as NodeJS.ProcessEnv, fetchMock as unknown as typeof fetch);
    await expect(provider.generateImages({ prompt: 'x', aspect: 'square', n: 1 })).rejects.toThrow(/402.*billing/s);
  });
});

describe('GeminiProvider', () => {
  it('calls Imagen predict with aspect ratio and decodes predictions', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toContain('models/imagen-4.0-generate-001:predict');
      expect((init?.headers as Record<string, string>)['x-goog-api-key']).toBe('g-key');
      const body = JSON.parse(String(init?.body));
      expect(body.parameters).toEqual({ sampleCount: 1, aspectRatio: '9:16' });
      return new Response(
        JSON.stringify({ predictions: [{ bytesBase64Encoded: Buffer.from('img').toString('base64'), mimeType: 'image/png' }] }),
        { status: 200 },
      );
    });
    const provider = new GeminiProvider({ GEMINI_API_KEY: 'g-key' } as NodeJS.ProcessEnv, fetchMock as unknown as typeof fetch);
    const out = await provider.generateImages({ prompt: 'poster', aspect: 'portrait', n: 1 });
    expect(out[0]!.ext).toBe('png');
  });

  it('polls Veo long-running operations until done and downloads the result', async () => {
    let polls = 0;
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes(':predictLongRunning')) {
        return new Response(JSON.stringify({ name: 'operations/op-1' }), { status: 200 });
      }
      if (u.includes('operations/op-1')) {
        polls += 1;
        if (polls < 2) return new Response(JSON.stringify({ done: false }), { status: 200 });
        return new Response(
          JSON.stringify({
            done: true,
            response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://files.gemini/video1' } }] } },
          }),
          { status: 200 },
        );
      }
      if (u === 'https://files.gemini/video1') {
        return new Response(Buffer.from('mp4-bytes'), { status: 200 });
      }
      throw new Error(`unexpected: ${u}`);
    });

    const provider = new GeminiProvider(
      { GEMINI_API_KEY: 'g-key' } as NodeJS.ProcessEnv,
      fetchMock as unknown as typeof fetch,
      'https://generativelanguage.googleapis.com/v1beta',
      1, // fast poll for tests
      5_000,
    );
    const out = await provider.generateVideo({ prompt: 'timelapse', aspect: '9:16', durationSec: 4 });
    expect(out.ext).toBe('mp4');
    expect(out.data.toString()).toBe('mp4-bytes');
    expect(polls).toBe(2);
  });
});
