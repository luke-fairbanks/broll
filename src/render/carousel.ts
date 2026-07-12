import sharp from 'sharp';
import { z } from 'zod';
import type { BrandKit } from '../config.js';
import type { Workspace, AssetRecord } from '../workspace.js';
import { glyphRatio, wrapText } from './text.js';

/**
 * Carousel slides, the workhorse of organic social. The layout is 100%
 * code — the image model (or a photo) only ever supplies the background.
 * Text, spacing, accent marks, and branding are deterministic, so slide
 * 150 looks like it belongs next to slide 1.
 */

export const CarouselSizeSchema = z.enum(['4:5', '1:1', '9:16']);

const SLIDE_DIMENSIONS: Record<z.infer<typeof CarouselSizeSchema>, { width: number; height: number }> = {
  '4:5': { width: 1080, height: 1350 },
  '1:1': { width: 1080, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
};

export const CarouselSlideSchema = z.object({
  kicker: z.string().optional().describe('Small uppercase eyebrow line at the top'),
  headline: z.string().optional(),
  body: z.string().optional(),
  backgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  backgroundAsset: z.string().optional().describe('Asset id or absolute path of a background image'),
  /** 0 = untouched background, 1 = fully black. Applied only when a background image is set. */
  backgroundDarken: z.number().min(0).max(1).default(0.45),
});
export type CarouselSlide = z.infer<typeof CarouselSlideSchema>;

export const CarouselSpecSchema = z.object({
  slides: z.array(CarouselSlideSchema).min(1).max(20),
  size: CarouselSizeSchema.default('4:5'),
  format: z.enum(['png', 'webp']).default('png'),
  pageNumbers: z.boolean().default(true),
  watermark: z.boolean().default(true).describe('Brand handle bottom-left when the brand kit has one'),
});
export type CarouselSpec = z.infer<typeof CarouselSpecSchema>;

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

const FONT_STACK = `'Helvetica Neue', Helvetica, Arial, 'DejaVu Sans', sans-serif`;

interface TextBlock {
  svg: string;
  heightPx: number;
}

function textBlock(opts: {
  lines: string[];
  x: number;
  startY: number;
  fontSize: number;
  lineHeight: number;
  fill: string;
  weight?: number;
  letterSpacing?: number;
}): TextBlock {
  const { lines, x, startY, fontSize, lineHeight, fill, weight = 400, letterSpacing } = opts;
  const spans = lines
    .map((line, i) => `<tspan x="${x}" y="${Math.round(startY + i * lineHeight)}">${escapeXml(line)}</tspan>`)
    .join('');
  const ls = letterSpacing ? ` letter-spacing="${letterSpacing}"` : '';
  return {
    svg: `<text font-family="${FONT_STACK}" font-size="${fontSize}" font-weight="${weight}" fill="${fill}"${ls}>${spans}</text>`,
    heightPx: lines.length * lineHeight,
  };
}

/** Compose the full-slide SVG overlay (all text + accents) for one slide. */
export function slideOverlaySvg(
  slide: CarouselSlide,
  opts: { width: number; height: number; brand: BrandKit; pageLabel?: string },
): string {
  const { width, height, brand, pageLabel } = opts;
  const margin = Math.round(width * 0.085);
  const contentWidth = width - margin * 2;

  const headlineSize = Math.round(width * 0.078);
  const bodySize = Math.round(width * 0.039);
  const kickerSize = Math.round(width * 0.028);
  const footerSize = Math.round(width * 0.026);

  const headlineLines = slide.headline
    ? wrapText(slide.headline, Math.max(8, Math.floor(contentWidth / (headlineSize * glyphRatio(slide.headline)))))
    : [];
  const bodyLines = slide.body
    ? wrapText(slide.body, Math.max(8, Math.floor(contentWidth / (bodySize * glyphRatio(slide.body)))))
    : [];

  const headlineLineHeight = Math.round(headlineSize * 1.16);
  const bodyLineHeight = Math.round(bodySize * 1.5);
  const gap = Math.round(height * 0.035);
  const accentHeight = 14;

  const blockHeight =
    (headlineLines.length ? accentHeight + gap + headlineLines.length * headlineLineHeight : 0) +
    (bodyLines.length ? (headlineLines.length ? gap : 0) + bodyLines.length * bodyLineHeight : 0);

  // Vertically center the text block, biased slightly upward for balance.
  let cursorY = Math.max(Math.round(height * 0.18), Math.round((height - blockHeight) * 0.46));
  const parts: string[] = [];

  if (slide.kicker) {
    parts.push(
      textBlock({
        lines: [slide.kicker.toUpperCase()],
        x: margin,
        startY: Math.round(height * 0.085),
        fontSize: kickerSize,
        lineHeight: kickerSize,
        fill: brand.colors.primary,
        weight: 700,
        letterSpacing: 4,
      }).svg,
    );
  }

  if (headlineLines.length) {
    parts.push(
      `<rect x="${margin}" y="${cursorY}" width="${Math.round(width * 0.12)}" height="${accentHeight}" fill="${brand.colors.primary}"/>`,
    );
    cursorY += accentHeight + gap + headlineSize; // first baseline
    const block = textBlock({
      lines: headlineLines,
      x: margin,
      startY: cursorY,
      fontSize: headlineSize,
      lineHeight: headlineLineHeight,
      fill: brand.colors.text,
      weight: 800,
    });
    parts.push(block.svg);
    cursorY += (headlineLines.length - 1) * headlineLineHeight + gap;
  }

  if (bodyLines.length) {
    cursorY += bodySize;
    const block = textBlock({
      lines: bodyLines,
      x: margin,
      startY: cursorY,
      fontSize: bodySize,
      lineHeight: bodyLineHeight,
      fill: brand.colors.muted,
      weight: 400,
    });
    parts.push(block.svg);
  }

  if (brand.handle) {
    parts.push(
      textBlock({
        lines: [brand.handle],
        x: margin,
        startY: Math.round(height * 0.955),
        fontSize: footerSize,
        lineHeight: footerSize,
        fill: brand.colors.muted,
        weight: 600,
      }).svg,
    );
  }

  if (pageLabel) {
    parts.push(
      `<text font-family="${FONT_STACK}" font-size="${footerSize}" font-weight="600" fill="${brand.colors.muted}" text-anchor="end"><tspan x="${width - margin}" y="${Math.round(height * 0.955)}">${escapeXml(pageLabel)}</tspan></text>`,
    );
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join('')}</svg>`;
}

export interface CarouselResult {
  slides: AssetRecord[];
  width: number;
  height: number;
}

export class CarouselRenderer {
  constructor(
    private readonly workspace: Workspace,
    private readonly brand: BrandKit,
  ) {}

  async render(spec: CarouselSpec): Promise<CarouselResult> {
    const { width, height } = SLIDE_DIMENSIONS[spec.size];
    const slides: AssetRecord[] = [];

    for (const [i, slide] of spec.slides.entries()) {
      let base: ReturnType<typeof sharp>;
      if (slide.backgroundAsset) {
        const bgPath = this.workspace.resolvePath(slide.backgroundAsset);
        base = sharp(bgPath).resize(width, height, { fit: 'cover', position: 'attention' });
        if (slide.backgroundDarken > 0) {
          const veil = Buffer.from(
            `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="black" fill-opacity="${slide.backgroundDarken}"/></svg>`,
          );
          base = sharp(await base.composite([{ input: veil }]).toBuffer());
        }
      } else {
        base = sharp({
          create: {
            width,
            height,
            channels: 4,
            background: slide.backgroundColor ?? this.brand.colors.background,
          },
        });
      }

      const pageLabel = spec.pageNumbers && spec.slides.length > 1 ? `${i + 1}/${spec.slides.length}` : undefined;
      const overlay = Buffer.from(
        slideOverlaySvg(slide, {
          width,
          height,
          brand: spec.watermark ? this.brand : { ...this.brand, handle: undefined },
          pageLabel,
        }),
      );

      const out = this.workspace.newFilePath('renders', spec.format);
      const composed = base.composite([{ input: overlay }]);
      if (spec.format === 'webp') {
        await composed.webp({ quality: 92 }).toFile(out.path);
      } else {
        await composed.png().toFile(out.path);
      }
      slides.push(
        this.workspace.registerFile(out.path, { id: out.id, source: 'render_carousel', label: `slide-${i + 1}` }),
      );
    }

    return { slides, width, height };
  }
}
