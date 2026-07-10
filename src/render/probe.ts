import { z } from 'zod';
import type { FfmpegRunner } from './ffmpeg.js';

const StreamSchema = z.looseObject({
  codec_type: z.string().optional(),
  codec_name: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  duration: z.string().optional(),
  r_frame_rate: z.string().optional(),
});

const ProbeOutputSchema = z.object({
  format: z
    .looseObject({
      duration: z.string().optional(),
      size: z.string().optional(),
      format_name: z.string().optional(),
    })
    .optional(),
  streams: z.array(StreamSchema).default([]),
});

export interface MediaInfo {
  path: string;
  durationSec?: number;
  width?: number;
  height?: number;
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec?: string;
  audioCodec?: string;
  sizeBytes?: number;
  formatName?: string;
}

export function probeArgs(filePath: string): string[] {
  return ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath];
}

export async function probeMedia(runner: FfmpegRunner, filePath: string): Promise<MediaInfo> {
  const { stdout } = await runner.probe(probeArgs(filePath));
  const parsed = ProbeOutputSchema.parse(JSON.parse(stdout));

  const video = parsed.streams.find((s) => s.codec_type === 'video');
  const audio = parsed.streams.find((s) => s.codec_type === 'audio');

  const durationRaw = parsed.format?.duration ?? video?.duration ?? audio?.duration;
  const duration = durationRaw ? Number.parseFloat(durationRaw) : undefined;

  return {
    path: filePath,
    durationSec: duration !== undefined && Number.isFinite(duration) ? duration : undefined,
    width: video?.width,
    height: video?.height,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    videoCodec: video?.codec_name,
    audioCodec: audio?.codec_name,
    sizeBytes: parsed.format?.size ? Number.parseInt(parsed.format.size, 10) : undefined,
    formatName: parsed.format?.format_name,
  };
}

export type MediaProber = (filePath: string) => Promise<MediaInfo>;
