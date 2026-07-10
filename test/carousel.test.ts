import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrandKitSchema } from '../src/config.js';
import { CarouselRenderer, CarouselSpecSchema, slideOverlaySvg } from '../src/render/carousel.js';
import { sequentialIds } from '../src/ids.js';
import { Workspace } from '../src/workspace.js';

let dir: string;
let ws: Workspace;
let renderer: CarouselRenderer;
const brand = BrandKitSchema.parse({ name: 'Backlot', handle: '@backlot' });

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'backlot-carousel-'));
  ws = new Workspace(path.join(dir, 'ws'), { idGenerator: sequentialIds() });
  renderer = new CarouselRenderer(ws, brand);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('slideOverlaySvg', () => {
  it('escapes XML entities in user text', () => {
    const svg = slideOverlaySvg(
      { headline: 'Ship <fast> & "cheap"', backgroundDarken: 0 },
      { width: 1080, height: 1350, brand },
    );
    expect(svg).toContain('&lt;fast&gt;');
    expect(svg).toContain('&amp;');
    expect(svg).not.toContain('<fast>');
  });

  it('includes handle and page label when provided', () => {
    const svg = slideOverlaySvg({ headline: 'Hi' }, { width: 1080, height: 1350, brand, pageLabel: '2/5' });
    expect(svg).toContain('@backlot');
    expect(svg).toContain('2/5');
  });
});

describe('CarouselRenderer', () => {
  it('renders slides at exact 4:5 dimensions with visible text', async () => {
    const spec = CarouselSpecSchema.parse({
      slides: [
        { kicker: 'Backlot', headline: 'WILL AI KILL YOUR CONTENT?', body: 'No. But it will render it.' },
        { headline: 'Slide two' },
      ],
    });
    const result = await renderer.render(spec);

    expect(result.slides).toHaveLength(2);
    expect(result.width).toBe(1080);
    expect(result.height).toBe(1350);

    const meta = await sharp(result.slides[0]!.path).metadata();
    expect(meta.width).toBe(1080);
    expect(meta.height).toBe(1350);
    expect(meta.format).toBe('png');

    // Text must actually rasterize: a text-bearing slide has far more
    // tonal variance than a blank brand-background slide would.
    const stats = await sharp(result.slides[0]!.path).greyscale().stats();
    expect(stats.channels[0]!.stdev).toBeGreaterThan(5);
  });

  it('renders webp and 1:1 when asked', async () => {
    const spec = CarouselSpecSchema.parse({
      slides: [{ headline: 'Square' }],
      size: '1:1',
      format: 'webp',
    });
    const result = await renderer.render(spec);
    const meta = await sharp(result.slides[0]!.path).metadata();
    expect(meta.width).toBe(1080);
    expect(meta.height).toBe(1080);
    expect(meta.format).toBe('webp');
  });

  it('uses an image background with darkening', async () => {
    const bgPath = path.join(dir, 'bg.png');
    await sharp({ create: { width: 400, height: 300, channels: 3, background: '#ffffff' } })
      .png()
      .toFile(bgPath);
    const bg = ws.importAsset(bgPath);

    const spec = CarouselSpecSchema.parse({
      slides: [{ headline: 'On a photo', backgroundAsset: bg.id, backgroundDarken: 0.5 }],
    });
    const result = await renderer.render(spec);
    const stats = await sharp(result.slides[0]!.path).greyscale().stats();
    // white background darkened by 50% should average well below pure white
    expect(stats.channels[0]!.mean).toBeLessThan(200);
  });
});
