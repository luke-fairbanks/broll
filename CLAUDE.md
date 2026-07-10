# Backlot — architecture rules

Backlot is an MCP server that gives coding agents content-production hands: BYO-key generation, deterministic rendering, draft-first publishing. These rules are binding for all changes.

## Non-negotiables

1. **The model plans; code renders.** Anything that must look consistent (layout, fonts, spacing, captions, branding) lives in TypeScript, never in a prompt. If AI output drifts, the fix is moving that part into code.
2. **Determinism.** `compilePlan` and `slideOverlaySvg` are pure functions: same inputs → same ffmpeg args / same SVG. No `Date.now()`, no randomness in render paths. IDs come from the injectable `IdGenerator`.
3. **Draft-first publishing.** No code path may post to a network without (a) a draft file existing in the outbox and (b) `confirm: true` from the caller. Never weaken this.
4. **BYO keys only.** Keys are read from env, sent only to their vendor's API, never logged, never proxied.
5. **Errors must be actionable.** Every thrown error tells the agent what to do next (which tool to call, which env var to set). ffmpeg failures include the stderr tail.

## Layout

- `src/config.ts` — env + `backlot.config.json` (brand kit). zod-validated.
- `src/workspace.ts` — on-disk state: assets/renders/drafts/tmp + manifest. All tool outputs are inspectable files.
- `src/render/` — the crown jewel. `plan.ts` compiles declarative RenderPlans to ffmpeg args (pure); `renderer.ts` is the only orchestrator; `ffmpeg.ts` is the only place a process spawns; `carousel.ts` composes slides via sharp+SVG.
- `src/providers/` — Strategy pattern. `registry.ts` picks explicit → config default → first configured → mock. The mock provider must always keep every workflow runnable keyless.
- `src/social/` — Adapter pattern per platform + `constraints.ts` (validate before publish) + `drafts.ts` (outbox) + `publisher.ts` (per-platform results, never all-or-nothing).
- `src/server.ts` — thin MCP tool wrappers only; logic lives in services. `src/backlot.ts` is the composition root.

## Conventions

- ESM, strict TS, zod 4 (`.prefault({})` for object defaults, not `.default({})`).
- Filtergraph-referenced paths (fonts, textfiles) must pass `isFilterSafePath` — workspace paths are id-named for this reason. Never interpolate user text into a filtergraph; write textfiles.
- Tests: pure functions get exact-value assertions (ffmpeg args, signatures, byte offsets); ffmpeg integration tests synthesize fixtures with lavfi (no binaries in git); network adapters are tested with injected `fetch` mocks; the MCP surface is tested through a real client over `InMemoryTransport`.
- `npm test && npm run typecheck` must pass before any commit. Run `npm run smoke` after render-engine changes and eyeball the frame it extracts.

## Known sharp edges

- OAuth 1.0a signing for X is verified against the documented test vector in `test/x.test.ts` — do not "simplify" percent-encoding or param sorting.
- Bluesky facets use UTF-8 **byte** offsets; images over 1MB are recompressed (`fitImageToLimit`).
- npm sometimes drops rolldown/sharp native bindings (npm/cli#4828): fix is `rm -rf node_modules package-lock.json && npm install`.
