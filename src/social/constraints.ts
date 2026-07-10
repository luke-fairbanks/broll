import type { Platform, ResolvedMedia } from './types.js';

/**
 * Per-platform posting rules, enforced before anything leaves the
 * machine. Failing loudly at draft time beats a cryptic API 400 at
 * publish time — and beats silently truncated posts every time.
 */

export interface PlatformRules {
  maxChars: number;
  charUnit: 'graphemes' | 'weighted';
  maxImages: number;
  maxVideos: number;
  imageMaxBytes?: number;
  videoMaxBytes?: number;
  notes?: string;
}

export const PLATFORM_RULES: Record<Platform, PlatformRules> = {
  bluesky: {
    maxChars: 300,
    charUnit: 'graphemes',
    maxImages: 4,
    maxVideos: 0,
    imageMaxBytes: 1_000_000,
    notes: 'broll recompresses oversized images automatically; video upload is on the roadmap.',
  },
  x: {
    maxChars: 280,
    charUnit: 'weighted',
    maxImages: 4,
    maxVideos: 1,
    imageMaxBytes: 5 * 1024 * 1024,
    videoMaxBytes: 512 * 1024 * 1024,
  },
  linkedin: {
    maxChars: 3000,
    charUnit: 'graphemes',
    maxImages: 9,
    maxVideos: 1,
  },
  export: {
    maxChars: Number.MAX_SAFE_INTEGER,
    charUnit: 'graphemes',
    maxImages: Number.MAX_SAFE_INTEGER,
    maxVideos: Number.MAX_SAFE_INTEGER,
  },
};

const URL_PATTERN = /https?:\/\/[^\s]+/g;

export function graphemeLength(text: string): number {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let count = 0;
  for (const _ of segmenter.segment(text)) count += 1;
  return count;
}

/**
 * X's weighted length: every URL counts as 23 regardless of its real
 * length. (Full CJK weighting is intentionally not modelled; this is the
 * rule that actually bites automated posts.)
 */
export function weightedLength(text: string): number {
  const withoutUrls = text.replace(URL_PATTERN, '');
  const urlCount = text.match(URL_PATTERN)?.length ?? 0;
  return graphemeLength(withoutUrls) + urlCount * 23;
}

export function textLengthFor(platform: Platform, text: string): number {
  return PLATFORM_RULES[platform].charUnit === 'weighted' ? weightedLength(text) : graphemeLength(text);
}

export interface Violation {
  platform: Platform;
  rule: string;
  message: string;
}

export function validateForPlatform(platform: Platform, text: string, media: ResolvedMedia[]): Violation[] {
  const rules = PLATFORM_RULES[platform];
  const violations: Violation[] = [];

  const length = textLengthFor(platform, text);
  if (length > rules.maxChars) {
    violations.push({
      platform,
      rule: 'text-length',
      message: `Text is ${length} chars; ${platform} allows ${rules.maxChars}. Shorten by ${length - rules.maxChars}.`,
    });
  }

  const images = media.filter((m) => m.kind === 'image');
  const videos = media.filter((m) => m.kind === 'video');

  if (images.length > 0 && videos.length > 0) {
    violations.push({ platform, rule: 'media-mix', message: 'Mixing images and video in one post is not supported.' });
  }
  if (images.length > rules.maxImages) {
    violations.push({
      platform,
      rule: 'image-count',
      message: `${images.length} images attached; ${platform} allows ${rules.maxImages}.`,
    });
  }
  if (videos.length > rules.maxVideos) {
    violations.push({
      platform,
      rule: 'video-count',
      message:
        rules.maxVideos === 0
          ? `${platform} video posting is not supported by broll yet.`
          : `${videos.length} videos attached; ${platform} allows ${rules.maxVideos}.`,
    });
  }
  if (rules.videoMaxBytes) {
    for (const v of videos) {
      if (v.sizeBytes > rules.videoMaxBytes) {
        violations.push({
          platform,
          rule: 'video-size',
          message: `${v.path} is ${(v.sizeBytes / 1e6).toFixed(1)}MB; ${platform} allows ${(rules.videoMaxBytes / 1e6).toFixed(0)}MB.`,
        });
      }
    }
  }
  for (const m of media) {
    if (m.kind === 'audio' || m.kind === 'other') {
      violations.push({ platform, rule: 'media-kind', message: `${m.path} is not an image or video.` });
    }
  }

  return violations;
}
