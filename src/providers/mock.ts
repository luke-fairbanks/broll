import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type { FfmpegRunner } from '../render/ffmpeg.js';
import { wrapText } from '../render/text.js';
import type { GeneratedMedia, ImageGenRequest, Provider, VideoGenRequest } from './types.js';

const DIMENSIONS: Record<ImageGenRequest['aspect'], { width: number; height: number }> = {
  square: { width: 1024, height: 1024 },
  portrait: { width: 1024, height: 1536 },
  landscape: { width: 1536, height: 1024 },
};

/**
 * Deterministic keyless provider. Renders the prompt as a labelled
 * placeholder so full pipelines (generate → render → draft) run in
 * tests, demos, and before the user has added any API keys.
 */
export class MockProvider implements Provider {
  readonly name = 'mock';
  readonly capabilities = ['image', 'video'] as const;
  readonly requirement = 'none (built in)';

  constructor(private readonly runner: FfmpegRunner) {}

  isConfigured(): boolean {
    return true;
  }

  async generateImages(req: ImageGenRequest): Promise<GeneratedMedia[]> {
    const { width, height } = DIMENSIONS[req.aspect];
    const fontSize = Math.round(width * 0.045);
    const lines = wrapText(req.prompt, Math.floor((width * 0.8) / (fontSize * 0.55))).slice(0, 8);
    const spans = lines
      .map(
        (line, i) =>
          `<tspan x="${width / 2}" y="${Math.round(height / 2 + (i - (lines.length - 1) / 2) * fontSize * 1.4)}">${line
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')}</tspan>`,
      )
      .join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#1e293b"/><stop offset="1" stop-color="#0f172a"/>
      </linearGradient></defs>
      <rect width="100%" height="100%" fill="url(#g)"/>
      <text font-family="Helvetica, Arial, sans-serif" font-size="${Math.round(fontSize * 0.7)}" font-weight="700" fill="#64748b" letter-spacing="6"><tspan x="${width / 2}" y="${Math.round(height * 0.08)}" text-anchor="middle">MOCK PROVIDER</tspan></text>
      <g text-anchor="middle"><text font-family="Helvetica, Arial, sans-serif" font-size="${fontSize}" fill="#e2e8f0">${spans}</text></g>
    </svg>`;
    const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
    return Array.from({ length: req.n }, () => ({ data: buffer, ext: 'png' as const }));
  }

  async generateVideo(req: VideoGenRequest): Promise<GeneratedMedia> {
    const durationSec = Math.min(req.durationSec ?? 4, 10);
    const size = req.aspect === '9:16' ? '1080x1920' : '1920x1080';
    const work = mkdtempSync(path.join(tmpdir(), 'broll-mock-'));
    try {
      const textFile = path.join(work, 'prompt.txt');
      writeFileSync(textFile, wrapText(`MOCK: ${req.prompt}`, 32).join('\n'));
      const outFile = path.join(work, 'out.mp4');
      await this.runner.run([
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        `testsrc2=size=${size}:rate=30:duration=${durationSec}`,
        '-vf',
        `drawtext=textfile=${textFile}:fontsize=48:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=24:x=(w-text_w)/2:y=(h-text_h)/2`,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-pix_fmt',
        'yuv420p',
        outFile,
      ]);
      return { data: readFileSync(outFile), ext: 'mp4' };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
}
