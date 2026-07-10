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

  resolveMedia(draft: PostDraft): ResolvedMedia[] {
    return draft.media.map((ref) => {
      const filePath = this.workspace.resolvePath(ref);
      return { path: filePath, kind: kindFromPath(filePath), sizeBytes: statSync(filePath).size };
    });
  }

  validate(draft: PostDraft): Violation[] {
    const media = this.resolveMedia(draft);
    return draft.platforms.flatMap((p) => validateForPlatform(p, draft.text, media));
  }

  adapterStatus(): Array<{ platform: Platform; configured: boolean; configHelp: string }> {
    return [...this.adapters.values()].map((a) => ({
      platform: a.platform,
      configured: a.isConfigured(),
      configHelp: a.configHelp,
    }));
  }

  /**
   * Publish a draft to every platform it targets. Never throws for a
   * single platform's failure — each platform reports independently and
   * the draft records exactly what happened where.
   */
  async publish(draftId: string): Promise<PublishOutcome> {
    const draft = this.drafts.get(draftId);
    const media = this.resolveMedia(draft);
    const results: Record<string, PublishResult> = {};

    for (const platform of draft.platforms) {
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
      const violations = validateForPlatform(platform, draft.text, media);
      if (violations.length > 0) {
        results[platform] = { ok: false, error: violations.map((v) => v.message).join(' '), at };
        continue;
      }
      try {
        const { url, remoteId } = await adapter.publish(draft, media);
        results[platform] = { ok: true, url, remoteId, at };
      } catch (error) {
        results[platform] = { ok: false, error: error instanceof Error ? error.message : String(error), at };
      }
    }

    const updated = this.drafts.recordResults(draftId, results);
    return { draft: updated, results };
  }
}
