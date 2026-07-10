import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { FetchLike } from '../providers/types.js';
import { readErrorBody } from '../providers/types.js';
import type { PlatformAdapter, PostDraft, ResolvedMedia } from './types.js';

/**
 * X (Twitter) adapter. v2 create-tweet + v1.1 media upload, signed with
 * OAuth 1.0a user context — fiddly, but it works on the free API tier
 * with the user's own app credentials, which fits broll's BYO ethos.
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
    private readonly uploadBase = 'https://upload.twitter.com',
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
    const url = `${this.uploadBase}/1.1/media/upload.json`;
    const form = new FormData();
    // multipart bodies are excluded from the OAuth 1.0a signature base string
    form.append('media_data', readFileSync(media.path).toString('base64'));
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: this.authHeader('POST', url) },
      body: form,
    });
    if (!res.ok) {
      throw new Error(`X media upload failed (${res.status}): ${await readErrorBody(res)}`);
    }
    const json = (await res.json()) as { media_id_string?: string };
    if (!json.media_id_string) throw new Error('X media upload returned no media_id_string.');
    return json.media_id_string;
  }

  async publish(draft: PostDraft, media: ResolvedMedia[]): Promise<{ url?: string; remoteId?: string }> {
    const images = media.filter((m) => m.kind === 'image').slice(0, 4);
    const mediaIds: string[] = [];
    for (const image of images) {
      mediaIds.push(await this.uploadImage(image));
    }

    const url = `${this.apiBase}/2/tweets`;
    const body: Record<string, unknown> = { text: draft.text };
    if (mediaIds.length) body.media = { media_ids: mediaIds };

    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: this.authHeader('POST', url), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`X create tweet failed (${res.status}): ${await readErrorBody(res)}`);
    }
    const json = (await res.json()) as { data?: { id?: string } };
    const id = json.data?.id;
    return { remoteId: id, url: id ? `https://x.com/i/status/${id}` : undefined };
  }
}
