import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import type { FetchLike } from '../providers/types.js';
import { readErrorBody } from '../providers/types.js';
import type { PlatformAdapter, PostDraft, ResolvedMedia } from './types.js';

/**
 * Bluesky is the one network a developer can post to five minutes after
 * signing up — no app review, just a handle and an app password — which
 * makes it Backlot's reference live adapter.
 */

interface Facet {
  index: { byteStart: number; byteEnd: number };
  features: Array<{ $type: 'app.bsky.richtext.facet#link'; uri: string }>;
}

const URL_REGEX = /https?:\/\/[^\s]+/g;

/** Link facets use UTF-8 byte offsets — the classic AT-proto gotcha. */
export function detectLinkFacets(text: string): Facet[] {
  const facets: Facet[] = [];
  for (const match of text.matchAll(URL_REGEX)) {
    // Trailing punctuation is almost never part of the URL a human meant.
    const raw = match[0];
    const uri = raw.replace(/[).,;!?]+$/, '');
    const byteStart = Buffer.byteLength(text.slice(0, match.index), 'utf8');
    const byteEnd = byteStart + Buffer.byteLength(uri, 'utf8');
    facets.push({
      index: { byteStart, byteEnd },
      features: [{ $type: 'app.bsky.richtext.facet#link', uri }],
    });
  }
  return facets;
}

/** Recompress until the image fits Bluesky's 1MB blob limit. */
export async function fitImageToLimit(filePath: string, limitBytes = 1_000_000): Promise<{ data: Buffer; mime: string }> {
  const original = readFileSync(filePath);
  if (original.byteLength <= limitBytes && /\.(jpe?g|png)$/i.test(filePath)) {
    return { data: original, mime: filePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg' };
  }
  let quality = 90;
  let width: number | undefined;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let pipeline = sharp(original);
    if (width) pipeline = pipeline.resize({ width, withoutEnlargement: true });
    const data = await pipeline.jpeg({ quality }).toBuffer();
    if (data.byteLength <= limitBytes) return { data, mime: 'image/jpeg' };
    if (quality > 55) {
      quality -= 10;
    } else {
      const meta = await sharp(original).metadata();
      width = Math.round((width ?? meta.width ?? 2000) * 0.75);
    }
  }
  throw new Error(`Could not compress ${filePath} under ${limitBytes} bytes for Bluesky.`);
}

export class BlueskyAdapter implements PlatformAdapter {
  readonly platform = 'bluesky' as const;
  readonly configHelp =
    'Set BLUESKY_IDENTIFIER (your handle, e.g. backlot.bsky.social) and BLUESKY_APP_PASSWORD ' +
    '(Settings → App Passwords — never your real password).';

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly fetchImpl: FetchLike = globalThis.fetch,
  ) {}

  private get service(): string {
    return this.env.BLUESKY_SERVICE ?? 'https://bsky.social';
  }

  isConfigured(): boolean {
    return Boolean(this.env.BLUESKY_IDENTIFIER && this.env.BLUESKY_APP_PASSWORD);
  }

  private async xrpc<T>(path: string, init: RequestInit): Promise<T> {
    const res = await this.fetchImpl(`${this.service}/xrpc/${path}`, init);
    if (!res.ok) {
      throw new Error(`Bluesky ${path} failed (${res.status}): ${await readErrorBody(res)}`);
    }
    return (await res.json()) as T;
  }

  async publish(draft: PostDraft, media: ResolvedMedia[]): Promise<{ url?: string; remoteId?: string }> {
    const session = await this.xrpc<{ accessJwt: string; did: string; handle: string }>(
      'com.atproto.server.createSession',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: this.env.BLUESKY_IDENTIFIER,
          password: this.env.BLUESKY_APP_PASSWORD,
        }),
      },
    );
    const auth = { Authorization: `Bearer ${session.accessJwt}` };

    const images = media.filter((m) => m.kind === 'image').slice(0, 4);
    const blobs: unknown[] = [];
    for (const image of images) {
      const { data, mime } = await fitImageToLimit(image.path);
      const uploaded = await this.xrpc<{ blob: unknown }>('com.atproto.repo.uploadBlob', {
        method: 'POST',
        headers: { ...auth, 'Content-Type': mime },
        body: new Uint8Array(data),
      });
      blobs.push(uploaded.blob);
    }

    const record: Record<string, unknown> = {
      $type: 'app.bsky.feed.post',
      text: draft.text,
      createdAt: new Date().toISOString(),
    };
    const facets = detectLinkFacets(draft.text);
    if (facets.length) record.facets = facets;
    if (blobs.length) {
      record.embed = {
        $type: 'app.bsky.embed.images',
        images: blobs.map((blob) => ({ image: blob, alt: '' })),
      };
    }

    const created = await this.xrpc<{ uri: string; cid: string }>('com.atproto.repo.createRecord', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: session.did, collection: 'app.bsky.feed.post', record }),
    });

    const rkey = created.uri.split('/').pop();
    return {
      remoteId: created.uri,
      url: rkey ? `https://bsky.app/profile/${session.handle}/post/${rkey}` : undefined,
    };
  }
}
