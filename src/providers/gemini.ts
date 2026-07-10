import type { FetchLike, GeneratedMedia, ImageGenRequest, Provider, VideoGenRequest } from './types.js';
import { readErrorBody } from './types.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const ASPECT_RATIO: Record<ImageGenRequest['aspect'], string> = {
  square: '1:1',
  portrait: '9:16',
  landscape: '16:9',
};

/**
 * Google provider: Imagen for stills, Veo for video. Veo runs as a
 * long-running operation that is polled until done. Video generation is
 * expensive — Backlot only ever calls it when the agent explicitly asks.
 */
export class GeminiProvider implements Provider {
  readonly name = 'gemini';
  readonly capabilities = ['image', 'video'] as const;
  readonly requirement = 'GEMINI_API_KEY env var';

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly fetchImpl: FetchLike = globalThis.fetch,
    private readonly baseUrl = GEMINI_BASE,
    private readonly pollIntervalMs = 5000,
    private readonly pollTimeoutMs = 6 * 60_000,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.env.GEMINI_API_KEY);
  }

  private headers(): Record<string, string> {
    return { 'x-goog-api-key': this.env.GEMINI_API_KEY ?? '', 'Content-Type': 'application/json' };
  }

  private get imageModel(): string {
    return this.env.BACKLOT_GEMINI_IMAGE_MODEL ?? 'imagen-4.0-generate-001';
  }

  private get videoModel(): string {
    return this.env.BACKLOT_GEMINI_VIDEO_MODEL ?? 'veo-3.0-generate-001';
  }

  async generateImages(req: ImageGenRequest): Promise<GeneratedMedia[]> {
    const res = await this.fetchImpl(`${this.baseUrl}/models/${this.imageModel}:predict`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        instances: [{ prompt: req.prompt }],
        parameters: { sampleCount: req.n, aspectRatio: ASPECT_RATIO[req.aspect] },
      }),
    });
    if (!res.ok) {
      throw new Error(`Gemini image generation failed (${res.status}): ${await readErrorBody(res)}`);
    }
    const json = (await res.json()) as {
      predictions?: Array<{ bytesBase64Encoded?: string; mimeType?: string }>;
    };
    const predictions = (json.predictions ?? []).filter((p) => p.bytesBase64Encoded);
    if (predictions.length === 0) {
      throw new Error('Gemini returned no image data. Check BACKLOT_GEMINI_IMAGE_MODEL and your API access.');
    }
    return predictions.map((p) => ({
      data: Buffer.from(p.bytesBase64Encoded!, 'base64'),
      ext: p.mimeType?.includes('jpeg') ? ('jpg' as const) : ('png' as const),
    }));
  }

  async generateVideo(req: VideoGenRequest): Promise<GeneratedMedia> {
    const start = await this.fetchImpl(`${this.baseUrl}/models/${this.videoModel}:predictLongRunning`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        instances: [{ prompt: req.prompt }],
        parameters: {
          aspectRatio: req.aspect,
          ...(req.durationSec ? { durationSeconds: req.durationSec } : {}),
        },
      }),
    });
    if (!start.ok) {
      throw new Error(`Veo video generation failed to start (${start.status}): ${await readErrorBody(start)}`);
    }
    const { name } = (await start.json()) as { name?: string };
    if (!name) throw new Error('Veo did not return an operation name.');

    const deadline = Date.now() + this.pollTimeoutMs;
    for (;;) {
      if (Date.now() > deadline) {
        throw new Error(`Veo operation ${name} timed out after ${this.pollTimeoutMs / 1000}s.`);
      }
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
      const poll = await this.fetchImpl(`${this.baseUrl}/${name}`, { headers: this.headers() });
      if (!poll.ok) {
        throw new Error(`Veo operation poll failed (${poll.status}): ${await readErrorBody(poll)}`);
      }
      const op = (await poll.json()) as {
        done?: boolean;
        error?: { message?: string };
        response?: {
          generateVideoResponse?: {
            generatedSamples?: Array<{ video?: { uri?: string; encodedVideo?: string } }>;
          };
        };
      };
      if (!op.done) continue;
      if (op.error) throw new Error(`Veo operation failed: ${op.error.message ?? 'unknown error'}`);

      const sample = op.response?.generateVideoResponse?.generatedSamples?.[0]?.video;
      if (sample?.encodedVideo) {
        return { data: Buffer.from(sample.encodedVideo, 'base64'), ext: 'mp4' };
      }
      if (sample?.uri) {
        const file = await this.fetchImpl(sample.uri, { headers: { 'x-goog-api-key': this.env.GEMINI_API_KEY ?? '' } });
        if (!file.ok) throw new Error(`Failed to download Veo output (${file.status}).`);
        return { data: Buffer.from(await file.arrayBuffer()), ext: 'mp4' };
      }
      throw new Error('Veo finished but returned no video payload; the API shape may have changed.');
    }
  }
}
