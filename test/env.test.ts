import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { parseDotenv } from '../src/env.js';

describe('parseDotenv', () => {
  it('parses plain, quoted, and exported values', () => {
    expect(
      parseDotenv(
        [
          '# social creds',
          'BLUESKY_IDENTIFIER=me.bsky.social',
          "BLUESKY_APP_PASSWORD='abcd-efgh-ijkl-mnop'",
          'export X_API_KEY="key with spaces"',
          '',
          'not a valid line',
          'OPENAI_API_KEY=sk-123 # trailing comment',
        ].join('\n'),
      ),
    ).toEqual({
      BLUESKY_IDENTIFIER: 'me.bsky.social',
      BLUESKY_APP_PASSWORD: 'abcd-efgh-ijkl-mnop',
      X_API_KEY: 'key with spaces',
      OPENAI_API_KEY: 'sk-123',
    });
  });

  it('keeps # inside quoted values', () => {
    expect(parseDotenv('A="b # c"')).toEqual({ A: 'b # c' });
  });
});

describe('loadConfig .env merging', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'broll-env-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads credentials from the workspace .env', () => {
    const home = path.join(dir, 'home');
    mkdirSync(home, { recursive: true });
    writeFileSync(path.join(home, '.env'), 'GEMINI_API_KEY=from-workspace\n');

    const config = loadConfig({ cwd: dir, env: { BROLL_HOME: home } as NodeJS.ProcessEnv });
    expect(config.env.GEMINI_API_KEY).toBe('from-workspace');
  });

  it('cwd .env overrides workspace .env; real env wins over both', () => {
    const home = path.join(dir, 'home');
    mkdirSync(home, { recursive: true });
    writeFileSync(path.join(home, '.env'), 'A=workspace\nB=workspace\nC=workspace\n');
    writeFileSync(path.join(dir, '.env'), 'A=cwd\nB=cwd\n');

    const config = loadConfig({ cwd: dir, env: { BROLL_HOME: home, A: 'real' } as NodeJS.ProcessEnv });
    expect(config.env.A).toBe('real');
    expect(config.env.B).toBe('cwd');
    expect(config.env.C).toBe('workspace');
  });
});
