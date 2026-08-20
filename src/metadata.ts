import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import { api } from './actual-api.js';

const REVIEW_BLOCK_START = '<!-- fiscal:schedule-review';
const REVIEW_BLOCK_END = '-->';
const REVIEW_BLOCK_PATTERN =
  /(?:\r?\n)?<!-- fiscal:schedule-review\r?\n([\s\S]*?)\r?\n-->/g;

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

function parseScheduleReviewBlock(note: string): ScheduleReview | undefined {
  const raw = [...note.matchAll(REVIEW_BLOCK_PATTERN)].at(-1)?.[1];
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = ScheduleReviewSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function withScheduleReviewBlock(note: string, review: ScheduleReview): string {
  const humanNote = note.replace(REVIEW_BLOCK_PATTERN, '').trimEnd();
  const block = `${REVIEW_BLOCK_START}\n${JSON.stringify(review)}\n${REVIEW_BLOCK_END}`;
  return humanNote ? `${humanNote}\n\n${block}` : block;
}

/**
 * Read review metadata. Synced schedule notes are the source of truth; legacy
 * fiscal.json sidecar entries are a read-only fallback for schedules whose
 * reviews have not been re-recorded since the notes-based storage was
 * introduced. This function never writes: neither the notes (a listing
 * command must not mutate the budget) nor the sidecar (pruning it would
 * discard review history for schedules no longer listed, e.g. deleted ones).
 */
export async function readScheduleReviews(
  dataDir: string,
  budgetId: string,
  scheduleIds: string[],
): Promise<Record<string, ScheduleReview>> {
  const cached = readMetadata(dataDir, budgetId);
  const reviews: Record<string, ScheduleReview> = {};

  await Promise.all(
    scheduleIds.map(async scheduleId => {
      const entity = await api.getNote(scheduleId);
      const fromBudget = parseScheduleReviewBlock(entity?.note ?? '');
      const review = fromBudget ?? cached.scheduleReviews[scheduleId];
      if (review) {
        reviews[scheduleId] = review;
      }
    }),
  );

  return reviews;
}

export async function writeScheduleReview(
  dataDir: string,
  budgetId: string,
  scheduleId: string,
  review: ScheduleReview,
): Promise<void> {
  const entity = await api.getNote(scheduleId);
  await api.updateNote(
    scheduleId,
    withScheduleReviewBlock(entity?.note ?? '', review),
  );
  upsertScheduleReview(dataDir, budgetId, scheduleId, review);
}
