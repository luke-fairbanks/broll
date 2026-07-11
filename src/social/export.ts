import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Workspace } from '../workspace.js';
import type { PlatformAdapter, PostDraft, ResolvedMedia } from './types.js';

/**
 * The zero-credential adapter: "publishing" writes a ready-to-post
 * bundle (text + media + metadata) the user can drag into any composer.
 * Always configured, so every workflow has a working end state.
 */
export class ExportAdapter implements PlatformAdapter {
  readonly platform = 'export' as const;
  readonly configHelp = 'Always available — writes a ready-to-post folder into the workspace.';

  constructor(private readonly workspace: Workspace) {}

  isConfigured(): boolean {
    return true;
  }

  async publish(
    draft: PostDraft,
    mediaPerSegment: ResolvedMedia[][],
  ): Promise<{ url?: string; remoteId?: string; postedSegments?: number }> {
    const dir = path.join(this.workspace.rendersDir, `${draft.id}-export`);
    mkdirSync(dir, { recursive: true });

    const manifest: Array<{ text: string; media: string[] }> = [];
    for (const [i, segment] of draft.posts.entries()) {
      const prefix = draft.posts.length > 1 ? `post-${i + 1}-` : '';
      writeFileSync(path.join(dir, `${prefix}text.txt`), segment.text, 'utf8');
      const copied: string[] = [];
      for (const [j, m] of (mediaPerSegment[i] ?? []).entries()) {
        const dest = path.join(dir, `${prefix}media-${j + 1}${path.extname(m.path)}`);
        copyFileSync(m.path, dest);
        copied.push(dest);
      }
      manifest.push({ text: segment.text, media: copied });
    }

    writeFileSync(
      path.join(dir, 'post.json'),
      JSON.stringify({ posts: manifest, platforms: draft.platforms, draftId: draft.id }, null, 2),
    );
    return { url: dir, remoteId: draft.id, postedSegments: draft.posts.length };
  }
}
