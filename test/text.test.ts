import { describe, expect, it } from 'vitest';
import { charsPerLine, isFilterSafePath, wrapText } from '../src/render/text.js';

describe('wrapText', () => {
  it('wraps at word boundaries', () => {
    expect(wrapText('the quick brown fox jumps over the lazy dog', 15)).toEqual([
      'the quick brown',
      'fox jumps over',
      'the lazy dog',
    ]);
  });

  it('hard-splits words longer than a line', () => {
    expect(wrapText('supercalifragilistic', 8)).toEqual(['supercal', 'ifragili', 'stic']);
  });

  it('handles empty input', () => {
    expect(wrapText('', 10)).toEqual(['']);
  });

  it('collapses whitespace', () => {
    expect(wrapText('a   b\n\nc', 10)).toEqual(['a b c']);
  });
});

describe('charsPerLine', () => {
  it('scales inversely with font size', () => {
    expect(charsPerLine(1080, 40)).toBeGreaterThan(charsPerLine(1080, 80));
  });

  it('never returns less than 8', () => {
    expect(charsPerLine(100, 500)).toBe(8);
  });

  it('gives caps-heavy text fewer chars per line (caps run wider)', () => {
    // Regression: "CLAUDE MCP ADD BROLL" overflowed a 1080px frame because
    // the mixed-case glyph ratio underestimated all-caps width.
    expect(charsPerLine(1080, 84, 0.9, 'CLAUDE MCP ADD BROLL')).toBeLessThan(
      charsPerLine(1080, 84, 0.9, 'claude mcp add broll'),
    );
  });
});

describe('isFilterSafePath', () => {
  it('accepts boring workspace paths', () => {
    expect(isFilterSafePath('/Users/luke/.broll/tmp/rnd_1/txt_0.txt')).toBe(true);
  });

  it('rejects paths with spaces, quotes, colons, commas', () => {
    expect(isFilterSafePath('/Users/luke fairbanks/font.ttf')).toBe(false);
    expect(isFilterSafePath("/fonts/it's.ttf")).toBe(false);
    expect(isFilterSafePath('C:\\Windows\\Fonts\\arial.ttf')).toBe(false);
    expect(isFilterSafePath('/a,b/font.ttf')).toBe(false);
  });
});
