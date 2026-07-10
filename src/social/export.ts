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

  async publish(draft: PostDraft, media: ResolvedMedia[]): Promise<{ url?: string; remoteId?: string }> {
    const dir = path.join(this.workspace.rendersDir, `${draft.id}-export`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'text.txt'), draft.text, 'utf8');
    const copied: string[] = [];
    for (const [i, m] of media.entries()) {
      const dest = path.join(dir, `media-${i + 1}${path.extname(m.path)}`);
      copyFileSync(m.path, dest);
      copied.push(dest);
    }
    writeFileSync(
      path.join(dir, 'post.json'),
      JSON.stringify({ text: draft.text, media: copied, platforms: draft.platforms, draftId: draft.id }, null, 2),
    );
    return { url: dir, remoteId: draft.id };
  }
}
