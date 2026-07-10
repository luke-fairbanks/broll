import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { IdGenerator } from './ids.js';
import { randomId } from './ids.js';

/**
 * The workspace is Backlot's on-disk state: imported assets, rendered
 * outputs, and the post-draft outbox. Everything an agent produces flows
 * through here so results are inspectable files, never hidden state.
 *
 * Layout:
 *   <workspace>/assets/    imported + generated media (id-named)
 *   <workspace>/renders/   render_video / render_carousel outputs
 *   <workspace>/drafts/    post drafts (one JSON per draft)
 *   <workspace>/tmp/       scratch space for ffmpeg intermediates
 *   <workspace>/manifest.json
 */

export const AssetKindSchema = z.enum(['image', 'video', 'audio', 'other']);
export type AssetKind = z.infer<typeof AssetKindSchema>;

export const AssetRecordSchema = z.object({
  id: z.string(),
  kind: AssetKindSchema,
  path: z.string(),
  addedAt: z.string(),
  source: z.string().default('import'),
  label: z.string().optional(),
});
export type AssetRecord = z.infer<typeof AssetRecordSchema>;

const ManifestSchema = z.object({
  version: z.literal(1).default(1),
  assets: z.array(AssetRecordSchema).default([]),
});
type Manifest = z.infer<typeof ManifestSchema>;

const EXT_KIND: Record<string, AssetKind> = {
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.webp': 'image',
  '.gif': 'image',
  '.mp4': 'video',
  '.mov': 'video',
  '.webm': 'video',
  '.m4v': 'video',
  '.mp3': 'audio',
  '.wav': 'audio',
  '.m4a': 'audio',
  '.aac': 'audio',
  '.flac': 'audio',
};

export function kindFromPath(file: string): AssetKind {
  return EXT_KIND[path.extname(file).toLowerCase()] ?? 'other';
}

export class Workspace {
  readonly root: string;
  readonly assetsDir: string;
  readonly rendersDir: string;
  readonly draftsDir: string;
  readonly tmpDir: string;
  private readonly manifestPath: string;
  private readonly nextId: IdGenerator;

  constructor(root: string, opts: { idGenerator?: IdGenerator } = {}) {
    this.root = root;
    this.assetsDir = path.join(root, 'assets');
    this.rendersDir = path.join(root, 'renders');
    this.draftsDir = path.join(root, 'drafts');
    this.tmpDir = path.join(root, 'tmp');
    this.manifestPath = path.join(root, 'manifest.json');
    this.nextId = opts.idGenerator ?? randomId;
    for (const dir of [this.root, this.assetsDir, this.rendersDir, this.draftsDir, this.tmpDir]) {
      mkdirSync(dir, { recursive: true });
    }
  }

  private readManifest(): Manifest {
    if (!existsSync(this.manifestPath)) return ManifestSchema.parse({});
    return ManifestSchema.parse(JSON.parse(readFileSync(this.manifestPath, 'utf8')));
  }

  private writeManifest(manifest: Manifest): void {
    // Write-then-rename so a crash never leaves a torn manifest.
    const tmp = `${this.manifestPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(manifest, null, 2));
    renameSync(tmp, this.manifestPath);
  }

  listAssets(): AssetRecord[] {
    return this.readManifest().assets;
  }

  getAsset(id: string): AssetRecord | undefined {
    return this.readManifest().assets.find((a) => a.id === id);
  }

  /** Copy an external file into the workspace and register it. */
  importAsset(sourcePath: string, opts: { label?: string; source?: string } = {}): AssetRecord {
    if (!existsSync(sourcePath)) {
      throw new Error(`Cannot import asset: file not found at ${sourcePath}`);
    }
    const id = this.nextId('ast');
    const ext = path.extname(sourcePath).toLowerCase() || '.bin';
    const dest = path.join(this.assetsDir, `${id}${ext}`);
    copyFileSync(sourcePath, dest);
    return this.registerFile(dest, { id, label: opts.label, source: opts.source ?? 'import' });
  }

  /** Register a file already inside the workspace (e.g. written by a provider or renderer). */
  registerFile(filePath: string, opts: { id?: string; label?: string; source?: string } = {}): AssetRecord {
    const record: AssetRecord = {
      id: opts.id ?? this.nextId('ast'),
      kind: kindFromPath(filePath),
      path: filePath,
      addedAt: new Date().toISOString(),
      source: opts.source ?? 'generated',
      label: opts.label,
    };
    const manifest = this.readManifest();
    manifest.assets.push(record);
    this.writeManifest(manifest);
    return record;
  }

  /** Reserve an id-named output path (does not register it; call registerFile after producing it). */
  newFilePath(dir: 'assets' | 'renders' | 'tmp', ext: string): { id: string; path: string } {
    const id = this.nextId(dir === 'renders' ? 'rnd' : 'ast');
    const clean = ext.startsWith('.') ? ext : `.${ext}`;
    const base = dir === 'assets' ? this.assetsDir : dir === 'renders' ? this.rendersDir : this.tmpDir;
    return { id, path: path.join(base, `${id}${clean}`) };
  }

  /**
   * Resolve a tool argument that may be an asset id or a filesystem path.
   * Agents can chain Backlot outputs by id, or point at any file they have.
   */
  resolvePath(assetOrPath: string): string {
    const asset = this.getAsset(assetOrPath);
    if (asset) {
      if (!existsSync(asset.path)) {
        throw new Error(`Asset ${assetOrPath} is registered but its file is missing: ${asset.path}`);
      }
      return asset.path;
    }
    if (path.isAbsolute(assetOrPath) && existsSync(assetOrPath)) return assetOrPath;
    throw new Error(
      `"${assetOrPath}" is neither a known asset id nor an existing absolute path. ` +
        `Use list_assets to see ids, or pass an absolute file path.`,
    );
  }
}
