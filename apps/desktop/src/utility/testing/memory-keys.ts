import type { SyncIdentity } from '@auqw/application';
import { shellError } from '../../shared/errors.ts';
import type { SyncDeviceRecord, SyncKeys } from '../sync-keys.ts';

/**
 * In-memory SyncKeys double — unit tests for the server run against it;
 * production backs it with the service client to main. Marked plainly:
 * it holds key material unencrypted and is never wired into the app.
 */
export function createMemoryKeys(): SyncKeys & {
  records: Map<string, SyncDeviceRecord>;
} {
  let identity: SyncIdentity | null = null;
  const records = new Map<string, SyncDeviceRecord>();
  return {
    records,
    async identityGet() {
      return identity;
    },
    async identitySet(next) {
      // Faithful to custody: create-once — a second install is an
      // invalid-request, never a silent swap.
      if (identity !== null) {
        throw shellError(
          'invalid-request',
          'sync identity already installed',
        );
      }
      identity = next;
    },
    async identityReplace(next) {
      identity = next;
    },
    async deviceList() {
      return { devices: [...records.values()], skipped: 0 };
    },
    async devicePut(record) {
      // Mirror custody: a re-pair of the same key under a new id
      // evicts the stale record — the fake keeps real semantics.
      for (const [id, existing] of records) {
        if (existing.fp === record.fp && id !== record.id) {
          records.delete(id);
        }
      }
      records.set(record.id, record);
    },
    async deviceTouch(record) {
      const existing = records.get(record.id);
      if (existing === undefined || existing.fp !== record.fp) {
        return false;
      }
      records.set(record.id, record);
      return true;
    },
    async deviceDelete(id) {
      records.delete(id);
    },
  };
}
