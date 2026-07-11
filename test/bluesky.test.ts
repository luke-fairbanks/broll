import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BlueskyAdapter, detectLinkFacets, fitImageToLimit } from '../src/social/bluesky.js';
import type { PostDraft } from '../src/social/types.js';

describe('detectLinkFacets', () => {
  it('computes UTF-8 byte offsets, not code-unit offsets', () => {
    // “émoji 🎬 ” before the URL forces byte offsets ≠ char offsets
    const text = 'émoji 🎬 https://broll.dev docs';
    const facets = detectLinkFacets(text);
    expect(facets).toHaveLength(1);
    const prefixBytes = Buffer.byteLength('émoji 🎬 ', 'utf8');
    expect(facets[0]!.index.byteStart).toBe(prefixBytes);
    expect(facets[0]!.index.byteEnd).toBe(prefixBytes + Buffer.byteLength('https://broll.dev', 'utf8'));
    expect(facets[0]!.features[0]!.uri).toBe('https://broll.dev');
  });

  it('strips trailing punctuation from detected URLs', () => {
    const facets = detectLinkFacets('see https://example.com/page).');
    expect(facets[0]!.features[0]!.uri).toBe('https://example.com/page');
  });

  it('detects multiple links', () => {
    expect(detectLinkFacets('https://a.com and https://b.com')).toHaveLength(2);
  });

  it('returns no facets for plain text', () => {
    expect(detectLinkFacets('no links here')).toEqual([]);
  });
});

describe('fitImageToLimit', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'broll-bsky-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('passes small jpeg/png files through untouched', async () => {
    const file = path.join(dir, 'small.png');
    await sharp({ create: { width: 50, height: 50, channels: 3, background: '#333333' } })
      .png()
      .toFile(file);
    const { data, mime } = await fitImageToLimit(file);
    expect(mime).toBe('image/png');
    expect(data.byteLength).toBeLessThan(1_000_000);
  });

  it('recompresses oversized images under the 1MB blob limit', async () => {
    const file = path.join(dir, 'big.png');
    // Noise compresses badly — reliably produces a >1MB PNG.
    const noise = Buffer.from(Array.from({ length: 1400 * 1400 * 3 }, () => Math.floor(Math.random() * 256)));
    await sharp(noise, { raw: { width: 1400, height: 1400, channels: 3 } })
      .png({ compressionLevel: 0 })
      .toFile(file);

    const { data, mime } = await fitImageToLimit(file);
    expect(mime).toBe('image/jpeg');
    expect(data.byteLength).toBeLessThanOrEqual(1_000_000);
  });
});

describe('BlueskyAdapter', () => {
  const env = {
    BLUESKY_IDENTIFIER: 'broll.bsky.social',
    BLUESKY_APP_PASSWORD: 'app-pass',
  } as NodeJS.ProcessEnv;

  const draft: PostDraft = {
    id: 'dr_2',
    createdAt: new Date().toISOString(),
    posts: [{ text: 'shipping day — https://broll.dev', media: [] }],
    platforms: ['bluesky'],
    status: 'draft',
    results: {},
  };

  it('creates a session, then a post record with link facets and returns the app URL', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push(u);
      if (u.endsWith('createSession')) {
        expect(JSON.parse(String(init?.body))).toEqual({ identifier: 'broll.bsky.social', password: 'app-pass' });
        return new Response(JSON.stringify({ accessJwt: 'jwt', did: 'did:plc:abc', handle: 'broll.bsky.social' }), {
          status: 200,
        });
      }
      if (u.endsWith('createRecord')) {
        const body = JSON.parse(String(init?.body));
        expect(body.repo).toBe('did:plc:abc');
        expect(body.collection).toBe('app.bsky.feed.post');
        expect(body.record.text).toBe(draft.posts[0]!.text);
        expect(body.record.facets).toHaveLength(1);
        expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer jwt');
        return new Response(JSON.stringify({ uri: 'at://did:plc:abc/app.bsky.feed.post/3kxyz', cid: 'cid123' }), {
          status: 200,
        });
      }
      throw new Error(`unexpected call: ${u}`);
    });

    const adapter = new BlueskyAdapter(env, fetchMock as unknown as typeof fetch);
    const result = await adapter.publish(draft, [[]]);

    expect(calls).toHaveLength(2); // no blob upload for text-only
    expect(result.url).toBe('https://bsky.app/profile/broll.bsky.social/post/3kxyz');
    expect(result.remoteId).toBe('at://did:plc:abc/app.bsky.feed.post/3kxyz');
    expect(result.postedSegments).toBe(1);
  });

  it('publishes threads with reply refs rooted at the first post', async () => {
    const records: Array<Record<string, any>> = [];
    let n = 0;
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('createSession')) {
        return new Response(JSON.stringify({ accessJwt: 'jwt', did: 'did:plc:abc', handle: 'h.bsky.social' }), {
          status: 200,
        });
      }
      if (u.endsWith('createRecord')) {
        const body = JSON.parse(String(init?.body));
        records.push(body.record);
        n += 1;
        return new Response(JSON.stringify({ uri: `at://did:plc:abc/app.bsky.feed.post/rk${n}`, cid: `cid${n}` }), {
          status: 200,
        });
      }
      throw new Error(`unexpected: ${u}`);
    });

    const thread: PostDraft = {
      ...draft,
      posts: [
        { text: 'one', media: [] },
        { text: 'two', media: [] },
        { text: 'three', media: [] },
      ],
    };
    const adapter = new BlueskyAdapter(env, fetchMock as unknown as typeof fetch);
    const result = await adapter.publish(thread, [[], [], []]);

    expect(records[0]!.reply).toBeUndefined();
    expect(records[1]!.reply).toEqual({
      root: { uri: 'at://did:plc:abc/app.bsky.feed.post/rk1', cid: 'cid1' },
      parent: { uri: 'at://did:plc:abc/app.bsky.feed.post/rk1', cid: 'cid1' },
    });
    expect(records[2]!.reply).toEqual({
      root: { uri: 'at://did:plc:abc/app.bsky.feed.post/rk1', cid: 'cid1' },
      parent: { uri: 'at://did:plc:abc/app.bsky.feed.post/rk2', cid: 'cid2' },
    });
    expect(result.remoteId).toBe('at://did:plc:abc/app.bsky.feed.post/rk1');
    expect(result.postedSegments).toBe(3);
  });

  it('uploads image blobs and embeds them', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'broll-bsky-img-'));
    const imgPath = path.join(dir, 'pic.png');
    await sharp({ create: { width: 20, height: 20, channels: 3, background: '#ff0000' } })
      .png()
      .toFile(imgPath);

    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('createSession')) {
        return new Response(JSON.stringify({ accessJwt: 'jwt', did: 'did:plc:abc', handle: 'h.bsky.social' }), {
          status: 200,
        });
      }
      if (u.endsWith('uploadBlob')) {
        expect((init?.headers as Record<string, string>)['Content-Type']).toBe('image/png');
        return new Response(JSON.stringify({ blob: { $type: 'blob', ref: { $link: 'bafy123' } } }), { status: 200 });
      }
      if (u.endsWith('createRecord')) {
        const body = JSON.parse(String(init?.body));
        expect(body.record.embed.$type).toBe('app.bsky.embed.images');
        expect(body.record.embed.images).toHaveLength(1);
        return new Response(JSON.stringify({ uri: 'at://x/app.bsky.feed.post/1', cid: 'c' }), { status: 200 });
      }
      throw new Error(`unexpected: ${u}`);
    });

    const adapter = new BlueskyAdapter(env, fetchMock as unknown as typeof fetch);
    await adapter.publish(
      { ...draft, posts: [{ text: 'with image', media: [] }] },
      [[{ path: imgPath, kind: 'image', sizeBytes: 100 }]],
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
    rmSync(dir, { recursive: true, force: true });
  });

  it('surfaces auth failures with the xrpc endpoint name', async () => {
    const fetchMock = vi.fn(async () => new Response('{"error":"AuthenticationRequired"}', { status: 401 }));
    const adapter = new BlueskyAdapter(env, fetchMock as unknown as typeof fetch);
    await expect(adapter.publish(draft, [[]])).rejects.toThrow(/createSession.*401/s);
  });
});
