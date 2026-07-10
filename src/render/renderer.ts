import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BrandKit } from '../config.js';
import type { Workspace, AssetRecord } from '../workspace.js';
import type { FfmpegRunner } from './ffmpeg.js';
import { probeMedia, type MediaInfo } from './probe.js';
import { resolveFontFile } from './fonts.js';
import { isFilterSafePath } from './text.js';
import {
  compilePlan,
  type CompiledRender,
  type RenderPlan,
  type ResolvedClip,
} from './plan.js';

export interface RenderResult {
  asset: AssetRecord;
  durationSec: number;
  width: number;
  height: number;
  warnings: string[];
  filtergraph: string;
}

export class Renderer {
  constructor(
    private readonly workspace: Workspace,
    private readonly runner: FfmpegRunner,
    private readonly brand?: BrandKit,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async resolveClips(plan: RenderPlan): Promise<ResolvedClip[]> {
    const resolved: ResolvedClip[] = [];
    for (const clip of plan.clips) {
      if (clip.kind === 'video') {
        const filePath = this.workspace.resolvePath(clip.asset);
        const info: MediaInfo = await probeMedia(this.runner, filePath);
        if (!info.hasVideo) {
          throw new Error(`Clip asset ${clip.asset} has no video stream (${filePath}).`);
        }
        resolved.push({ kind: 'video', clip, path: filePath, info });
      } else if (clip.kind === 'image') {
        resolved.push({ kind: 'image', clip, path: this.workspace.resolvePath(clip.asset) });
      } else {
        resolved.push({ kind: 'color', clip });
      }
    }
    return resolved;
  }

  async render(plan: RenderPlan): Promise<RenderResult> {
    const resolved = await this.resolveClips(plan);

    const musicPath = plan.music ? this.workspace.resolvePath(plan.music.asset) : undefined;
    const out = this.workspace.newFilePath('renders', 'mp4');
    const tmpDir = path.join(this.workspace.tmpDir, out.id);
    mkdirSync(tmpDir, { recursive: true });

    let fontFile = resolveFontFile(this.brand, this.env);
    if (fontFile && !isFilterSafePath(fontFile)) {
      // Font paths with spaces (e.g. "HelveticaNeue UI.ttc") would break the filtergraph.
      fontFile = undefined;
    }

    const compiled: CompiledRender = compilePlan(plan, resolved, {
      outputPath: out.path,
      tmpDir,
      brand: this.brand,
      fontFile,
      resolvedMusicPath: musicPath,
    });

    for (const tf of compiled.textFiles) {
      writeFileSync(tf.path, tf.content, 'utf8');
    }

    await this.runner.run(compiled.args);

    const info = await probeMedia(this.runner, out.path);
    const asset = this.workspace.registerFile(out.path, { id: out.id, source: 'render_video' });

    return {
      asset,
      durationSec: info.durationSec ?? compiled.totalDurationSec,
      width: info.width ?? 0,
      height: info.height ?? 0,
      warnings: compiled.warnings,
      filtergraph: compiled.filtergraph,
    };
  }

  /** Extract a single frame as PNG — lets agents visually QA a render. */
  async extractFrame(assetOrPath: string, atSec: number): Promise<AssetRecord> {
    const src = this.workspace.resolvePath(assetOrPath);
    const out = this.workspace.newFilePath('assets', 'png');
    await this.runner.run([
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      String(atSec),
      '-i',
      src,
      '-frames:v',
      '1',
      out.path,
    ]);
    return this.workspace.registerFile(out.path, { id: out.id, source: 'extract_frame' });
  }
}
