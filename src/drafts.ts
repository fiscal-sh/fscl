import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { z } from 'zod';

export type DraftValidationError = {
  path: string;
  message: string;
};

export type DraftReadResult<T> =
  | { ok: true; data: T; filePath: string }
  | { ok: false; errors: DraftValidationError[]; filePath: string };

export function draftsDir(dataDir: string, budgetId: string): string {
  return join(dataDir, budgetId, 'drafts');
}

export function draftPath(
  dataDir: string,
  budgetId: string,
  filename: string,
): string {
  return join(draftsDir(dataDir, budgetId), filename);
}

export function writeDraft<T>(
  dataDir: string,
  budgetId: string,
  filename: string,
  data: T,
): string {
  const dir = draftsDir(dataDir, budgetId);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, filename);
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return filePath;
}

function formatIssuePath(path: PropertyKey[]): string {
  return path
    .map(p => (typeof p === 'number' ? `[${p}]` : `.${String(p)}`))
    .join('')
    .replace(/^\./, '');
}

export function readDraft<T>(
  dataDir: string,
  budgetId: string,
  filename: string,
  schema: z.ZodType<T>,
): DraftReadResult<T> {
  const filePath = draftPath(dataDir, budgetId, filename);
  if (!existsSync(filePath)) {
    return {
      ok: false,
      errors: [{ path: '', message: `Draft not found: ${filePath}. Run the draft command first.` }],
      filePath,
    };
  }

  let raw: unknown;
  try {
    const text = readFileSync(filePath, 'utf8');
    raw = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      errors: [{
        path: '',
        message: `Invalid JSON in draft: ${err instanceof Error ? err.message : 'parse failure'}`,
      }],
      filePath,
    };
  }

  const result = schema.safeParse(raw);
  if (result.success) {
    return { ok: true, data: result.data, filePath };
  }

  const errors: DraftValidationError[] = result.error.issues.map(issue => ({
    path: formatIssuePath(issue.path),
    message: issue.message,
  }));
  return { ok: false, errors, filePath };
}

export function deleteDraft(
  dataDir: string,
  budgetId: string,
  filename: string,
): void {
  const filePath = draftPath(dataDir, budgetId, filename);
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }
}
