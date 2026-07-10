/**
 * Generation providers are strictly BYO-key: Backlot never proxies or
 * marks up inference. A provider is "configured" when its key is in the
 * environment; otherwise the deterministic mock provider keeps every
 * workflow runnable end-to-end.
 */

export type ImageAspect = 'square' | 'portrait' | 'landscape';

export interface ImageGenRequest {
  prompt: string;
  aspect: ImageAspect;
  n: number;
}

export interface VideoGenRequest {
  prompt: string;
  aspect: '9:16' | '16:9';
  durationSec?: number;
}

export interface GeneratedMedia {
  data: Buffer;
  ext: 'png' | 'jpg' | 'mp4';
}

export interface Provider {
  readonly name: string;
  readonly capabilities: ReadonlyArray<'image' | 'video'>;
  /** Human-readable requirement, e.g. "OPENAI_API_KEY env var". */
  readonly requirement: string;
  isConfigured(): boolean;
  generateImages?(req: ImageGenRequest): Promise<GeneratedMedia[]>;
  generateVideo?(req: VideoGenRequest): Promise<GeneratedMedia>;
}

export type FetchLike = typeof globalThis.fetch;

export async function readErrorBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 300);
  } catch {
    return '<unreadable body>';
  }
}
