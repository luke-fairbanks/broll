#!/usr/bin/env node
/**
 * daily-draft.mjs — the ONLY command the daily build-log automation is
 * permission-allowlisted to execute. Deliberately draft-only: this file
 * imports no publishing capability, so an unattended session cannot
 * post to any network through it, no matter what arguments it passes.
 *
 * Usage:
 *   node scripts/daily-draft.mjs --text "post text" \
 *     [--kicker "broll"] [--headline "SHIPPED X"] [--body "detail line"]
 *
 * With --headline, renders one 4:5 slide and attaches it to the draft.
 * Prints JSON: { draftId, violations, slide? } — a human publishes later.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!existsSync(path.join(repo, 'dist', 'index.js'))) {
  console.error('dist/ missing — run: npm --prefix ' + repo + ' run build');
  process.exit(1);
}

const { loadConfig } = await import(path.join(repo, 'dist', 'config.js'));
const { Workspace } = await import(path.join(repo, 'dist', 'workspace.js'));
const { CarouselRenderer } = await import(path.join(repo, 'dist', 'render', 'carousel.js'));
const { DraftStore } = await import(path.join(repo, 'dist', 'social', 'drafts.js'));
const { validateForPlatform } = await import(path.join(repo, 'dist', 'social', 'constraints.js'));
// NOTE: publisher.js is intentionally never imported here.

const { values } = parseArgs({
  options: {
    text: { type: 'string' },
    kicker: { type: 'string', default: 'broll' },
    headline: { type: 'string' },
    body: { type: 'string' },
    platforms: { type: 'string', default: 'bluesky' },
  },
});

if (!values.text) {
  console.error('required: --text "the post text"');
  process.exit(1);
}

const config = loadConfig();
const workspace = new Workspace(config.workspaceDir);
const media = [];
let slide;

if (values.headline) {
  const carousel = new CarouselRenderer(workspace, config.brand);
  const result = await carousel.render({
    slides: [{ kicker: values.kicker, headline: values.headline, body: values.body }],
    size: '4:5',
    format: 'png',
    pageNumbers: false,
    watermark: true,
  });
  slide = result.slides[0];
  media.push(slide.id);
}

const platforms = values.platforms.split(',').map((p) => p.trim());
const drafts = new DraftStore(workspace);
const draft = drafts.create({ posts: [{ text: values.text, media }], platforms });

const mediaInfo = media.map((id) => {
  const asset = workspace.getAsset(id);
  return { path: asset.path, kind: asset.kind, sizeBytes: 0 };
});
const violations = platforms.flatMap((p) => validateForPlatform(p, values.text, mediaInfo));

console.log(
  JSON.stringify(
    {
      draftId: draft.id,
      violations,
      slide: slide ? { id: slide.id, path: slide.path } : undefined,
      note: 'Draft only. A human publishes via: publish draft ' + draft.id,
    },
    null,
    2,
  ),
);
