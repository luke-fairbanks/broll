import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sequentialIds } from '../src/ids.js';
import { Workspace, kindFromPath } from '../src/workspace.js';

let dir: string;
let ws: Workspace;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'broll-ws-'));
  ws = new Workspace(path.join(dir, 'workspace'), { idGenerator: sequentialIds() });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('Workspace', () => {
  it('imports files, registers them, and resolves by id', () => {
    const src = path.join(dir, 'photo.png');
    writeFileSync(src, 'not-really-a-png');

    const asset = ws.importAsset(src, { label: 'hero' });
    expect(asset.id).toBe('ast_000001');
    expect(asset.kind).toBe('image');
    expect(ws.listAssets()).toHaveLength(1);
    expect(ws.resolvePath('ast_000001')).toBe(asset.path);
  });

  it('resolves absolute paths that exist', () => {
    const src = path.join(dir, 'clip.mp4');
    writeFileSync(src, 'x');
    expect(ws.resolvePath(src)).toBe(src);
  });

  it('gives an actionable error for unknown references', () => {
    expect(() => ws.resolvePath('ast_nope')).toThrow(/list_assets/);
  });

  it('errors when importing a missing file', () => {
    expect(() => ws.importAsset('/nope/missing.png')).toThrow(/not found/);
  });

  it('detects media kinds from extensions', () => {
    expect(kindFromPath('a.PNG')).toBe('image');
    expect(kindFromPath('b.mov')).toBe('video');
    expect(kindFromPath('c.m4a')).toBe('audio');
    expect(kindFromPath('d.txt')).toBe('other');
  });

  it('reserves distinct id-named output paths', () => {
    const a = ws.newFilePath('renders', 'mp4');
    const b = ws.newFilePath('renders', '.mp4');
    expect(a.path).not.toBe(b.path);
    expect(a.path.endsWith('.mp4')).toBe(true);
    expect(b.path.endsWith('.mp4')).toBe(true);
  });
});
