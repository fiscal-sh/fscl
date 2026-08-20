import { describe, expect, it } from 'vitest';

import { CliError, ErrorCodes } from './cli.js';
import { isSyncStale } from './sync-state.js';
import {
  compareVersions,
  getBundledApiVersion,
  getFsclVersion,
  normalizeVersionMismatchError,
} from './versions.js';

describe('version reporting', () => {
  it('reads real versions from package metadata', () => {
    expect(getFsclVersion()).toMatch(/^\d+\.\d+\.\d+/);
    expect(getBundledApiVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('classifies server drift without ever blocking', () => {
    expect(compareVersions('26.8.1', '26.8.1')).toEqual({
      compatibility: 'match',
    });
    expect(compareVersions('26.8.1', '26.8.0')).toEqual({
      compatibility: 'patch-drift',
    });
    expect(compareVersions('26.8.1', undefined)).toEqual({
      compatibility: 'unknown',
    });
    expect(compareVersions('26.8.1', 'weird')).toEqual({
      compatibility: 'unknown',
    });
    const drift = compareVersions('26.8.1', '26.9.0');
    expect(drift.compatibility).toBe('drift');
    expect(drift.warning).toContain('26.9.0');
    expect(drift.warning).toContain('26.8.1');
  });

  it('maps migration mismatch errors to ACTUAL_VERSION_MISMATCH', () => {
    const mapped = normalizeVersionMismatchError(
      new Error('Could not load budget: out-of-sync-migrations'),
    );
    expect(mapped).toBeInstanceOf(CliError);
    expect((mapped as CliError).code).toBe(ErrorCodes.ACTUAL_VERSION_MISMATCH);
    expect((mapped as CliError).message).toContain('Update fscl');

    const phrased = normalizeVersionMismatchError(
      new Error('This budget cannot be loaded with this version of the app.'),
    );
    expect((phrased as CliError).code).toBe(ErrorCodes.ACTUAL_VERSION_MISMATCH);
  });

  it('passes unrelated errors through unchanged', () => {
    const error = new Error('network timeout');
    expect(normalizeVersionMismatchError(error)).toBe(error);
  });
});

describe('sync staleness', () => {
  const now = new Date('2026-08-20T12:00:00Z');

  it('is stale when never synced or past the window', () => {
    expect(isSyncStale({}, 300_000, now)).toBe(true);
    expect(
      isSyncStale({ lastSyncAt: '2026-08-20T11:00:00Z' }, 300_000, now),
    ).toBe(true);
    expect(isSyncStale({ lastSyncAt: 'garbage' }, 300_000, now)).toBe(true);
  });

  it('is fresh within the window', () => {
    expect(
      isSyncStale({ lastSyncAt: '2026-08-20T11:58:00Z' }, 300_000, now),
    ).toBe(false);
  });

  it('is always stale while an upload is pending', () => {
    expect(
      isSyncStale(
        {
          lastSyncAt: '2026-08-20T11:59:00Z',
          pendingSince: '2026-08-20T11:59:30Z',
        },
        300_000,
        now,
      ),
    ).toBe(true);
  });
});
