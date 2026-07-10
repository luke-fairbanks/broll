import { describe, expect, it } from 'vitest';
import { graphemeLength, textLengthFor, validateForPlatform, weightedLength } from '../src/social/constraints.js';
import type { ResolvedMedia } from '../src/social/types.js';

const img = (sizeBytes = 1000): ResolvedMedia => ({ path: '/a.png', kind: 'image', sizeBytes });
const vid = (sizeBytes = 1000): ResolvedMedia => ({ path: '/a.mp4', kind: 'video', sizeBytes });

describe('length counting', () => {
  it('counts emoji as single graphemes', () => {
    expect(graphemeLength('👩‍👩‍👧‍👦 hi')).toBe(4); // family emoji is one grapheme
  });

  it('weights every URL as 23 chars for X', () => {
    const text = 'check this https://example.com/a/very/long/path/that/goes/on/forever/and/ever';
    expect(weightedLength(text)).toBe(graphemeLength('check this ') + 23);
  });

  it('uses the right unit per platform', () => {
    const url = 'https://x.example/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    expect(textLengthFor('x', url)).toBe(23);
    expect(textLengthFor('bluesky', url)).toBe(url.length);
  });
});

describe('validateForPlatform', () => {
  it('passes a clean post', () => {
    expect(validateForPlatform('bluesky', 'hello world', [img()])).toEqual([]);
  });

  it('flags over-length text with the amount to cut', () => {
    const violations = validateForPlatform('bluesky', 'a'.repeat(305), []);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.rule).toBe('text-length');
    expect(violations[0]!.message).toContain('Shorten by 5');
  });

  it('flags too many images', () => {
    const violations = validateForPlatform('x', 'hi', [img(), img(), img(), img(), img()]);
    expect(violations.some((v) => v.rule === 'image-count')).toBe(true);
  });

  it('flags video on platforms Backlot cannot upload video to yet', () => {
    const violations = validateForPlatform('bluesky', 'hi', [vid()]);
    expect(violations.some((v) => v.rule === 'video-count')).toBe(true);
  });

  it('flags mixing images and video', () => {
    const violations = validateForPlatform('x', 'hi', [img(), vid()]);
    expect(violations.some((v) => v.rule === 'media-mix')).toBe(true);
  });

  it('flags oversized video for X', () => {
    const violations = validateForPlatform('x', 'hi', [vid(600 * 1024 * 1024)]);
    expect(violations.some((v) => v.rule === 'video-size')).toBe(true);
  });

  it('never flags the export platform', () => {
    const violations = validateForPlatform('export', 'a'.repeat(100_000), [img(), vid()]);
    expect(violations.filter((v) => v.rule !== 'media-mix')).toEqual([]);
  });
});
