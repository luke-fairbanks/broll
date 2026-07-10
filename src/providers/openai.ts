import type { FetchLike, GeneratedMedia, ImageGenRequest, Provider } from './types.js';
import { readErrorBody } from './types.js';

const SIZE_BY_ASPECT: Record<ImageGenRequest['aspect'], string> = {
  square: '1024x1024',
  portrait: '1024x1536',
  landscape: '1536x1024',
};

export class OpenAiProvider implements Provider {
  readonly name = 'openai';
  readonly capabilities = ['image'] as const;
  readonly requirement = 'OPENAI_API_KEY env var';

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly fetchImpl: FetchLike = globalThis.fetch,
    private readonly baseUrl = 'https://api.openai.com/v1',
  ) {}

  isConfigured(): boolean {
    return Boolean(this.env.OPENAI_API_KEY);
  }

  private get model(): string {
    return this.env.BROLL_OPENAI_IMAGE_MODEL ?? 'gpt-image-1';
  }

  async generateImages(req: ImageGenRequest): Promise<GeneratedMedia[]> {
    const res = await this.fetchImpl(`${this.baseUrl}/images/generations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        prompt: req.prompt,
        n: req.n,
        size: SIZE_BY_ASPECT[req.aspect],
      }),
    });
    if (!res.ok) {
      throw new Error(`OpenAI image generation failed (${res.status}): ${await readErrorBody(res)}`);
    }
    const json = (await res.json()) as { data?: Array<{ b64_json?: string }> };
    const images = (json.data ?? []).filter((d) => d.b64_json);
    if (images.length === 0) {
      throw new Error('OpenAI returned no image data. Check the model name and your account access.');
    }
    return images.map((d) => ({ data: Buffer.from(d.b64_json!, 'base64'), ext: 'png' as const }));
  }
}
