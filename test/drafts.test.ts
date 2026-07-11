import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sequentialIds } from '../src/ids.js';
import { DraftStore } from '../src/social/drafts.js';
import { Workspace } from '../src/workspace.js';

let dir: string;
let ws: Workspace;
let store: DraftStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'broll-drafts-'));
  ws = new Workspace(path.join(dir, 'ws'), { idGenerator: sequentialIds() });
  store = new DraftStore(ws);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('DraftStore', () => {
  it('lifts pre-thread draft files (top-level text/media) on read', () => {
    // A draft written by v0.1.0, before posts[] existed.
    writeFileSync(
      path.join(ws.draftsDir, 'dr_legacy.json'),
      JSON.stringify({
        id: 'dr_legacy',
        createdAt: '2026-07-10T00:00:00.000Z',
        text: 'old-style draft',
        media: ['ast_000001'],
        platforms: ['export'],
        status: 'draft',
        results: {},
      }),
    );

    const draft = store.get('dr_legacy');
    expect(draft.posts).toEqual([{ text: 'old-style draft', media: ['ast_000001'] }]);
    expect(store.list().some((d) => d.id === 'dr_legacy')).toBe(true);
  });

  it('round-trips thread drafts', () => {
    const created = store.create({
      posts: [
        { text: 'one', media: [] },
        { text: 'two', media: [] },
      ],
      platforms: ['bluesky'],
    });
    const loaded = store.get(created.id);
    expect(loaded.posts).toHaveLength(2);
    expect(loaded.status).toBe('draft');
  });

  it('computes cumulative status across partial publishes', () => {
    const created = store.create({ posts: [{ text: 'hi', media: [] }], platforms: ['bluesky', 'export'] });
    const afterOne = store.recordResults(created.id, {
      export: { ok: true, at: new Date().toISOString() },
    });
    expect(afterOne.status).toBe('partial');
    const afterBoth = store.recordResults(created.id, {
      bluesky: { ok: true, at: new Date().toISOString() },
    });
    expect(afterBoth.status).toBe('published');
  });
});
