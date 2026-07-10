/**
 * End-to-end smoke: drives the real MCP server through a real client —
 * exactly what a coding agent does — and leaves inspectable artifacts
 * in ./.backlot. Run with: npm run smoke
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createBacklot } from '../src/backlot.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parse(result: Awaited<ReturnType<Client['callTool']>>): any {
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.find((c) => c.type === 'text')?.text ?? '{}';
  const parsed = JSON.parse(text);
  if (result.isError) throw new Error(`tool error: ${parsed.error}`);
  return parsed;
}

async function main(): Promise<void> {
  const config = loadConfig({
    cwd: repoRoot,
    env: { ...process.env, BACKLOT_HOME: path.join(repoRoot, '.backlot') },
  });
  const server = buildServer(createBacklot(config));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'smoke', version: '0.0.1' });
  await client.connect(clientTransport);

  console.log('1/6 status…');
  const status = parse(await client.callTool({ name: 'backlot_status', arguments: {} }));
  console.log(`    ffmpeg: ${status.ffmpeg}`);
  console.log(`    providers: ${status.providers.map((p: any) => `${p.name}${p.configured ? '✓' : '✗'}`).join(' ')}`);

  console.log('2/6 generate background (mock unless keys are set)…');
  const gen = parse(
    await client.callTool({
      name: 'generate_image',
      arguments: { prompt: 'moody film-set backlot at golden hour, cinematic', aspect: 'portrait', provider: 'mock' },
    }),
  );
  const bg = gen.assets[0];

  console.log('3/6 render a 3-slide carousel…');
  const carousel = parse(
    await client.callTool({
      name: 'render_carousel',
      arguments: {
        spec: {
          slides: [
            { kicker: 'Backlot', headline: 'YOUR AGENT CAN RENDER VIDEO NOW', body: 'MCP tools for generate, edit, and publish.' },
            { headline: 'Deterministic by design', body: 'Same plan in, same pixels out. The model plans; code renders.' },
            { kicker: 'Slide 3', headline: 'BYO API keys', body: 'Your OpenAI or Gemini keys. No credits. No markup.', backgroundAsset: bg.id },
          ],
        },
      },
    }),
  );
  carousel.slides.forEach((s: any) => console.log(`    ${s.path}`));

  console.log('4/6 render a teaser video (title, captions, music-free draft)…');
  const video = parse(
    await client.callTool({
      name: 'render_video',
      arguments: {
        plan: {
          clips: [
            { kind: 'color', color: '#101014', durationSec: 2 },
            { kind: 'image', asset: bg.id, durationSec: 3 },
          ],
          overlays: [{ text: 'BACKLOT', preset: 'title' }],
          captions: [
            { text: 'the content studio for coding agents', startSec: 0.4, endSec: 2.0 },
            { text: 'rendered by code, not vibes', startSec: 2.2, endSec: 4.6 },
          ],
          aspect: '9:16',
          quality: 'standard',
        },
      },
    }),
  );
  console.log(`    ${video.asset.path} (${video.durationSec}s ${video.width}x${video.height})`);

  console.log('5/6 extract a QA frame…');
  const frame = parse(
    await client.callTool({ name: 'extract_frame', arguments: { asset: video.asset.id, atSec: 1.0 } }),
  );
  console.log(`    ${frame.frame.path}`);

  console.log('6/6 draft + publish (export bundle; live platforms only when configured)…');
  const draft = parse(
    await client.callTool({
      name: 'create_post_draft',
      arguments: {
        text: 'Backlot exists: MCP tools that let Claude Code generate, render, and publish content. BYO keys. https://github.com/lukefairbanks/backlot',
        media: [carousel.slides[0].id],
        platforms: ['export'],
      },
    }),
  );
  const published = parse(
    await client.callTool({ name: 'publish_post', arguments: { draftId: draft.draft.id, confirm: true } }),
  );
  console.log(`    export bundle: ${published.results.export.url}`);

  console.log('\nSMOKE OK');
  console.log(
    JSON.stringify(
      {
        video: video.asset.path,
        frame: frame.frame.path,
        slides: carousel.slides.map((s: any) => s.path),
        exportBundle: published.results.export.url,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error('SMOKE FAILED:', error);
  process.exit(1);
});
