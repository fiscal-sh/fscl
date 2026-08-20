import {
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { api } from './actual-api.js';

const SNAPSHOT_LIMIT = 10;

export function snapshotsDir(dataDir: string, budgetId: string): string {
  return join(dataDir, budgetId, 'snapshots');
}

function snapshotTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function rotateSnapshots(directory: string): void {
  const snapshots = readdirSync(directory)
    .filter(name => name.endsWith('.zip'))
    .map(name => {
      const path = join(directory, name);
      return { path, modified: statSync(path).mtimeMs };
    })
    .sort((left, right) => right.modified - left.modified);

  for (const snapshot of snapshots.slice(SNAPSHOT_LIMIT)) {
    unlinkSync(snapshot.path);
  }
}

/** Create a full Actual export before a bulk mutation and retain the newest ten. */
export async function createMutationSnapshot(
  dataDir: string,
  budgetId: string,
  action: string,
): Promise<string> {
  const directory = snapshotsDir(dataDir, budgetId);
  mkdirSync(directory, { recursive: true });
  const safeAction = action.replace(/[^a-z0-9-]+/gi, '-').replace(/^-|-$/g, '');
  const path = join(directory, `${snapshotTimestamp()}-${safeAction}.zip`);
  const data = await api.exportBudget();
  writeFileSync(path, data);
  rotateSnapshots(directory);
  return path;
}
