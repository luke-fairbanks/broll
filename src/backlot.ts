import type { BacklotConfig } from './config.js';
import { ExecaFfmpegRunner, type FfmpegRunner } from './render/ffmpeg.js';
import { Renderer } from './render/renderer.js';
import { CarouselRenderer } from './render/carousel.js';
import { GeminiProvider } from './providers/gemini.js';
import { MockProvider } from './providers/mock.js';
import { OpenAiProvider } from './providers/openai.js';
import { ProviderRegistry } from './providers/registry.js';
import { BlueskyAdapter } from './social/bluesky.js';
import { DraftStore } from './social/drafts.js';
import { ExportAdapter } from './social/export.js';
import { Publisher } from './social/publisher.js';
import { XAdapter } from './social/x.js';
import { Workspace } from './workspace.js';

/**
 * Composition root. Everything is constructed here and nowhere else, so
 * tests can assemble the same graph around a temp workspace or fakes.
 */
export interface Backlot {
  config: BacklotConfig;
  workspace: Workspace;
  runner: FfmpegRunner;
  renderer: Renderer;
  carousel: CarouselRenderer;
  providers: ProviderRegistry;
  drafts: DraftStore;
  publisher: Publisher;
}

export function createBacklot(config: BacklotConfig, overrides: Partial<Backlot> = {}): Backlot {
  const workspace = overrides.workspace ?? new Workspace(config.workspaceDir);
  const runner = overrides.runner ?? new ExecaFfmpegRunner();
  const renderer = overrides.renderer ?? new Renderer(workspace, runner, config.brand, config.env);
  const carousel = overrides.carousel ?? new CarouselRenderer(workspace, config.brand);
  const providers =
    overrides.providers ??
    new ProviderRegistry(
      [new OpenAiProvider(config.env), new GeminiProvider(config.env), new MockProvider(runner)],
      { image: config.defaults.imageProvider, video: config.defaults.videoProvider },
    );
  const drafts = overrides.drafts ?? new DraftStore(workspace);
  const publisher =
    overrides.publisher ??
    new Publisher(workspace, drafts, [
      new BlueskyAdapter(config.env),
      new XAdapter(config.env),
      new ExportAdapter(workspace),
    ]);

  return { config, workspace, runner, renderer, carousel, providers, drafts, publisher };
}
