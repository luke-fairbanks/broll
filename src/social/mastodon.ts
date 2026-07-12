import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { FetchLike } from '../providers/types.js';
import { readErrorBody } from '../providers/types.js';
import type { PlatformAdapter, PostDraft, ResolvedMedia } from './types.js';

/**
 * Mastodon adapter. The friendliest API in social: no app review, no
 * credits — create an application under Preferences → Development on
 * your instance and paste its access token. Works with any instance.
 */
export class MastodonAdapter implements PlatformAdapter {
  readonly platform = 'mastodon' as const;
  readonly configHelp =
    'Set MASTODON_ACCESS_TOKEN (your instance → Preferences → Development → New application, ' +
    'scopes write:statuses + write:media) and optionally MASTODON_INSTANCE (default https://mastodon.social).';

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly fetchImpl: FetchLike = globalThis.fetch,
    private readonly pollIntervalMs = 1000,
    private readonly pollTimeoutMs = 60_000,
  ) {}

  private get instance(): string {
    return (this.env.MASTODON_INSTANCE ?? 'https://mastodon.social').replace(/\/$/, '');
  }

  isConfigured(): boolean {
    return Boolean(this.env.MASTODON_ACCESS_TOKEN);
  }

  private auth(): Record<string, string> {
    return { Authorization: `Bearer ${this.env.MASTODON_ACCESS_TOKEN}` };
  }

  private async uploadMedia(media: ResolvedMedia): Promise<string> {
    const form = new FormData();
    const bytes = readFileSync(media.path);
    form.append('file', new Blob([new Uint8Array(bytes)]), path.basename(media.path));

    const res = await this.fetchImpl(`${this.instance}/api/v2/media`, {
      method: 'POST',
      headers: this.auth(),
      body: form,
    });
    if (!res.ok) {
      throw new Error(`Mastodon media upload failed (${res.status}): ${await readErrorBody(res)}`);
    }
    const { id } = (await res.json()) as { id: string };

    if (res.status === 202) {
      // Still processing (video/large files) — poll until the attachment is ready.
      const deadline = Date.now() + this.pollTimeoutMs;
      for (;;) {
        if (Date.now() > deadline) throw new Error(`Mastodon media ${id} still processing after ${this.pollTimeoutMs / 1000}s.`);
        await new Promise((r) => setTimeout(r, this.pollIntervalMs));
        const poll = await this.fetchImpl(`${this.instance}/api/v1/media/${id}`, { headers: this.auth() });
        if (poll.status === 200) break;
        if (!poll.ok && poll.status !== 206) {
          throw new Error(`Mastodon media poll failed (${poll.status}): ${await readErrorBody(poll)}`);
        }
      }
    }
    return id;
  }

  /** Multi-segment drafts publish as a reply chain under the first status. */
  async publish(
    draft: PostDraft,
    mediaPerSegment: ResolvedMedia[][],
  ): Promise<{ url?: string; remoteId?: string; postedSegments?: number }> {
    let rootId: string | undefined;
    let rootUrl: string | undefined;
    let previousId: string | undefined;
    let posted = 0;

    for (const [i, segment] of draft.posts.entries()) {
      const mediaIds: string[] = [];
      for (const m of (mediaPerSegment[i] ?? []).filter((x) => x.kind === 'image' || x.kind === 'video').slice(0, 4)) {
        mediaIds.push(await this.uploadMedia(m));
      }

      const body: Record<string, unknown> = { status: segment.text };
      if (mediaIds.length) body.media_ids = mediaIds;
      if (previousId) body.in_reply_to_id = previousId;

      const res = await this.fetchImpl(`${this.instance}/api/v1/statuses`, {
        method: 'POST',
        headers: { ...this.auth(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = `Mastodon post failed (${res.status}): ${await readErrorBody(res)}`;
        if (rootId) {
          throw new Error(
            `Thread broke at post ${i + 1}/${draft.posts.length} (${posted} published, root ${rootUrl ?? rootId}): ${detail}`,
          );
        }
        throw new Error(detail);
      }
      const json = (await res.json()) as { id: string; url?: string };
      posted += 1;
      previousId = json.id;
      if (!rootId) {
        rootId = json.id;
        rootUrl = json.url;
      }
    }

    return { remoteId: rootId, url: rootUrl, postedSegments: posted };
  }

  /** Cheap live credential check. */
  async probe(): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await this.fetchImpl(`${this.instance}/api/v1/accounts/verify_credentials`, {
        headers: this.auth(),
      });
      if (!res.ok) {
        return { ok: false, detail: `verify_credentials returned ${res.status}: ${await readErrorBody(res)}` };
      }
      const json = (await res.json()) as { acct?: string };
      return { ok: true, detail: `authenticated as @${json.acct ?? 'unknown'} on ${this.instance}` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }
}
