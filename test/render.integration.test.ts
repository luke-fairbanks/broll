import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrandKitSchema } from '../src/config.js';
import { ExecaFfmpegRunner } from '../src/render/ffmpeg.js';
import { RenderPlanSchema } from '../src/render/plan.js';
import { probeMedia } from '../src/render/probe.js';
import { Renderer } from '../src/render/renderer.js';
import { MockProvider } from '../src/providers/mock.js';
import { sequentialIds } from '../src/ids.js';
import { Workspace } from '../src/workspace.js';

/**
 * Integration tests: real ffmpeg, real encodes, verified with ffprobe.
 * Fixtures are synthesized with lavfi so no binary files live in git.
 */

const runner = new ExecaFfmpegRunner();
let dir: string;
let ws: Workspace;
let renderer: Renderer;
let clipPath: string;
let imagePath: string;
let musicPath: string;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'broll-int-'));
  ws = new Workspace(path.join(dir, 'ws'), { idGenerator: sequentialIds() });
  renderer = new Renderer(ws, runner, BrandKitSchema.parse({}));

  clipPath = path.join(dir, 'clip.mp4');
  await runner.run([
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    clipPath,
  ]);

  imagePath = path.join(dir, 'still.png');
  await runner.run([
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=0x3355ff:s=800x600:d=0.1', '-frames:v', '1', imagePath,
  ]);

  musicPath = path.join(dir, 'music.m4a');
  await runner.run([
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=220:duration=1', '-c:a', 'aac', musicPath,
  ]);
}, 120_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('Renderer (real ffmpeg)', () => {
  it('renders a mixed-media plan with overlays, captions, and music', async () => {
    const clip = ws.importAsset(clipPath);
    const still = ws.importAsset(imagePath);
    const music = ws.importAsset(musicPath);

    const plan = RenderPlanSchema.parse({
      clips: [
        { kind: 'color', color: '#101014', durationSec: 1 },
        { kind: 'video', asset: clip.id, trimStartSec: 0.5, trimEndSec: 1.5 },
        { kind: 'image', asset: still.id, durationSec: 1 },
      ],
      overlays: [{ text: 'broll renders deterministically', preset: 'title' }],
      captions: [
        { text: 'first caption', startSec: 0.2, endSec: 1.0 },
        { text: 'second caption', startSec: 1.2, endSec: 2.4 },
      ],
      music: { asset: music.id, volumeDb: -12, loop: true },
      aspect: '9:16',
      quality: 'draft',
    });

    const result = await renderer.render(plan);
    expect(result.warnings).toEqual([]);

    const info = await probeMedia(runner, result.asset.path);
    expect(info.hasVideo).toBe(true);
    expect(info.hasAudio).toBe(true);
    expect(info.width).toBe(1080);
    expect(info.height).toBe(1920);
    expect(info.durationSec).toBeGreaterThan(2.8);
    expect(info.durationSec).toBeLessThan(3.4);
    expect(info.videoCodec).toBe('h264');
    expect(result.asset.kind).toBe('video');
  }, 120_000);

  it('extracts a frame for visual QA', async () => {
    const clip = ws.importAsset(clipPath);
    const plan = RenderPlanSchema.parse({
      clips: [{ kind: 'video', asset: clip.id, trimEndSec: 1 }],
      aspect: '1:1',
      quality: 'draft',
    });
    const rendered = await renderer.render(plan);
    const frame = await renderer.extractFrame(rendered.asset.id, 0.5);

    const info = await probeMedia(runner, frame.path);
    expect(info.width).toBe(1080);
    expect(info.height).toBe(1080);
    expect(frame.kind).toBe('image');
  }, 120_000);

  it('fails with an actionable error for a text-file asset', async () => {
    await expect(
      renderer.render(
        RenderPlanSchema.parse({ clips: [{ kind: 'video', asset: '/definitely/not/here.mp4', trimEndSec: 1 }] }),
      ),
    ).rejects.toThrow(/neither a known asset id nor an existing absolute path/);
  });

  it('applies schema defaults when called as a library with a raw plan object', async () => {
    // Regression: bypassing the MCP tool schema used to leak `undefined`
    // into drawtext enable expressions.
    const result = await renderer.render({
      clips: [{ kind: 'color', color: '#101014', durationSec: 1 }],
      overlays: [{ text: 'raw call' }], // no preset, no startSec
      quality: 'draft',
    });
    expect(result.durationSec).toBeGreaterThan(0.8);
    expect(result.filtergraph).not.toContain('undefined');
  }, 120_000);
});

describe('MockProvider video (real ffmpeg)', () => {
  it('produces a playable labelled mp4', async () => {
    const mock = new MockProvider(runner);
    const media = await mock.generateVideo({ prompt: 'demo reel', aspect: '9:16', durationSec: 2 });
    expect(media.ext).toBe('mp4');
    expect(media.data.byteLength).toBeGreaterThan(10_000);
  }, 120_000);
});
