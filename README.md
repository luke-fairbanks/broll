# broll

**The content studio MCP for coding agents.** broll gives Claude Code, Codex, and any MCP client real hands for content work: generate media with *your own* API keys, render videos and carousels deterministically with code, and publish through a draft-first outbox.

The model plans. Code renders. Nothing posts without confirmation.

## Why

Every developer running a coding agent hits the same wall: the agent can write the marketing plan, but it can't *make* the carousel, cut the video, or post it. Existing tools are credit-metered schedulers built for social media managers. broll is built for developers:

- **BYO keys, no markup.** Image/video generation uses your `OPENAI_API_KEY` / `GEMINI_API_KEY` directly. broll never proxies your inference or resells credits. A built-in mock provider keeps every workflow runnable before you add any keys.
- **Deterministic rendering.** Videos and slides are compiled from declarative plans into exact ffmpeg/sharp invocations. Same plan + same inputs = same output. When AI output drifts, the fix is code — so layout, fonts, captions, and branding live in code.
- **Draft-first publishing.** Posts are reviewable JSON files in an outbox. `publish_post` requires `confirm: true`, validates per-platform rules (char limits, media counts, file sizes) before anything leaves the machine, and reports per-platform results. The `export` platform always works: it writes a ready-to-post bundle.

## Install

Requires Node 20+ and ffmpeg (`brew install ffmpeg`).

```bash
cd broll
npm install && npm run build
```

Register with Claude Code (or use the checked-in `.mcp.json` when working inside this repo):

```bash
claude mcp add broll -- node /path/to/broll/dist/index.js
```

Optional environment:

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | gpt-image-1 image generation |
| `GEMINI_API_KEY` | Imagen images + Veo video generation |
| `BLUESKY_IDENTIFIER` / `BLUESKY_APP_PASSWORD` | live Bluesky posting (use an app password) |
| `MASTODON_ACCESS_TOKEN` (+ optional `MASTODON_INSTANCE`) | live Mastodon posting — no app review, any instance |
| `X_API_KEY` / `X_API_SECRET` / `X_ACCESS_TOKEN` / `X_ACCESS_TOKEN_SECRET` | live X posting (free API tier works) |
| `BROLL_HOME` | workspace location (default `~/.broll`) |
| `BROLL_FFMPEG` / `BROLL_FFPROBE` | explicit binary paths |

Brand kit: drop a `broll.config.json` next to where the server runs (see this repo's for an example) — name, handle, colors, font, logo. Every render picks it up automatically.

## Tools

| Tool | What it does |
| --- | --- |
| `broll_status` | Workspace, ffmpeg, provider + platform readiness. Call first. |
| `generate_image` / `generate_video` | BYO-key generation → workspace assets (mock fallback when keyless) |
| `import_asset` / `list_assets` / `probe_asset` | Bring in and inspect media |
| `render_video` | Declarative RenderPlan → mp4: clips (video/image/color), trims, cover/contain fits, burned-in titles + timed captions, music bed, 9:16 / 1:1 / 4:5 / 16:9 |
| `render_carousel` | Branded slide sets (the Instagram/LinkedIn format): kicker, headline, body, accent bar, page numbers, watermark — layout is 100% code |
| `extract_frame` | Pull a PNG frame so the agent can visually QA its own render |
| `create_post_draft` | Text + media + platforms → validated, reviewable draft in the outbox |
| `list_drafts` / `publish_post` | Inspect the outbox; publish with explicit `confirm: true` |

## Try it

```bash
npm run smoke
```

drives the real server through a real MCP client: generates a background, renders a 3-slide carousel and a 9:16 teaser video with captions, extracts a QA frame, then drafts and "publishes" an export bundle — all into `./.broll/`.

## Safety model

1. Nothing is published without a draft file on disk first.
2. `publish_post` hard-requires `confirm: true` — agents are instructed to obtain the user's explicit go-ahead.
3. Constraint violations block publishing; they never auto-truncate your text.
4. Keys are read from your environment and sent only to their own vendor's API.

## Status & roadmap

Early but real: 96 tests including real-ffmpeg integration renders and a full MCP round trip.

- [ ] Bluesky video upload
- [ ] X chunked video upload
- [ ] LinkedIn adapter (needs app review)
- [x] Mastodon adapter
- [ ] YouTube Shorts via user OAuth
- [ ] Ken Burns / crossfade transitions
- [ ] Word-level caption timing from transcripts
- [ ] `npx broll-mcp` distribution

## Development

```bash
npm test          # unit + integration (real ffmpeg)
npm run typecheck
npm run smoke     # end-to-end artifact check
```

MIT.
