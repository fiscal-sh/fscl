import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type SyncState = {
  lastSyncAt?: string;
  /** Set when local changes were saved but the post-write sync failed. */
  pendingSince?: string;
  pendingError?: string;
};

export function syncStatePath(dataDir: string, budgetId: string): string {
  return join(dataDir, budgetId, 'sync-state.json');
}

export function readSyncState(dataDir: string, budgetId: string): SyncState {
  const filePath = syncStatePath(dataDir, budgetId);
  if (!existsSync(filePath)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as SyncState;
  } catch {
    return {};
  }
}

export function writeSyncState(
  dataDir: string,
  budgetId: string,
  state: SyncState,
): void {
  const filePath = syncStatePath(dataDir, budgetId);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

export function recordSyncSuccess(dataDir: string, budgetId: string): void {
  writeSyncState(dataDir, budgetId, { lastSyncAt: new Date().toISOString() });
}

export function recordSyncFailure(
  dataDir: string,
  budgetId: string,
  error: string,
): void {
  const state = readSyncState(dataDir, budgetId);
  writeSyncState(dataDir, budgetId, {
    ...state,
    pendingSince: state.pendingSince ?? new Date().toISOString(),
    pendingError: error,
  });
}

export function isSyncStale(
  state: SyncState,
  maxAgeMs: number,
  now: Date = new Date(),
): boolean {
  if (state.pendingSince) {
    return true;
  }
  if (!state.lastSyncAt) {
    return true;
  }
  const last = Date.parse(state.lastSyncAt);
  if (!Number.isFinite(last)) {
    return true;
  }
  return now.getTime() - last > maxAgeMs;
}
