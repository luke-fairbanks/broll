import { statSync } from 'node:fs';
import type { Workspace } from '../workspace.js';
import { kindFromPath } from '../workspace.js';
import { validateForPlatform, type Violation } from './constraints.js';
import type { DraftStore } from './drafts.js';
import type { Platform, PlatformAdapter, PostDraft, PublishResult, ResolvedMedia } from './types.js';

export interface PublishOutcome {
  draft: PostDraft;
  results: Record<string, PublishResult>;
}

export class Publisher {
  private readonly adapters: Map<Platform, PlatformAdapter>;

  constructor(
    private readonly workspace: Workspace,
    private readonly drafts: DraftStore,
    adapters: PlatformAdapter[],
  ) {
    this.adapters = new Map(adapters.map((a) => [a.platform, a]));
  }

  /** mediaPerSegment[i] corresponds to draft.posts[i]. */
  resolveMedia(draft: PostDraft): ResolvedMedia[][] {
    return draft.posts.map((segment) =>
      segment.media.map((ref) => {
        const filePath = this.workspace.resolvePath(ref);
        return { path: filePath, kind: kindFromPath(filePath), sizeBytes: statSync(filePath).size };
      }),
    );
  }

  validate(draft: PostDraft): Violation[] {
    const mediaPerSegment = this.resolveMedia(draft);
    return draft.platforms.flatMap((platform) =>
      draft.posts.flatMap((segment, i) =>
        validateForPlatform(platform, segment.text, mediaPerSegment[i]!).map((v) =>
          draft.posts.length > 1 ? { ...v, message: `[post ${i + 1}/${draft.posts.length}] ${v.message}` } : v,
        ),
      ),
    );
  }

  adapterStatus(): Array<{ platform: Platform; configured: boolean; configHelp: string }> {
    return [...this.adapters.values()].map((a) => ({
      platform: a.platform,
      configured: a.isConfigured(),
      configHelp: a.configHelp,
    }));
  }

  /**
   * Publish a draft to its target platforms (optionally a subset).
   * Never throws for a single platform's failure — each platform
   * reports independently and the draft records what happened where.
   * Re-publishing to a platform that already succeeded is refused, so
   * retrying a partial draft can never double-post.
   */
  async publish(draftId: string, opts: { platforms?: Platform[] } = {}): Promise<PublishOutcome> {
    const draft = this.drafts.get(draftId);

    let targets = draft.platforms;
    if (opts.platforms?.length) {
      const unknown = opts.platforms.filter((p) => !draft.platforms.includes(p));
      if (unknown.length) {
        throw new Error(
          `Draft ${draftId} does not target: ${unknown.join(', ')}. Its platforms are: ${draft.platforms.join(', ')}.`,
        );
      }
      targets = opts.platforms;
    }

    const alreadyPublished = targets.filter((p) => draft.results[p]?.ok);
    if (alreadyPublished.length) {
      throw new Error(
        `Draft ${draftId} already published to ${alreadyPublished.join(', ')} — refusing to double-post. ` +
          `Create a new draft, or pass platforms: [...] targeting only the remaining ones.`,
      );
    }

    const mediaPerSegment = this.resolveMedia(draft);
    const results: Record<string, PublishResult> = {};

    for (const platform of targets) {
      const at = new Date().toISOString();
      const adapter = this.adapters.get(platform);
      if (!adapter) {
        results[platform] = { ok: false, error: `No adapter for "${platform}".`, at };
        continue;
      }
      if (!adapter.isConfigured()) {
        results[platform] = { ok: false, error: `Not configured. ${adapter.configHelp}`, at };
        continue;
      }
      const violations = draft.posts.flatMap((segment, i) =>
        validateForPlatform(platform, segment.text, mediaPerSegment[i]!),
      );
      if (violations.length > 0) {
        results[platform] = { ok: false, error: violations.map((v) => v.message).join(' '), at };
        continue;
      }
      try {
        const { url, remoteId, postedSegments } = await adapter.publish(draft, mediaPerSegment);
        results[platform] = { ok: true, url, remoteId, postedSegments, at };
      } catch (error) {
        results[platform] = { ok: false, error: error instanceof Error ? error.message : String(error), at };
      }
    }

    const updated = this.drafts.recordResults(draftId, results);
    return { draft: updated, results };
  }
}
