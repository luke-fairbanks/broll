import { z } from 'zod';

export const PlatformSchema = z.enum(['bluesky', 'x', 'linkedin', 'export']);
export type Platform = z.infer<typeof PlatformSchema>;

export const PublishResultSchema = z.object({
  ok: z.boolean(),
  url: z.string().optional(),
  remoteId: z.string().optional(),
  error: z.string().optional(),
  at: z.string(),
});
export type PublishResult = z.infer<typeof PublishResultSchema>;

export const DraftStatusSchema = z.enum(['draft', 'published', 'partial', 'failed']);

export const PostDraftSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  text: z.string(),
  /** Asset ids or absolute paths. */
  media: z.array(z.string()).default([]),
  platforms: z.array(PlatformSchema).min(1),
  status: DraftStatusSchema.default('draft'),
  results: z.record(z.string(), PublishResultSchema).default({}),
});
export type PostDraft = z.infer<typeof PostDraftSchema>;

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
  publish(draft: PostDraft, media: ResolvedMedia[]): Promise<{ url?: string; remoteId?: string }>;
}
