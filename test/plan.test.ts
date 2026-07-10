import { describe, expect, it } from 'vitest';
import { compilePlan, RenderPlanSchema, type ResolvedClip } from '../src/render/plan.js';
import type { MediaInfo } from '../src/render/probe.js';

const fakeInfo = (overrides: Partial<MediaInfo> = {}): MediaInfo => ({
  path: '/fake/clip.mp4',
  durationSec: 10,
  width: 1920,
  height: 1080,
  hasVideo: true,
  hasAudio: true,
  videoCodec: 'h264',
  audioCodec: 'aac',
  ...overrides,
});

const OPTS = { outputPath: '/out/final.mp4', tmpDir: '/tmp/t' };

describe('compilePlan', () => {
  it('compiles a single color card', () => {
    const plan = RenderPlanSchema.parse({
      clips: [{ kind: 'color', color: '#112233', durationSec: 3 }],
      aspect: '9:16',
    });
    const resolved: ResolvedClip[] = [{ kind: 'color', clip: plan.clips[0] as never }];
    const compiled = compilePlan(plan, resolved, OPTS);

    expect(compiled.totalDurationSec).toBe(3);
    expect(compiled.args).toContain('-filter_complex');
    expect(compiled.args.join(' ')).toContain('color=c=0x112233:s=1080x1920:r=30');
    expect(compiled.filtergraph).toContain('concat=n=1:v=1:a=1[vcat][acat]');
    expect(compiled.filtergraph).toContain('[acat]anull[aout]');
    expect(compiled.args[compiled.args.length - 1]).toBe('/out/final.mp4');
    // silent audio is synthesized for the color card
    expect(compiled.filtergraph).toContain('aevalsrc=0|0:s=48000:d=3');
  });

  it('trims video clips and derives duration from probe data when untrimmed', () => {
    const plan = RenderPlanSchema.parse({
      clips: [
        { kind: 'video', asset: 'a.mp4', trimStartSec: 2, trimEndSec: 5 },
        { kind: 'video', asset: 'b.mp4' },
      ],
    });
    const resolved: ResolvedClip[] = [
      { kind: 'video', clip: plan.clips[0] as never, path: '/v/a.mp4', info: fakeInfo() },
      { kind: 'video', clip: plan.clips[1] as never, path: '/v/b.mp4', info: fakeInfo({ durationSec: 4 }) },
    ];
    const compiled = compilePlan(plan, resolved, OPTS);

    expect(compiled.totalDurationSec).toBe(7); // (5-2) + 4
    expect(compiled.filtergraph).toContain('[0:v]trim=start=2:end=5,setpts=PTS-STARTPTS');
    expect(compiled.filtergraph).toContain('[0:a]atrim=start=2:end=5');
    expect(compiled.filtergraph).toContain('[1:v]trim=start=0:end=4');
    expect(compiled.filtergraph).toContain('concat=n=2:v=1:a=1');
  });

  it('errors when a video has unknown duration and no trimEndSec', () => {
    const plan = RenderPlanSchema.parse({ clips: [{ kind: 'video', asset: 'a.mp4' }] });
    const resolved: ResolvedClip[] = [
      { kind: 'video', clip: plan.clips[0] as never, path: '/v/a.mp4', info: fakeInfo({ durationSec: undefined }) },
    ];
    expect(() => compilePlan(plan, resolved, OPTS)).toThrow(/trimEndSec/);
  });

  it('synthesizes silence for muted clips and images', () => {
    const plan = RenderPlanSchema.parse({
      clips: [
        { kind: 'video', asset: 'a.mp4', trimEndSec: 2, muted: true },
        { kind: 'image', asset: 'img.png', durationSec: 3 },
      ],
    });
    const resolved: ResolvedClip[] = [
      { kind: 'video', clip: plan.clips[0] as never, path: '/v/a.mp4', info: fakeInfo() },
      { kind: 'image', clip: plan.clips[1] as never, path: '/i/img.png' },
    ];
    const compiled = compilePlan(plan, resolved, OPTS);

    expect(compiled.filtergraph).not.toContain('[0:a]');
    expect(compiled.filtergraph).toContain('aevalsrc=0|0:s=48000:d=2');
    expect(compiled.filtergraph).toContain('aevalsrc=0|0:s=48000:d=3');
    // image is looped for its duration
    const joined = compiled.args.join(' ');
    expect(joined).toContain('-loop 1 -t 3 -i /i/img.png');
  });

  it('applies cover vs contain fit chains', () => {
    const plan = RenderPlanSchema.parse({
      clips: [
        { kind: 'image', asset: 'a.png', durationSec: 1, fit: 'cover' },
        { kind: 'image', asset: 'b.png', durationSec: 1, fit: 'contain' },
      ],
      aspect: '1:1',
    });
    const resolved: ResolvedClip[] = [
      { kind: 'image', clip: plan.clips[0] as never, path: '/a.png' },
      { kind: 'image', clip: plan.clips[1] as never, path: '/b.png' },
    ];
    const compiled = compilePlan(plan, resolved, OPTS);
    expect(compiled.filtergraph).toContain('scale=1080:1080:force_original_aspect_ratio=increase,crop=1080:1080');
    expect(compiled.filtergraph).toContain('scale=1080:1080:force_original_aspect_ratio=decrease,pad=1080:1080');
  });

  it('burns in overlays and captions as timed drawtext with textfiles', () => {
    const plan = RenderPlanSchema.parse({
      clips: [{ kind: 'color', color: '#000000', durationSec: 6 }],
      overlays: [{ text: 'Big Title', preset: 'title' }],
      captions: [
        { text: 'first caption', startSec: 0, endSec: 2 },
        { text: 'second caption', startSec: 2, endSec: 4 },
      ],
    });
    const resolved: ResolvedClip[] = [{ kind: 'color', clip: plan.clips[0] as never }];
    const compiled = compilePlan(plan, resolved, { ...OPTS, fontFile: '/fonts/Inter.ttf' });

    expect(compiled.textFiles).toHaveLength(3);
    expect(compiled.textFiles[0]).toEqual({ path: '/tmp/t/txt_0.txt', content: 'Big Title' });
    expect(compiled.filtergraph).toContain('fontfile=/fonts/Inter.ttf');
    expect(compiled.filtergraph).toContain("enable='between(t,0,6)'"); // overlay spans full video
    expect(compiled.filtergraph).toContain("enable='between(t,2,4)'");
    // chained drawtext then final label
    expect(compiled.filtergraph).toContain('[vcat]drawtext=');
    expect(compiled.filtergraph).toContain('[vtxt2]null[vout]');
  });

  it('drops text that starts after the video ends, with a warning', () => {
    const plan = RenderPlanSchema.parse({
      clips: [{ kind: 'color', color: '#000000', durationSec: 2 }],
      captions: [{ text: 'too late', startSec: 5, endSec: 6 }],
    });
    const resolved: ResolvedClip[] = [{ kind: 'color', clip: plan.clips[0] as never }];
    const compiled = compilePlan(plan, resolved, OPTS);
    expect(compiled.warnings).toHaveLength(1);
    expect(compiled.filtergraph).not.toContain('drawtext');
  });

  it('mixes looped music under concatenated audio', () => {
    const plan = RenderPlanSchema.parse({
      clips: [{ kind: 'color', color: '#000000', durationSec: 4 }],
      music: { asset: 'song.m4a', volumeDb: -10 },
    });
    const resolved: ResolvedClip[] = [{ kind: 'color', clip: plan.clips[0] as never }];
    const compiled = compilePlan(plan, resolved, { ...OPTS, resolvedMusicPath: '/m/song.m4a' });

    const joined = compiled.args.join(' ');
    expect(joined).toContain('-stream_loop -1 -i /m/song.m4a');
    expect(compiled.filtergraph).toContain('volume=-10dB');
    expect(compiled.filtergraph).toContain('atrim=0:4');
    expect(compiled.filtergraph).toContain('[acat][mus]amix=inputs=2:duration=first:normalize=0[aout]');
  });

  it('uses quality presets', () => {
    const plan = RenderPlanSchema.parse({
      clips: [{ kind: 'color', color: '#000000', durationSec: 1 }],
      quality: 'draft',
    });
    const resolved: ResolvedClip[] = [{ kind: 'color', clip: plan.clips[0] as never }];
    const compiled = compilePlan(plan, resolved, OPTS);
    const joined = compiled.args.join(' ');
    expect(joined).toContain('-preset veryfast');
    expect(joined).toContain('-crf 28');
  });
});
