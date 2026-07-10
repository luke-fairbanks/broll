# broll workflow prompts

Things to say to Claude Code once broll is connected. Start every session's first content task with `broll_status` (agents usually do this on their own).

## Daily carousel

> Look at today's top item in `content/hooks.json`, write a 5-slide myth-bust carousel about it (kicker, punchy headline, 1-2 sentence body per slide), render it with `render_carousel`, and show me slide 1. If I say ship it, draft a post for bluesky + export with a one-line caption and exactly five hashtags — then wait for my confirm before publishing.

## Changelog → teaser video

> Read the last 5 git commits. Turn them into a 12-second 9:16 teaser: dark intro card with the release name, one image clip per highlight (generate backgrounds if no keys are configured, use the mock), timed captions for each feature, title overlay "v0.2 is out". Render draft quality first, extract a frame at every caption midpoint so we can QA, then re-render at standard quality.

## Blog post → thread + images

> Take `posts/deterministic-rendering.md`, compress it into a 280-char X post and a 300-char Bluesky post (they differ — respect each limit), generate a square hero image for it, create one draft per platform plus export, and show me both texts side by side with their validation results.

## Repurpose a long video

> Import `~/Videos/demo-recording.mov`, probe it, and cut three 15-second 9:16 clips from the moments I listed in `clips.txt`, each with burned-in captions of what's being shown and our title card at the front. Extract a frame from each for review.
