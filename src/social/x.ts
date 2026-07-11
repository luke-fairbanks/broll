import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { FetchLike } from '../providers/types.js';
import { readErrorBody } from '../providers/types.js';
import type { PlatformAdapter, PostDraft, ResolvedMedia } from './types.js';

/**
 * X (Twitter) adapter. v2 create-tweet + v2 media upload, signed with
 * OAuth 1.0a user context — fiddly, but it works on the free API tier
 * with the user's own app credentials, which fits broll's BYO ethos.
 * The app must have "Read and write" permission and tokens generated
 * AFTER that permission was set.
 */

export interface OAuth1Credentials {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

/** RFC 3986 percent-encoding — stricter than encodeURIComponent. */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export interface OAuth1SignatureInput {
  method: 'POST' | 'GET';
  url: string;
  /** Query + x-www-form-urlencoded body params (NOT JSON bodies, NOT multipart). */
  params: Record<string, string>;
  credentials: OAuth1Credentials;
  nonce: string;
  timestampSec: number;
}

export function buildOAuth1Header(input: OAuth1SignatureInput): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: input.credentials.consumerKey,
    oauth_nonce: input.nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(input.timestampSec),
    oauth_token: input.credentials.accessToken,
    oauth_version: '1.0',
  };

  const allParams = { ...input.params, ...oauthParams };
  const paramString = Object.entries(allParams)
    .map(([k, v]) => [percentEncode(k), percentEncode(v)] as const)
    .sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const baseString = [input.method, percentEncode(input.url), percentEncode(paramString)].join('&');
  const signingKey = `${percentEncode(input.credentials.consumerSecret)}&${percentEncode(input.credentials.accessTokenSecret)}`;
  const signature = createHmac('sha1', signingKey).update(baseString).digest('base64');

  const headerParams = { ...oauthParams, oauth_signature: signature };
  const header = Object.entries(headerParams)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${percentEncode(k)}="${percentEncode(v)}"`)
    .join(', ');
  return `OAuth ${header}`;
}

export class XAdapter implements PlatformAdapter {
  readonly platform = 'x' as const;
  readonly configHelp =
    'Create an app at developer.x.com (free tier works for posting), then set X_API_KEY, X_API_SECRET, ' +
    'X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET (with Read and Write permissions).';

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly fetchImpl: FetchLike = globalThis.fetch,
    private readonly apiBase = 'https://api.x.com',
  ) {}

  isConfigured(): boolean {
    return Boolean(
      this.env.X_API_KEY && this.env.X_API_SECRET && this.env.X_ACCESS_TOKEN && this.env.X_ACCESS_TOKEN_SECRET,
    );
  }

  private credentials(): OAuth1Credentials {
    return {
      consumerKey: this.env.X_API_KEY!,
      consumerSecret: this.env.X_API_SECRET!,
      accessToken: this.env.X_ACCESS_TOKEN!,
      accessTokenSecret: this.env.X_ACCESS_TOKEN_SECRET!,
    };
  }

  private authHeader(method: 'POST' | 'GET', url: string, params: Record<string, string> = {}): string {
    return buildOAuth1Header({
      method,
      url,
      params,
      credentials: this.credentials(),
      nonce: randomBytes(16).toString('hex'),
      timestampSec: Math.floor(Date.now() / 1000),
    });
  }

  private async uploadImage(media: ResolvedMedia): Promise<string> {
    // v2 media upload — the legacy upload.twitter.com/1.1 endpoint returns
    // blank 403s on current API tiers.
    const url = `${this.apiBase}/2/media/upload`;
    const form = new FormData();
    // multipart bodies are excluded from the OAuth 1.0a signature base string
    const bytes = readFileSync(media.path);
    form.append('media', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), path.basename(media.path));
    form.append('media_category', 'tweet_image');
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: this.authHeader('POST', url) },
      body: form,
    });
    if (!res.ok) {
      const body = await readErrorBody(res);
      const hint = body.includes('oauth1-permissions')
        ? ' Your app’s access token is read-only: set the app to "Read and write" in the X developer portal, regenerate the Access Token & Secret, and update X_ACCESS_TOKEN / X_ACCESS_TOKEN_SECRET.'
        : '';
      throw new Error(`X media upload failed (${res.status}): ${body}${hint}`);
    }
    const json = (await res.json()) as { data?: { id?: string; media_key?: string }; media_id_string?: string };
    const id = json.data?.id ?? json.media_id_string;
    if (!id) throw new Error('X media upload returned no media id.');
    return id;
  }

  /** Multi-segment drafts publish as a reply-chained thread under the first tweet. */
  async publish(
    draft: PostDraft,
    mediaPerSegment: ResolvedMedia[][],
  ): Promise<{ url?: string; remoteId?: string; postedSegments?: number }> {
    let rootId: string | undefined;
    let previousId: string | undefined;
    let posted = 0;

    for (const [i, segment] of draft.posts.entries()) {
      const images = (mediaPerSegment[i] ?? []).filter((m) => m.kind === 'image').slice(0, 4);
      const mediaIds: string[] = [];
      for (const image of images) {
        mediaIds.push(await this.uploadImage(image));
      }

      const url = `${this.apiBase}/2/tweets`;
      const body: Record<string, unknown> = { text: segment.text };
      if (mediaIds.length) body.media = { media_ids: mediaIds };
      if (previousId) body.reply = { in_reply_to_tweet_id: previousId };

      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: this.authHeader('POST', url), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = `X create tweet failed (${res.status}): ${await readErrorBody(res)}`;
        if (rootId) {
          throw new Error(
            `Thread broke at post ${i + 1}/${draft.posts.length} (${posted} published, root ${rootId}): ${detail}`,
          );
        }
        throw new Error(detail);
      }
      const json = (await res.json()) as { data?: { id?: string } };
      const id = json.data?.id;
      if (!id) throw new Error('X returned no tweet id.');
      posted += 1;
      previousId = id;
      rootId = rootId ?? id;
    }

    return {
      remoteId: rootId,
      url: rootId ? `https://x.com/i/status/${rootId}` : undefined,
      postedSegments: posted,
    };
  }

  /** Cheap live credential check: GET /2/users/me with a signed request. */
  async probe(): Promise<{ ok: boolean; detail: string }> {
    try {
      const url = `${this.apiBase}/2/users/me`;
      const res = await this.fetchImpl(url, { headers: { Authorization: this.authHeader('GET', url) } });
      if (!res.ok) {
        return { ok: false, detail: `X /2/users/me returned ${res.status}: ${await readErrorBody(res)}` };
      }
      const json = (await res.json()) as { data?: { username?: string } };
      return { ok: true, detail: `authenticated as @${json.data?.username ?? 'unknown'}` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }
}
