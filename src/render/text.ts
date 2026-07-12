/**
 * Deterministic text layout for burned-in captions and overlays.
 *
 * ffmpeg's drawtext does not wrap text, and escaping arbitrary strings
 * inside a filtergraph is a reliability tar pit. broll sidesteps both:
 * text is wrapped here in code and written to id-named textfiles whose
 * paths contain no characters that need escaping.
 */

/**
 * Average glyph-width/font-size ratio for sans fonts. Caps-heavy text
 * runs ~15% wider than mixed case — underestimating it makes headlines
 * overflow the frame.
 */
export function glyphRatio(text?: string): number {
  if (!text) return 0.55;
  const letters = text.replace(/[^a-zA-Z]/g, '');
  if (!letters.length) return 0.55;
  const upper = letters.replace(/[^A-Z]/g, '').length / letters.length;
  return upper >= 0.6 ? 0.64 : 0.55;
}

/** Estimate how many characters fit per line for a given width/font size. */
export function charsPerLine(frameWidth: number, fontSize: number, usableRatio = 0.9, text?: string): number {
  return Math.max(8, Math.floor((frameWidth * usableRatio) / (fontSize * glyphRatio(text))));
}

/** Greedy word wrap. Words longer than a line are hard-split. */
export function wrapText(text: string, maxChars: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';

  const push = () => {
    if (current) lines.push(current);
    current = '';
  };

  for (let word of words) {
    while (word.length > maxChars) {
      push();
      lines.push(word.slice(0, maxChars));
      word = word.slice(maxChars);
    }
    if (!current) {
      current = word;
    } else if (current.length + 1 + word.length <= maxChars) {
      current += ` ${word}`;
    } else {
      push();
      current = word;
    }
  }
  push();
  return lines.length > 0 ? lines : [''];
}

export function wrapForFrame(text: string, frameWidth: number, fontSize: number): string {
  return wrapText(text, charsPerLine(frameWidth, fontSize, 0.9, text)).join('\n');
}

/**
 * Paths fed into filtergraph options (fontfile=, textfile=) must be
 * boring: no spaces, quotes, colons, commas, brackets. Workspace paths
 * are id-named so they always pass; anything else must be staged first.
 */
export function isFilterSafePath(p: string): boolean {
  return /^[A-Za-z0-9_\-./]+$/.test(p);
}
