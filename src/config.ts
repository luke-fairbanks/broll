import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';

/**
 * Backlot configuration. Sources, in priority order:
 *   1. Environment variables (keys, workspace override)
 *   2. backlot.config.json in the current working directory
 *   3. backlot.config.json in the workspace root
 *   4. Built-in defaults
 */

export const BrandKitSchema = z.object({
  name: z.string().default('Backlot'),
  handle: z.string().optional(),
  colors: z
    .object({
      primary: z.string().default('#E4572E'),
      background: z.string().default('#101014'),
      text: z.string().default('#FFFFFF'),
      muted: z.string().default('#9CA3AF'),
    })
    .prefault({}),
  /** Absolute path to a .ttf/.otf/.ttc font file. Falls back to a system font. */
  font: z.string().optional(),
  /** Absolute path to a logo image overlaid as a watermark when requested. */
  logo: z.string().optional(),
  watermarkOpacity: z.number().min(0).max(1).default(0.85),
});

export const ConfigFileSchema = z.object({
  workspace: z.string().optional(),
  brand: BrandKitSchema.prefault({}),
  defaults: z
    .object({
      aspect: z.enum(['9:16', '1:1', '4:5', '16:9']).default('9:16'),
      imageProvider: z.string().optional(),
      videoProvider: z.string().optional(),
    })
    .prefault({}),
});

export type BrandKit = z.infer<typeof BrandKitSchema>;
export type ConfigFile = z.infer<typeof ConfigFileSchema>;

export interface BacklotConfig extends ConfigFile {
  workspaceDir: string;
  env: NodeJS.ProcessEnv;
  configPath?: string;
}

function readConfigFile(file: string): ConfigFile | undefined {
  if (!existsSync(file)) return undefined;
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  return ConfigFileSchema.parse(raw);
}

export function loadConfig(opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): BacklotConfig {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;

  const defaultWorkspace = env.BACKLOT_HOME ?? path.join(homedir(), '.backlot');

  const candidates = [path.join(cwd, 'backlot.config.json'), path.join(defaultWorkspace, 'backlot.config.json')];

  let file: ConfigFile | undefined;
  let configPath: string | undefined;
  for (const candidate of candidates) {
    const parsed = readConfigFile(candidate);
    if (parsed) {
      file = parsed;
      configPath = candidate;
      break;
    }
  }

  const base = file ?? ConfigFileSchema.parse({});
  const workspaceDir = env.BACKLOT_HOME ?? base.workspace ?? defaultWorkspace;

  return { ...base, workspaceDir, env, configPath };
}
