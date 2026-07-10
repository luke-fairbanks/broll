import { describe, expect, it, vi } from 'vitest';
import { buildOAuth1Header, percentEncode, XAdapter } from '../src/social/x.js';
import type { PostDraft } from '../src/social/types.js';

describe('percentEncode', () => {
  it('encodes per RFC 3986 (stricter than encodeURIComponent)', () => {
    expect(percentEncode("Ladies + Gentlemen")).toBe('Ladies%20%2B%20Gentlemen');
    expect(percentEncode("An encoded string!")).toBe('An%20encoded%20string%21');
    expect(percentEncode("Dogs, Cats & Mice")).toBe('Dogs%2C%20Cats%20%26%20Mice');
    expect(percentEncode("☃")).toBe('%E2%98%83');
  });
});

describe('buildOAuth1Header', () => {
  it("reproduces X's documented signature test vector", () => {
    // https://developer.x.com/en/docs/authentication/oauth-1-0a/creating-a-signature
    const header = buildOAuth1Header({
      method: 'POST',
      url: 'https://api.twitter.com/1.1/statuses/update.json',
      params: {
        include_entities: 'true',
        status: 'Hello Ladies + Gentlemen, a signed OAuth request!',
      },
      credentials: {
        consumerKey: 'xvz1evFS4wEEPTGEFPHBog',
        consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
        accessToken: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
        accessTokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
      },
      nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
      timestampSec: 1318622958,
    });

    expect(header).toContain('oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"');
    expect(header.startsWith('OAuth ')).toBe(true);
    expect(header).toContain('oauth_signature_method="HMAC-SHA1"');
  });
});

describe('XAdapter', () => {
  const env = {
    X_API_KEY: 'ck',
    X_API_SECRET: 'cs',
    X_ACCESS_TOKEN: 'at',
    X_ACCESS_TOKEN_SECRET: 'ats',
  } as NodeJS.ProcessEnv;

  const draft: PostDraft = {
    id: 'dr_1',
    createdAt: new Date().toISOString(),
    text: 'hello from broll',
    media: [],
    platforms: ['x'],
    status: 'draft',
    results: {},
  };

  it('is configured only with all four credentials', () => {
    expect(new XAdapter(env).isConfigured()).toBe(true);
    expect(new XAdapter({ ...env, X_API_SECRET: undefined }).isConfigured()).toBe(false);
  });

  it('posts text-only tweets with an OAuth header and returns the URL', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.x.com/2/tweets');
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toMatch(/^OAuth /);
      expect(headers.Authorization).toContain('oauth_consumer_key="ck"');
      expect(JSON.parse(String(init?.body))).toEqual({ text: 'hello from broll' });
      return new Response(JSON.stringify({ data: { id: '1234567890' } }), { status: 201 });
    });

    const adapter = new XAdapter(env, fetchMock as unknown as typeof fetch);
    const result = await adapter.publish(draft, []);
    expect(result.url).toBe('https://x.com/i/status/1234567890');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces API errors with status and body', async () => {
    const fetchMock = vi.fn(async () => new Response('{"detail":"Forbidden"}', { status: 403 }));
    const adapter = new XAdapter(env, fetchMock as unknown as typeof fetch);
    await expect(adapter.publish(draft, [])).rejects.toThrow(/403.*Forbidden/s);
  });
});
