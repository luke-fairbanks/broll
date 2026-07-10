import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Workspace } from '../workspace.js';
import { PostDraftSchema, type Platform, type PostDraft, type PublishResult } from './types.js';

/**
 * The outbox. Drafts are plain JSON files a human can open, diff, and
 * delete. Nothing is ever published that isn't first a reviewable file
 * on disk — that is broll's core safety property.
 */
export class DraftStore {
  constructor(private readonly workspace: Workspace) {}

  private fileFor(id: string): string {
    return path.join(this.workspace.draftsDir, `${id}.json`);
  }

  create(input: { text: string; media: string[]; platforms: Platform[] }): PostDraft {
    const id = `dr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const draft = PostDraftSchema.parse({
      id,
      createdAt: new Date().toISOString(),
      text: input.text,
      media: input.media,
      platforms: input.platforms,
    });
    this.write(draft);
    return draft;
  }

  get(id: string): PostDraft {
    const file = this.fileFor(id);
    if (!existsSync(file)) {
      throw new Error(`No draft "${id}". Use list_drafts to see what exists.`);
    }
    return PostDraftSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  }

  list(): PostDraft[] {
    return readdirSync(this.workspace.draftsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => PostDraftSchema.parse(JSON.parse(readFileSync(path.join(this.workspace.draftsDir, f), 'utf8'))))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  recordResults(id: string, results: Record<string, PublishResult>): PostDraft {
    const draft = this.get(id);
    draft.results = { ...draft.results, ...results };
    const succeeded = draft.platforms.filter((p) => draft.results[p]?.ok);
    draft.status =
      succeeded.length === 0 ? 'failed' : succeeded.length === draft.platforms.length ? 'published' : 'partial';
    this.write(draft);
    return draft;
  }

  private write(draft: PostDraft): void {
    const file = this.fileFor(draft.id);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(draft, null, 2));
    renameSync(tmp, file);
  }
}
