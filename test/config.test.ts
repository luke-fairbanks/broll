import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'backlot-cfg-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('produces sensible defaults with no config file', () => {
    const config = loadConfig({ cwd: dir, env: { BACKLOT_HOME: path.join(dir, 'home') } as NodeJS.ProcessEnv });
    expect(config.workspaceDir).toBe(path.join(dir, 'home'));
    expect(config.brand.colors.primary).toBe('#E4572E');
    expect(config.defaults.aspect).toBe('9:16');
    expect(config.configPath).toBeUndefined();
  });

  it('reads backlot.config.json from cwd and merges defaults', () => {
    writeFileSync(
      path.join(dir, 'backlot.config.json'),
      JSON.stringify({ brand: { name: 'Acme', handle: '@acme', colors: { primary: '#00FF00' } } }),
    );
    const config = loadConfig({ cwd: dir, env: { BACKLOT_HOME: path.join(dir, 'home') } as NodeJS.ProcessEnv });
    expect(config.brand.name).toBe('Acme');
    expect(config.brand.handle).toBe('@acme');
    expect(config.brand.colors.primary).toBe('#00FF00');
    expect(config.brand.colors.background).toBe('#101014'); // default survives partial override
    expect(config.configPath).toBe(path.join(dir, 'backlot.config.json'));
  });

  it('rejects malformed config files loudly', () => {
    writeFileSync(path.join(dir, 'backlot.config.json'), JSON.stringify({ brand: { watermarkOpacity: 5 } }));
    expect(() => loadConfig({ cwd: dir, env: {} as NodeJS.ProcessEnv })).toThrow();
  });
});
