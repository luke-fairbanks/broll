import { existsSync, readFileSync } from 'node:fs';

/**
 * Minimal .env support so credentials live in a file, not in whatever
 * shell happened to launch the MCP client. No interpolation, no
 * multiline values — secrets files should be boring.
 */

const LINE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

export function parseDotenv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = LINE.exec(line);
    if (!match) continue;
    const key = match[1]!;
    let value = match[2]!.trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    } else {
      // strip trailing comments on unquoted values: KEY=abc  # note
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trimEnd();
    }
    out[key] = value;
  }
  return out;
}

export function readDotenvFile(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  return parseDotenv(readFileSync(file, 'utf8'));
}
