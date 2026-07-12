import { z } from 'zod';

export const PlatformSchema = z.enum(['bluesky', 'x', 'mastodon', 'linkedin', 'export']);
export type Platform = z.infer<typeof PlatformSchema>;

export const PublishResultSchema = z.object({
  ok: z.boolean(),
  url: z.string().optional(),
  remoteId: z.string().optional(),
  error: z.string().optional(),
  at: z.string(),
  /** For threads: how many segments actually went out. */
  postedSegments: z.number().int().optional(),
});
export type PublishResult = z.infer<typeof PublishResultSchema>;

export const DraftStatusSchema = z.enum(['draft', 'published', 'partial', 'failed']);

/** One post. A draft with multiple segments publishes as a reply-chained thread. */
export const PostSegmentSchema = z.object({
  text: z.string().min(1),
  /** Asset ids or absolute paths. */
  media: z.array(z.string()).default([]),
});
export type PostSegment = z.infer<typeof PostSegmentSchema>;

export const PostDraftSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  posts: z.array(PostSegmentSchema).min(1),
  platforms: z.array(PlatformSchema).min(1),
  status: DraftStatusSchema.default('draft'),
  results: z.record(z.string(), PublishResultSchema).default({}),
});
export type PostDraft = z.infer<typeof PostDraftSchema>;

/**
 * Drafts written before threads existed have top-level text/media.
 * Lift them into the single-segment shape so old outboxes keep working.
 */
export function liftLegacyDraft(raw: unknown): unknown {
  if (raw && typeof raw === 'object' && 'text' in raw && !('posts' in raw)) {
    const { text, media, ...rest } = raw as { text: string; media?: string[] } & Record<string, unknown>;
    return { ...rest, posts: [{ text, media: media ?? [] }] };
  }
  return raw;
}

export interface ResolvedMedia {
  path: string;
  kind: 'image' | 'video' | 'audio' | 'other';
  sizeBytes: number;
}

export interface PlatformAdapter {
  readonly platform: Platform;
  /** What the user must set up, shown when publishing isn't possible. */
  readonly configHelp: string;
  isConfigured(): boolean;
  /** mediaPerSegment[i] holds the resolved media for draft.posts[i]. */
  publish(
    draft: PostDraft,
    mediaPerSegment: ResolvedMedia[][],
  ): Promise<{ url?: string; remoteId?: string; postedSegments?: number }>;
}
