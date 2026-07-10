import { execa } from 'execa';

/**
 * Thin, deterministic ffmpeg runner. Everything above this layer builds
 * plain argument arrays (pure, unit-testable); this is the only place a
 * process is spawned.
 */

export interface FfmpegRunner {
  run(args: string[]): Promise<{ stdout: string; stderr: string }>;
  probe(args: string[]): Promise<{ stdout: string }>;
}

export function resolveFfmpegBinary(env: NodeJS.ProcessEnv = process.env): string {
  return env.BACKLOT_FFMPEG ?? 'ffmpeg';
}

export function resolveFfprobeBinary(env: NodeJS.ProcessEnv = process.env): string {
  return env.BACKLOT_FFPROBE ?? 'ffprobe';
}

export class ExecaFfmpegRunner implements FfmpegRunner {
  constructor(
    private readonly ffmpegBin = resolveFfmpegBinary(),
    private readonly ffprobeBin = resolveFfprobeBinary(),
  ) {}

  async run(args: string[]): Promise<{ stdout: string; stderr: string }> {
    try {
      const result = await execa(this.ffmpegBin, args, { stderr: 'pipe', stdout: 'pipe' });
      return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    } catch (error) {
      throw toFfmpegError(error, args);
    }
  }

  async probe(args: string[]): Promise<{ stdout: string }> {
    try {
      const result = await execa(this.ffprobeBin, args, { stdout: 'pipe', stderr: 'pipe' });
      return { stdout: result.stdout ?? '' };
    } catch (error) {
      throw toFfmpegError(error, args, 'ffprobe');
    }
  }
}

function toFfmpegError(error: unknown, args: string[], tool = 'ffmpeg'): Error {
  const e = error as { stderr?: string; shortMessage?: string; code?: string };
  if (e.code === 'ENOENT') {
    return new Error(
      `${tool} binary not found. Install ffmpeg (e.g. \`brew install ffmpeg\`) or set BACKLOT_FFMPEG / BACKLOT_FFPROBE.`,
    );
  }
  const stderrTail = (e.stderr ?? '').split('\n').filter(Boolean).slice(-8).join('\n');
  return new Error(`${tool} failed.\nArgs: ${args.join(' ')}\n${stderrTail || e.shortMessage || String(error)}`);
}

export async function ffmpegVersion(runner?: FfmpegRunner): Promise<string | undefined> {
  try {
    const r = runner ?? new ExecaFfmpegRunner();
    const { stdout } = await r.run(['-version']);
    return stdout.split('\n')[0];
  } catch {
    return undefined;
  }
}
