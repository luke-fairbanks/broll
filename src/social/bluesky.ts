import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import type { FetchLike } from '../providers/types.js';
import { readErrorBody } from '../providers/types.js';
import type { PlatformAdapter, PostDraft, ResolvedMedia } from './types.js';

/**
 * Bluesky is the one network a developer can post to five minutes after
 * signing up — no app review, just a handle and an app password — which
 * makes it broll's reference live adapter.
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
    'Set BLUESKY_IDENTIFIER (your handle, e.g. broll.bsky.social) and BLUESKY_APP_PASSWORD ' +
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

  private async createSession(): Promise<{ auth: Record<string, string>; did: string; handle: string }> {
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
    return { auth: { Authorization: `Bearer ${session.accessJwt}` }, did: session.did, handle: session.handle };
  }

  private async uploadImages(auth: Record<string, string>, media: ResolvedMedia[]): Promise<unknown[]> {
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
    return blobs;
  }

  /** Multi-segment drafts publish as a reply-chained thread under the first post. */
  async publish(
    draft: PostDraft,
    mediaPerSegment: ResolvedMedia[][],
  ): Promise<{ url?: string; remoteId?: string; postedSegments?: number }> {
    const { auth, did, handle } = await this.createSession();

    let root: { uri: string; cid: string } | undefined;
    let parent: { uri: string; cid: string } | undefined;
    let posted = 0;

    for (const [i, segment] of draft.posts.entries()) {
      const blobs = await this.uploadImages(auth, mediaPerSegment[i] ?? []);

      const record: Record<string, unknown> = {
        $type: 'app.bsky.feed.post',
        text: segment.text,
        createdAt: new Date().toISOString(),
      };
      const facets = detectLinkFacets(segment.text);
      if (facets.length) record.facets = facets;
      if (blobs.length) {
        record.embed = {
          $type: 'app.bsky.embed.images',
          images: blobs.map((blob) => ({ image: blob, alt: '' })),
        };
      }
      if (root && parent) {
        record.reply = { root, parent };
      }

      try {
        const created = await this.xrpc<{ uri: string; cid: string }>('com.atproto.repo.createRecord', {
          method: 'POST',
          headers: { ...auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ repo: did, collection: 'app.bsky.feed.post', record }),
        });
        posted += 1;
        parent = { uri: created.uri, cid: created.cid };
        root = root ?? parent;
      } catch (error) {
        if (root) {
          // Partial thread: surface how far we got instead of losing that fact.
          throw new Error(
            `Thread broke at post ${i + 1}/${draft.posts.length} (${posted} published, root ${root.uri}): ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        throw error;
      }
    }

    const rkey = root!.uri.split('/').pop();
    return {
      remoteId: root!.uri,
      url: rkey ? `https://bsky.app/profile/${handle}/post/${rkey}` : undefined,
      postedSegments: posted,
    };
  }

  /** Update profile fields, merging with the existing record (never clobbers). */
  async setProfile(fields: { displayName?: string; description?: string; avatarPath?: string }): Promise<void> {
    const { auth, did } = await this.createSession();

    const getRes = await this.fetchImpl(
      `${this.service}/xrpc/com.atproto.repo.getRecord?repo=${did}&collection=app.bsky.actor.profile&rkey=self`,
      { headers: auth },
    );
    const existing = getRes.ok ? ((await getRes.json()) as { value?: Record<string, unknown> }).value ?? {} : {};

    const record: Record<string, unknown> = { ...existing, $type: 'app.bsky.actor.profile' };
    if (fields.displayName !== undefined) record.displayName = fields.displayName;
    if (fields.description !== undefined) record.description = fields.description;
    if (fields.avatarPath) {
      const { data, mime } = await fitImageToLimit(fields.avatarPath);
      const uploaded = await this.xrpc<{ blob: unknown }>('com.atproto.repo.uploadBlob', {
        method: 'POST',
        headers: { ...auth, 'Content-Type': mime },
        body: new Uint8Array(data),
      });
      record.avatar = uploaded.blob;
    }

    await this.xrpc('com.atproto.repo.putRecord', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: did, collection: 'app.bsky.actor.profile', rkey: 'self', record }),
    });
  }

  /** Cheap live credential check: can we open a session? */
  async probe(): Promise<{ ok: boolean; detail: string }> {
    try {
      const { handle } = await this.createSession();
      return { ok: true, detail: `session ok as ${handle}` };
    } catch (error) {
      return {
        ok: false,
        detail: `${error instanceof Error ? error.message : String(error)} — if you renamed your handle, update BLUESKY_IDENTIFIER.`,
      };
    }
  }
}
