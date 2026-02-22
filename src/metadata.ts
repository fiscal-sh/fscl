import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { z } from 'zod';

const ScheduleReviewSchema = z.object({
  decision: z.enum(['keep', 'cancel', 'pause']),
  reviewedAt: z.string(),
  nextReviewAt: z.string().optional(),
  cadenceMonths: z.number().int().min(1).default(3),
  note: z.string().optional(),
});

export type ScheduleReview = z.infer<typeof ScheduleReviewSchema>;

const MetadataSchema = z.object({
  scheduleReviews: z.record(z.string(), ScheduleReviewSchema).default({}),
});

export type Metadata = z.infer<typeof MetadataSchema>;

export const ScheduleReviewInputSchema = z.object({
  decision: z.enum(['keep', 'cancel', 'pause']),
  note: z.string().optional(),
  cadenceMonths: z.number().int().min(1).optional(),
});

export type ScheduleReviewInput = z.infer<typeof ScheduleReviewInputSchema>;

export function metadataPath(dataDir: string, budgetId: string): string {
  return join(dataDir, budgetId, 'fiscal.json');
}

export function readMetadata(dataDir: string, budgetId: string): Metadata {
  const filePath = metadataPath(dataDir, budgetId);
  if (!existsSync(filePath)) {
    return { scheduleReviews: {} };
  }

  let raw: unknown;
  try {
    const text = readFileSync(filePath, 'utf8');
    raw = JSON.parse(text);
  } catch {
    return { scheduleReviews: {} };
  }

  const result = MetadataSchema.safeParse(raw);
  return result.success ? result.data : { scheduleReviews: {} };
}

export function writeMetadata(
  dataDir: string,
  budgetId: string,
  data: Metadata,
): void {
  const filePath = metadataPath(dataDir, budgetId);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

export function upsertScheduleReview(
  dataDir: string,
  budgetId: string,
  scheduleId: string,
  review: ScheduleReview,
): void {
  const data = readMetadata(dataDir, budgetId);
  data.scheduleReviews[scheduleId] = review;
  writeMetadata(dataDir, budgetId, data);
}
