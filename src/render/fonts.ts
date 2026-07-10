import { existsSync } from 'node:fs';
import type { BrandKit } from '../config.js';

const SYSTEM_FONT_CANDIDATES = [
  // macOS
  '/System/Library/Fonts/Helvetica.ttc',
  '/System/Library/Fonts/HelveticaNeue.ttc',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/Library/Fonts/Arial.ttf',
  // Linux
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  // Windows
  'C:\\Windows\\Fonts\\arial.ttf',
];

/**
 * Resolve the font file used for burned-in text. Priority:
 * brand kit font > BROLL_FONT env > first available system font.
 * Returns undefined when nothing is found; drawtext then falls back to
 * fontconfig's default, which is acceptable but less deterministic.
 */
export function resolveFontFile(brand?: BrandKit, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = [brand?.font, env.BROLL_FONT].filter((f): f is string => Boolean(f));
  for (const candidate of [...explicit, ...SYSTEM_FONT_CANDIDATES]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}
