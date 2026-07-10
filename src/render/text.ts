/**
 * Deterministic text layout for burned-in captions and overlays.
 *
 * ffmpeg's drawtext does not wrap text, and escaping arbitrary strings
 * inside a filtergraph is a reliability tar pit. Backlot sidesteps both:
 * text is wrapped here in code and written to id-named textfiles whose
 * paths contain no characters that need escaping.
 */

/** Estimate how many characters fit per line for a given width/font size. */
export function charsPerLine(frameWidth: number, fontSize: number, usableRatio = 0.9): number {
  // 0.55 is a conservative average glyph-width/font-size ratio for sans fonts.
  return Math.max(8, Math.floor((frameWidth * usableRatio) / (fontSize * 0.55)));
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
  return wrapText(text, charsPerLine(frameWidth, fontSize)).join('\n');
}

/**
 * Paths fed into filtergraph options (fontfile=, textfile=) must be
 * boring: no spaces, quotes, colons, commas, brackets. Workspace paths
 * are id-named so they always pass; anything else must be staged first.
 */
export function isFilterSafePath(p: string): boolean {
  return /^[A-Za-z0-9_\-./]+$/.test(p);
}
