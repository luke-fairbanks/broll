import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBroll } from '../src/broll.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';

/**
 * Full MCP round trip: a real client over an in-memory transport,
 * against the real server with a temp workspace. This is what Claude
 * Code experiences, minus the stdio pipe.
 */

let dir: string;
let client: Client;

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.find((c) => c.type === 'text')?.text ?? '';
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'broll-mcp-'));
  const config = loadConfig({
    cwd: dir,
    env: { BROLL_HOME: path.join(dir, 'home') } as NodeJS.ProcessEnv, // no keys, no social creds
  });
  const broll = createBroll(config);
  const server = buildServer(broll);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'broll-test-client', version: '0.0.1' });
  await client.connect(clientTransport);
}, 60_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('broll MCP server', () => {
  it('lists the full tool surface', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'broll_status',
        'create_post_draft',
        'create_thread_draft',
        'extract_frame',
        'generate_image',
        'generate_video',
        'import_asset',
        'list_assets',
        'list_drafts',
        'probe_asset',
        'publish_post',
        'render_carousel',
        'render_video',
        'set_profile',
      ].sort(),
    );
  });

  it('reports status with providers and platforms', async () => {
    const result = await client.callTool({ name: 'broll_status', arguments: {} });
    const status = JSON.parse(textOf(result));
    expect(status.ffmpeg).toContain('ffmpeg version');
    expect(status.providers.map((p: { name: string }) => p.name)).toEqual(['openai', 'gemini', 'mock']);
    expect(status.platforms.map((p: { platform: string }) => p.platform)).toEqual(['bluesky', 'x', 'mastodon', 'export']);
    const bluesky = status.platforms.find((p: { platform: string }) => p.platform === 'bluesky');
    expect(bluesky.configured).toBe(false);
    expect(bluesky.configHelp).toContain('BLUESKY_IDENTIFIER');
  });

  it('generates a mock image when no keys are configured, with a reason', async () => {
    const result = await client.callTool({
      name: 'generate_image',
      arguments: { prompt: 'test poster', aspect: 'portrait' },
    });
    const parsed = JSON.parse(textOf(result));
    expect(parsed.provider).toBe('mock');
    expect(parsed.providerReason).toContain('no image provider keys');
    expect(parsed.assets).toHaveLength(1);
    expect(parsed.assets[0].kind).toBe('image');
  }, 60_000);

  it('renders a carousel end-to-end through the tool layer', async () => {
    const result = await client.callTool({
      name: 'render_carousel',
      arguments: { spec: { slides: [{ headline: 'From MCP with love' }] } },
    });
    const parsed = JSON.parse(textOf(result));
    expect(parsed.slides).toHaveLength(1);
    expect(parsed.width).toBe(1080);
  }, 60_000);

  it('creates drafts, validates them, and lists them', async () => {
    const result = await client.callTool({
      name: 'create_post_draft',
      arguments: { text: 'a'.repeat(400), platforms: ['bluesky', 'export'] },
    });
    const parsed = JSON.parse(textOf(result));
    expect(parsed.draft.status).toBe('draft');
    expect(parsed.draft.posts).toHaveLength(1);
    expect(parsed.violations.some((v: { rule: string }) => v.rule === 'text-length')).toBe(true);

    const list = JSON.parse(textOf(await client.callTool({ name: 'list_drafts', arguments: {} })));
    expect(list.drafts.length).toBeGreaterThan(0);
  });

  it('creates thread drafts with per-segment validation messages', async () => {
    const result = await client.callTool({
      name: 'create_thread_draft',
      arguments: {
        posts: [{ text: 'fine first post' }, { text: 'a'.repeat(400) }],
        platforms: ['bluesky'],
      },
    });
    const parsed = JSON.parse(textOf(result));
    expect(parsed.draft.posts).toHaveLength(2);
    expect(parsed.violations).toHaveLength(1);
    expect(parsed.violations[0].message).toContain('[post 2/2]');
  });

  it('publishes a platform subset and refuses to double-post on retry', async () => {
    const draft = JSON.parse(
      textOf(
        await client.callTool({
          name: 'create_post_draft',
          arguments: { text: 'subset test', platforms: ['bluesky', 'export'] },
        }),
      ),
    ).draft;

    const first = JSON.parse(
      textOf(
        await client.callTool({
          name: 'publish_post',
          arguments: { draftId: draft.id, confirm: true, platforms: ['export'] },
        }),
      ),
    );
    expect(first.results.export.ok).toBe(true);
    expect(first.results.bluesky).toBeUndefined(); // subset: bluesky untouched
    expect(first.draft.status).toBe('partial');

    const retry = await client.callTool({
      name: 'publish_post',
      arguments: { draftId: draft.id, confirm: true, platforms: ['export'] },
    });
    expect(retry.isError).toBe(true);
    expect(textOf(retry)).toContain('refusing to double-post');
  });

  it('gates set_profile behind confirm and configuration', async () => {
    const refused = await client.callTool({
      name: 'set_profile',
      arguments: { displayName: 'broll', confirm: false },
    });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('confirm: true');

    const unconfigured = await client.callTool({
      name: 'set_profile',
      arguments: { displayName: 'broll', confirm: true },
    });
    expect(unconfigured.isError).toBe(true);
    expect(textOf(unconfigured)).toContain('BLUESKY_IDENTIFIER');
  });

  it('refuses to publish without confirm: true', async () => {
    const draft = JSON.parse(
      textOf(
        await client.callTool({
          name: 'create_post_draft',
          arguments: { text: 'safe post', platforms: ['export'] },
        }),
      ),
    ).draft;

    const refused = await client.callTool({
      name: 'publish_post',
      arguments: { draftId: draft.id, confirm: false },
    });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('confirm: true');
  });

  it('publishes an export-only draft and records results on the draft', async () => {
    const file = path.join(dir, 'attach.png');
    writeFileSync(file, 'png-ish');
    const draft = JSON.parse(
      textOf(
        await client.callTool({
          name: 'create_post_draft',
          arguments: { text: 'export me', media: [file], platforms: ['export'] },
        }),
      ),
    ).draft;

    const outcome = JSON.parse(
      textOf(await client.callTool({ name: 'publish_post', arguments: { draftId: draft.id, confirm: true } })),
    );
    expect(outcome.draft.status).toBe('published');
    expect(outcome.results.export.ok).toBe(true);
    expect(outcome.results.export.url).toContain('-export');
  });

  it('reports unconfigured platforms per-platform instead of throwing', async () => {
    const draft = JSON.parse(
      textOf(
        await client.callTool({
          name: 'create_post_draft',
          arguments: { text: 'to bluesky', platforms: ['bluesky', 'export'] },
        }),
      ),
    ).draft;

    const outcome = JSON.parse(
      textOf(await client.callTool({ name: 'publish_post', arguments: { draftId: draft.id, confirm: true } })),
    );
    expect(outcome.draft.status).toBe('partial');
    expect(outcome.results.bluesky.ok).toBe(false);
    expect(outcome.results.bluesky.error).toContain('BLUESKY_IDENTIFIER');
    expect(outcome.results.export.ok).toBe(true);
  });
});
