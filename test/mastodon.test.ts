import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MastodonAdapter } from '../src/social/mastodon.js';
import type { PostDraft } from '../src/social/types.js';

const env = { MASTODON_ACCESS_TOKEN: 'tok', MASTODON_INSTANCE: 'https://mstdn.example' } as NodeJS.ProcessEnv;

const draft: PostDraft = {
  id: 'dr_m',
  createdAt: new Date().toISOString(),
  posts: [{ text: 'hello fediverse', media: [] }],
  platforms: ['mastodon'],
  status: 'draft',
  results: {},
};

describe('MastodonAdapter', () => {
  it('is configured with just an access token and defaults the instance', () => {
    expect(new MastodonAdapter({ MASTODON_ACCESS_TOKEN: 't' } as NodeJS.ProcessEnv).isConfigured()).toBe(true);
    expect(new MastodonAdapter({} as NodeJS.ProcessEnv).isConfigured()).toBe(false);
  });

  it('posts a status with a bearer token and returns the public URL', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://mstdn.example/api/v1/statuses');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
      expect(JSON.parse(String(init?.body))).toEqual({ status: 'hello fediverse' });
      return new Response(JSON.stringify({ id: '42', url: 'https://mstdn.example/@luke/42' }), { status: 200 });
    });
    const adapter = new MastodonAdapter(env, fetchMock as unknown as typeof fetch);
    const result = await adapter.publish(draft, [[]]);
    expect(result.url).toBe('https://mstdn.example/@luke/42');
    expect(result.postedSegments).toBe(1);
  });

  it('uploads media then attaches media_ids', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'broll-masto-'));
    const img = path.join(dir, 'slide.png');
    writeFileSync(img, 'png');

    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/api/v2/media')) {
        expect(init?.body).toBeInstanceOf(FormData);
        return new Response(JSON.stringify({ id: 'media_9' }), { status: 200 });
      }
      if (u.endsWith('/api/v1/statuses')) {
        expect(JSON.parse(String(init?.body)).media_ids).toEqual(['media_9']);
        return new Response(JSON.stringify({ id: '43', url: 'https://mstdn.example/@luke/43' }), { status: 200 });
      }
      throw new Error(`unexpected: ${u}`);
    });
    const adapter = new MastodonAdapter(env, fetchMock as unknown as typeof fetch);
    await adapter.publish(draft, [[{ path: img, kind: 'image', sizeBytes: 3 }]]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it('polls processing media (202) until ready', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'broll-masto2-'));
    const img = path.join(dir, 'clip.mp4');
    writeFileSync(img, 'mp4');

    let polls = 0;
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.endsWith('/api/v2/media')) return new Response(JSON.stringify({ id: 'm202' }), { status: 202 });
      if (u.endsWith('/api/v1/media/m202')) {
        polls += 1;
        return new Response(JSON.stringify({ id: 'm202' }), { status: polls < 2 ? 206 : 200 });
      }
      if (u.endsWith('/api/v1/statuses')) {
        return new Response(JSON.stringify({ id: '44', url: 'https://mstdn.example/@luke/44' }), { status: 200 });
      }
      throw new Error(`unexpected: ${u}`);
    });
    const adapter = new MastodonAdapter(env, fetchMock as unknown as typeof fetch, 1, 5000);
    await adapter.publish(draft, [[{ path: img, kind: 'video', sizeBytes: 3 }]]);
    expect(polls).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it('chains threads via in_reply_to_id', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let n = 0;
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      n += 1;
      return new Response(JSON.stringify({ id: `s${n}`, url: `https://mstdn.example/@luke/s${n}` }), { status: 200 });
    });
    const thread: PostDraft = {
      ...draft,
      posts: [
        { text: 'one', media: [] },
        { text: 'two', media: [] },
      ],
    };
    const adapter = new MastodonAdapter(env, fetchMock as unknown as typeof fetch);
    const result = await adapter.publish(thread, [[], []]);
    expect(bodies[0]!.in_reply_to_id).toBeUndefined();
    expect(bodies[1]!.in_reply_to_id).toBe('s1');
    expect(result.remoteId).toBe('s1');
  });

  it('probes credentials', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      expect(String(url)).toBe('https://mstdn.example/api/v1/accounts/verify_credentials');
      return new Response(JSON.stringify({ acct: 'luke@mstdn.example' }), { status: 200 });
    });
    const adapter = new MastodonAdapter(env, fetchMock as unknown as typeof fetch);
    expect((await adapter.probe()).detail).toContain('luke@mstdn.example');
  });
});
