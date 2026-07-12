import { writeFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Broll } from './broll.js';
import { ffmpegVersion } from './render/ffmpeg.js';
import { probeMedia } from './render/probe.js';
import { CarouselSpecSchema } from './render/carousel.js';
import { RenderPlanSchema } from './render/plan.js';
import { AssetKindSchema } from './workspace.js';
import { PlatformSchema } from './social/types.js';

const VERSION = '0.1.1';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function json(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function fail(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }, null, 2) }], isError: true };
}

async function guard(fn: () => Promise<ToolResult> | ToolResult): Promise<ToolResult> {
  try {
    return await fn();
  } catch (error) {
    return fail(error);
  }
}

export function buildServer(broll: Broll): McpServer {
  const server = new McpServer({ name: 'broll', version: VERSION });
  const { workspace, renderer, carousel, providers, drafts, publisher, runner, config, bluesky, xAdapter, mastodon } =
    broll;

  server.registerTool(
    'broll_status',
    {
      title: 'broll status',
      description:
        'Report workspace location, ffmpeg availability, configured generation providers, and social platform readiness. Call this first to see what is possible. Pass probe: true to live-verify social credentials (makes real authenticated API calls, posts nothing).',
      inputSchema: {
        probe: z.boolean().default(false).describe('Live-verify social platform credentials (no posts are made)'),
      },
    },
    async ({ probe }) =>
      guard(async () => {
        const status: Record<string, unknown> = {
          version: VERSION,
          workspace: workspace.root,
          configFile: config.configPath ?? 'none (using defaults — create broll.config.json to set your brand)',
          brand: config.brand,
          ffmpeg: (await ffmpegVersion(runner)) ?? 'NOT FOUND — install ffmpeg or set BROLL_FFMPEG',
          providers: providers.statuses(),
          platforms: publisher.adapterStatus(),
          assets: workspace.listAssets().length,
          drafts: drafts.list().length,
        };
        if (probe) {
          const probes: Record<string, { ok: boolean; detail: string }> = {};
          if (bluesky.isConfigured()) probes.bluesky = await bluesky.probe();
          if (xAdapter.isConfigured()) probes.x = await xAdapter.probe();
          if (mastodon.isConfigured()) probes.mastodon = await mastodon.probe();
          status.credentialProbes = Object.keys(probes).length
            ? probes
            : 'no live platforms configured — nothing to probe';
        }
        return json(status);
      }),
  );

  server.registerTool(
    'generate_image',
    {
      title: 'Generate image',
      description:
        'Generate image(s) with the user’s own API keys (BYO-key: OpenAI or Gemini; falls back to a labelled mock when no keys are set). Returns workspace asset ids usable in render_video, render_carousel, and post drafts.',
      inputSchema: {
        prompt: z.string().min(1),
        aspect: z.enum(['square', 'portrait', 'landscape']).default('square'),
        n: z.number().int().min(1).max(4).default(1),
        provider: z.string().optional().describe('Force a provider by name: openai | gemini | mock'),
        label: z.string().optional().describe('Human-readable label stored on the asset'),
      },
    },
    async ({ prompt, aspect, n, provider, label }) =>
      guard(async () => {
        const choice = providers.pick('image', provider);
        const generated = await choice.provider.generateImages!({ prompt, aspect, n });
        const assets = generated.map((media, i) => {
          const out = workspace.newFilePath('assets', media.ext);
          writeFileSync(out.path, media.data);
          return workspace.registerFile(out.path, {
            id: out.id,
            source: `generate_image:${choice.provider.name}`,
            label: label ? `${label}${n > 1 ? `-${i + 1}` : ''}` : undefined,
          });
        });
        return json({ provider: choice.provider.name, providerReason: choice.reason, assets });
      }),
  );

  server.registerTool(
    'generate_video',
    {
      title: 'Generate video',
      description:
        'Generate a short video clip with the user’s own API keys (Gemini Veo when configured; labelled mock otherwise). Expensive with real keys — only call when the user’s workflow needs generated footage.',
      inputSchema: {
        prompt: z.string().min(1),
        aspect: z.enum(['9:16', '16:9']).default('9:16'),
        durationSec: z.number().int().min(2).max(12).optional(),
        provider: z.string().optional().describe('Force a provider by name: gemini | mock'),
      },
    },
    async ({ prompt, aspect, durationSec, provider }) =>
      guard(async () => {
        const choice = providers.pick('video', provider);
        const media = await choice.provider.generateVideo!({ prompt, aspect, durationSec });
        const out = workspace.newFilePath('assets', media.ext);
        writeFileSync(out.path, media.data);
        const asset = workspace.registerFile(out.path, { id: out.id, source: `generate_video:${choice.provider.name}` });
        return json({ provider: choice.provider.name, providerReason: choice.reason, asset });
      }),
  );

  server.registerTool(
    'import_asset',
    {
      title: 'Import asset',
      description: 'Copy a local file (image/video/audio) into the broll workspace and get an asset id for it.',
      inputSchema: {
        path: z.string().describe('Absolute path to the file'),
        label: z.string().optional(),
      },
    },
    async ({ path: filePath, label }) => guard(async () => json({ asset: workspace.importAsset(filePath, { label }) })),
  );

  server.registerTool(
    'list_assets',
    {
      title: 'List assets',
      description: 'List workspace assets (generated, imported, and rendered), optionally filtered by kind.',
      inputSchema: { kind: AssetKindSchema.optional() },
    },
    async ({ kind }) =>
      guard(async () => json({ assets: workspace.listAssets().filter((a) => !kind || a.kind === kind) })),
  );

  server.registerTool(
    'probe_asset',
    {
      title: 'Probe asset',
      description: 'Inspect a media file: duration, dimensions, codecs, streams. Accepts an asset id or absolute path.',
      inputSchema: { asset: z.string() },
    },
    async ({ asset }) => guard(async () => json(await probeMedia(runner, workspace.resolvePath(asset)))),
  );

  server.registerTool(
    'render_video',
    {
      title: 'Render video',
      description:
        'Compile a declarative RenderPlan into an mp4 via ffmpeg — deterministic, brand-aware, no generation keys needed. Clips (video/image/color) are concatenated in order; overlays and captions are burned in; optional music is mixed under clip audio. Returns the rendered asset id.',
      inputSchema: { plan: RenderPlanSchema },
    },
    async ({ plan }) => guard(async () => json(await renderer.render(plan))),
  );

  server.registerTool(
    'render_carousel',
    {
      title: 'Render carousel',
      description:
        'Render branded carousel slides (the Instagram/LinkedIn format). Layout, fonts, accent bar, page numbers, and watermark are deterministic code; backgrounds can be plain color or any image asset. Returns one asset per slide.',
      inputSchema: { spec: CarouselSpecSchema },
    },
    async ({ spec }) => guard(async () => json(await carousel.render(spec))),
  );

  server.registerTool(
    'extract_frame',
    {
      title: 'Extract frame',
      description: 'Extract a single PNG frame from a video at a timestamp — use it to visually QA a render.',
      inputSchema: { asset: z.string(), atSec: z.number().min(0).default(0) },
    },
    async ({ asset, atSec }) => guard(async () => json({ frame: await renderer.extractFrame(asset, atSec) })),
  );

  server.registerTool(
    'create_post_draft',
    {
      title: 'Create post draft',
      description:
        'Create a reviewable post draft (text + media + target platforms). Validates against per-platform rules (char limits, media counts/sizes) and reports violations. Nothing is published — drafts are files the user can inspect; use publish_post to send.',
      inputSchema: {
        text: z.string().min(1),
        media: z.array(z.string()).default([]).describe('Asset ids or absolute paths'),
        platforms: z.array(PlatformSchema).min(1),
      },
    },
    async ({ text, media, platforms }) =>
      guard(async () => {
        const draft = drafts.create({ posts: [{ text, media }], platforms });
        const violations = publisher.validate(draft);
        return json({
          draft,
          violations,
          note:
            violations.length > 0
              ? 'Draft saved but has violations — fix them (create a new draft) before publish_post.'
              : 'Draft saved. Publish with publish_post({ draftId, confirm: true }).',
        });
      }),
  );

  server.registerTool(
    'create_thread_draft',
    {
      title: 'Create thread draft',
      description:
        'Create a multi-post thread draft. On publish, posts chain as replies under the first one (Bluesky reply refs, X in_reply_to). Each post has its own text and up to 4 images, validated per platform. Nothing is published until publish_post with confirm: true.',
      inputSchema: {
        posts: z
          .array(z.object({ text: z.string().min(1), media: z.array(z.string()).default([]) }))
          .min(2)
          .max(25),
        platforms: z.array(PlatformSchema).min(1),
      },
    },
    async ({ posts, platforms }) =>
      guard(async () => {
        const draft = drafts.create({ posts, platforms });
        const violations = publisher.validate(draft);
        return json({
          draft,
          violations,
          note:
            violations.length > 0
              ? 'Thread draft saved but has violations — fix them before publish_post.'
              : `Thread draft saved (${posts.length} posts). Publish with publish_post({ draftId, confirm: true }).`,
        });
      }),
  );

  server.registerTool(
    'set_profile',
    {
      title: 'Set profile',
      description:
        'Update the Bluesky profile (display name, bio, avatar image) — merges with the existing profile, never clobbers other fields. Requires confirm: true because it changes the public account.',
      inputSchema: {
        displayName: z.string().max(64).optional(),
        bio: z.string().max(256).optional(),
        avatarAsset: z.string().optional().describe('Asset id or absolute path of an image'),
        confirm: z.boolean().describe('Must be true. Confirms the user explicitly approved this profile change.'),
      },
    },
    async ({ displayName, bio, avatarAsset, confirm }) =>
      guard(async () => {
        if (confirm !== true) {
          return fail('set_profile requires confirm: true. Ask the user to approve the profile change first.');
        }
        if (!bluesky.isConfigured()) {
          return fail(`Bluesky is not configured. ${bluesky.configHelp}`);
        }
        if (displayName === undefined && bio === undefined && !avatarAsset) {
          return fail('Nothing to change — pass displayName, bio, and/or avatarAsset.');
        }
        await bluesky.setProfile({
          displayName,
          description: bio,
          avatarPath: avatarAsset ? workspace.resolvePath(avatarAsset) : undefined,
        });
        return json({ ok: true, updated: { displayName, bio, avatarAsset } });
      }),
  );

  server.registerTool(
    'list_drafts',
    {
      title: 'List drafts',
      description: 'List post drafts in the outbox with status and publish results.',
      inputSchema: {},
    },
    async () => guard(async () => json({ drafts: drafts.list() })),
  );

  server.registerTool(
    'publish_post',
    {
      title: 'Publish post',
      description:
        'Publish a draft to its target platforms. Requires confirm: true — never call this without the user’s explicit go-ahead in the conversation. Platforms without credentials fail independently with setup instructions; "export" always succeeds and writes a ready-to-post bundle.',
      inputSchema: {
        draftId: z.string(),
        confirm: z
          .boolean()
          .describe('Must be true. Confirms the user explicitly approved publishing this draft now.'),
        platforms: z
          .array(PlatformSchema)
          .optional()
          .describe('Publish to only this subset of the draft’s platforms (e.g. test one network first).'),
      },
    },
    async ({ draftId, confirm, platforms }) =>
      guard(async () => {
        if (confirm !== true) {
          return fail(
            'publish_post requires confirm: true. Ask the user to approve publishing this draft, then call again.',
          );
        }
        const violations = publisher.validate(drafts.get(draftId));
        if (violations.length > 0) {
          return fail(`Draft has constraint violations: ${violations.map((v) => `[${v.platform}] ${v.message}`).join(' ')}`);
        }
        return json(await publisher.publish(draftId, { platforms }));
      }),
  );

  return server;
}
