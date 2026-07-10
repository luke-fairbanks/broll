import path from 'node:path';
import { z } from 'zod';
import type { BrandKit } from '../config.js';
import type { MediaInfo } from './probe.js';
import { wrapForFrame } from './text.js';

/**
 * RenderPlan is broll's core idea made concrete: an agent describes a
 * video declaratively; broll compiles it to an exact ffmpeg invocation.
 * Same plan + same inputs = same output. All "creative drift" lives in
 * the model's plan, never in the rendering.
 */

export const AspectSchema = z.enum(['9:16', '1:1', '4:5', '16:9']);
export type Aspect = z.infer<typeof AspectSchema>;

export const ASPECT_DIMENSIONS: Record<Aspect, { width: number; height: number }> = {
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
  '4:5': { width: 1080, height: 1350 },
  '16:9': { width: 1920, height: 1080 },
};

const FitSchema = z.enum(['cover', 'contain']).default('cover');

export const ClipSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('video'),
    asset: z.string().describe('Asset id or absolute path of a video file'),
    trimStartSec: z.number().min(0).optional(),
    trimEndSec: z.number().positive().optional(),
    muted: z.boolean().default(false),
    fit: FitSchema,
  }),
  z.object({
    kind: z.literal('image'),
    asset: z.string().describe('Asset id or absolute path of an image file'),
    durationSec: z.number().positive(),
    fit: FitSchema,
  }),
  z.object({
    kind: z.literal('color'),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use #RRGGBB'),
    durationSec: z.number().positive(),
  }),
]);
export type Clip = z.infer<typeof ClipSchema>;

export const OverlayPresetSchema = z.enum(['title', 'center', 'lower-third', 'caption']);
export type OverlayPreset = z.infer<typeof OverlayPresetSchema>;

export const TextOverlaySchema = z.object({
  text: z.string().min(1),
  preset: OverlayPresetSchema.default('title'),
  startSec: z.number().min(0).default(0),
  endSec: z.number().positive().optional().describe('Defaults to the end of the video'),
});
export type TextOverlay = z.infer<typeof TextOverlaySchema>;

export const CaptionCueSchema = z.object({
  text: z.string().min(1),
  startSec: z.number().min(0),
  endSec: z.number().positive(),
});
export type CaptionCue = z.infer<typeof CaptionCueSchema>;

export const RenderPlanSchema = z.object({
  clips: z.array(ClipSchema).min(1),
  overlays: z.array(TextOverlaySchema).default([]),
  captions: z.array(CaptionCueSchema).default([]),
  music: z
    .object({
      asset: z.string(),
      volumeDb: z.number().max(6).default(-8),
      loop: z.boolean().default(true),
    })
    .optional(),
  aspect: AspectSchema.default('9:16'),
  fps: z.number().int().min(12).max(60).default(30),
  quality: z.enum(['draft', 'standard', 'high']).default('standard'),
});
export type RenderPlan = z.infer<typeof RenderPlanSchema>;

/** A clip whose asset reference has been resolved to a real file (+ probe data for videos). */
export type ResolvedClip =
  | { kind: 'video'; clip: Extract<Clip, { kind: 'video' }>; path: string; info: MediaInfo }
  | { kind: 'image'; clip: Extract<Clip, { kind: 'image' }>; path: string }
  | { kind: 'color'; clip: Extract<Clip, { kind: 'color' }> };

export interface CompileOptions {
  outputPath: string;
  tmpDir: string;
  brand?: BrandKit;
  fontFile?: string;
  resolvedMusicPath?: string;
}

export interface CompiledRender {
  args: string[];
  filtergraph: string;
  textFiles: Array<{ path: string; content: string }>;
  totalDurationSec: number;
  outputPath: string;
  warnings: string[];
}

const QUALITY: Record<RenderPlan['quality'], { crf: string; preset: string }> = {
  draft: { crf: '28', preset: 'veryfast' },
  standard: { crf: '20', preset: 'medium' },
  high: { crf: '17', preset: 'slow' },
};

function hexToFfmpeg(hex: string): string {
  return `0x${hex.replace('#', '')}`;
}

export function clipDurationSec(rc: ResolvedClip): number {
  if (rc.kind === 'video') {
    const start = rc.clip.trimStartSec ?? 0;
    const end = rc.clip.trimEndSec ?? rc.info.durationSec;
    if (end === undefined) {
      throw new Error(`Cannot determine duration of video clip ${rc.path}; pass trimEndSec explicitly.`);
    }
    const dur = end - start;
    if (dur <= 0) {
      throw new Error(`Video clip ${rc.path} has non-positive duration (trimStartSec=${start}, end=${end}).`);
    }
    return dur;
  }
  return rc.clip.durationSec;
}

interface OverlaySpec {
  fontSize: number;
  x: string;
  y: string;
  boxColor: string;
  fontColor: string;
}

function overlaySpec(preset: OverlayPreset, width: number, height: number, brand?: BrandKit): OverlaySpec {
  const text = brand?.colors.text ?? '#FFFFFF';
  const specs: Record<OverlayPreset, OverlaySpec> = {
    title: {
      fontSize: Math.round(height * 0.055),
      x: '(w-text_w)/2',
      y: `${Math.round(height * 0.1)}`,
      boxColor: '0x000000@0.55',
      fontColor: hexToFfmpeg(text),
    },
    center: {
      fontSize: Math.round(height * 0.06),
      x: '(w-text_w)/2',
      y: '(h-text_h)/2',
      boxColor: '0x000000@0.55',
      fontColor: hexToFfmpeg(text),
    },
    'lower-third': {
      fontSize: Math.round(height * 0.042),
      x: `${Math.round(width * 0.06)}`,
      y: `${Math.round(height * 0.72)}`,
      boxColor: hexToFfmpeg(brand?.colors.primary ?? '#E4572E') + '@0.85',
      fontColor: hexToFfmpeg(text),
    },
    caption: {
      fontSize: Math.round(height * 0.04),
      x: '(w-text_w)/2',
      y: `${Math.round(height * 0.78)}`,
      boxColor: '0x000000@0.6',
      fontColor: hexToFfmpeg(text),
    },
  };
  return specs[preset];
}

interface TimedText {
  text: string;
  preset: OverlayPreset;
  startSec: number;
  endSec: number;
}

/**
 * Compile a RenderPlan into a single ffmpeg invocation.
 * Pure: no filesystem access, no process spawning. Callers write the
 * returned textFiles to disk before running the args.
 */
export function compilePlan(plan: RenderPlan, resolved: ResolvedClip[], opts: CompileOptions): CompiledRender {
  if (resolved.length !== plan.clips.length) {
    throw new Error(`Internal: resolved ${resolved.length} clips for a plan with ${plan.clips.length}.`);
  }
  const { width, height } = ASPECT_DIMENSIONS[plan.aspect];
  const bg = hexToFfmpeg(opts.brand?.colors.background ?? '#101014');
  const warnings: string[] = [];

  const durations = resolved.map(clipDurationSec);
  const totalDurationSec = Number(durations.reduce((a, b) => a + b, 0).toFixed(3));

  // ---- inputs -------------------------------------------------------
  const inputs: string[] = [];
  const inputIndexOfClip: number[] = [];
  let inputCount = 0;

  for (const [i, rc] of resolved.entries()) {
    inputIndexOfClip[i] = inputCount;
    if (rc.kind === 'video') {
      inputs.push('-i', rc.path);
    } else if (rc.kind === 'image') {
      inputs.push('-loop', '1', '-t', String(rc.clip.durationSec), '-i', rc.path);
    } else {
      inputs.push(
        '-f',
        'lavfi',
        '-t',
        String(rc.clip.durationSec),
        '-i',
        `color=c=${hexToFfmpeg(rc.clip.color)}:s=${width}x${height}:r=${plan.fps}`,
      );
    }
    inputCount += 1;
  }

  let musicInputIndex: number | undefined;
  if (plan.music) {
    if (!opts.resolvedMusicPath) throw new Error('Internal: plan has music but no resolvedMusicPath given.');
    if (plan.music.loop) inputs.push('-stream_loop', '-1');
    inputs.push('-i', opts.resolvedMusicPath);
    musicInputIndex = inputCount;
    inputCount += 1;
  }

  // ---- per-segment normalization ------------------------------------
  const fitChain = (fit: 'cover' | 'contain') =>
    fit === 'cover'
      ? `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`
      : `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${bg}`;

  const filters: string[] = [];
  for (const [i, rc] of resolved.entries()) {
    const idx = inputIndexOfClip[i];
    const dur = durations[i]!;

    if (rc.kind === 'video') {
      const start = rc.clip.trimStartSec ?? 0;
      const end = rc.clip.trimEndSec ?? start + dur;
      filters.push(
        `[${idx}:v]trim=start=${start}:end=${end},setpts=PTS-STARTPTS,` +
          `${fitChain(rc.clip.fit)},fps=${plan.fps},setsar=1,format=yuv420p[v${i}]`,
      );
      if (rc.info.hasAudio && !rc.clip.muted) {
        filters.push(
          `[${idx}:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS,` +
            `aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`,
        );
      } else {
        filters.push(`aevalsrc=0|0:s=48000:d=${dur},aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
      }
    } else if (rc.kind === 'image') {
      filters.push(`[${idx}:v]${fitChain(rc.clip.fit)},fps=${plan.fps},setsar=1,format=yuv420p[v${i}]`);
      filters.push(`aevalsrc=0|0:s=48000:d=${dur},aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
    } else {
      filters.push(`[${idx}:v]setsar=1,format=yuv420p[v${i}]`);
      filters.push(`aevalsrc=0|0:s=48000:d=${dur},aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
    }
  }

  // ---- concat --------------------------------------------------------
  const concatInputs = resolved.map((_, i) => `[v${i}][a${i}]`).join('');
  filters.push(`${concatInputs}concat=n=${resolved.length}:v=1:a=1[vcat][acat]`);

  // ---- burned-in text ------------------------------------------------
  const timed: TimedText[] = [
    ...plan.overlays.map((o) => ({
      text: o.text,
      preset: o.preset,
      startSec: o.startSec,
      endSec: o.endSec ?? totalDurationSec,
    })),
    ...plan.captions.map((c) => ({ text: c.text, preset: 'caption' as const, startSec: c.startSec, endSec: c.endSec })),
  ];

  const textFiles: Array<{ path: string; content: string }> = [];
  let currentVideoLabel = 'vcat';
  let textIndex = 0;

  for (const t of timed) {
    if (t.startSec >= totalDurationSec) {
      warnings.push(`Dropped text "${t.text.slice(0, 40)}" — starts at ${t.startSec}s but video is ${totalDurationSec}s.`);
      continue;
    }
    const endSec = Math.min(t.endSec, totalDurationSec);
    const spec = overlaySpec(t.preset, width, height, opts.brand);
    const wrapped = wrapForFrame(t.text, width, spec.fontSize);
    const textFilePath = path.join(opts.tmpDir, `txt_${textIndex}.txt`);
    textFiles.push({ path: textFilePath, content: wrapped });

    const boxPad = Math.round(spec.fontSize * 0.45);
    const options = [
      opts.fontFile ? `fontfile=${opts.fontFile}` : undefined,
      `textfile=${textFilePath}`,
      `fontsize=${spec.fontSize}`,
      `fontcolor=${spec.fontColor}`,
      `line_spacing=${Math.round(spec.fontSize * 0.25)}`,
      'box=1',
      `boxcolor=${spec.boxColor}`,
      `boxborderw=${boxPad}`,
      `x=${spec.x}`,
      `y=${spec.y}`,
      `enable='between(t,${t.startSec},${endSec})'`,
    ].filter((o): o is string => Boolean(o));

    const nextLabel = `vtxt${textIndex}`;
    filters.push(`[${currentVideoLabel}]drawtext=${options.join(':')}[${nextLabel}]`);
    currentVideoLabel = nextLabel;
    textIndex += 1;
  }
  filters.push(`[${currentVideoLabel}]null[vout]`);

  // ---- audio out -----------------------------------------------------
  if (plan.music && musicInputIndex !== undefined) {
    filters.push(
      `[${musicInputIndex}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
        `volume=${plan.music.volumeDb}dB,atrim=0:${totalDurationSec},asetpts=PTS-STARTPTS[mus]`,
    );
    filters.push(`[acat][mus]amix=inputs=2:duration=first:normalize=0[aout]`);
  } else {
    filters.push(`[acat]anull[aout]`);
  }

  const filtergraph = filters.join(';');
  const q = QUALITY[plan.quality];

  const args = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    ...inputs,
    '-filter_complex',
    filtergraph,
    '-map',
    '[vout]',
    '-map',
    '[aout]',
    '-c:v',
    'libx264',
    '-preset',
    q.preset,
    '-crf',
    q.crf,
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-movflags',
    '+faststart',
    opts.outputPath,
  ];

  return { args, filtergraph, textFiles, totalDurationSec, outputPath: opts.outputPath, warnings };
}
