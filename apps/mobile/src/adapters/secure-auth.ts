import { deleteItemAsync, getItemAsync, setItemAsync } from 'expo-secure-store';
import type { AuthCustody, AuthCustodyRecord } from '@auqw/application';
import {
  appError,
  err,
  isAuthCustodyRecord,
  ok,
} from '@auqw/application';
import { nativeError } from './auqw-expo-surface.ts';

/**
 * AuthCustody over expo-secure-store (Android Keystore / iOS Keychain)
 * — mirrors `secure-sync-keys.ts`. The OAuth refresh grant is the ONLY
 * auth credential that persists: one sealed JSON record under
 * `auqw.auth.session` holds it beside the client_id override. Access
 * tokens never touch this store (they live in memory + the host slot),
 * and nothing falls back to AsyncStorage — a dead backend fails typed.
 */

const STORE_KEY = 'auqw.auth.session';

export function createSecureAuthCustody(): AuthCustody {
  return {
    async read() {
      let raw: string | null;
      try {
        raw = await getItemAsync(STORE_KEY);
      } catch (thrown) {
        return err(nativeError(thrown));
      }
      if (raw === null) {
        return ok(null);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return err(
          appError('invalid-response', 'auth: corrupt custody record'),
        );
      }
      if (!isAuthCustodyRecord(parsed)) {
        return err(
          appError('invalid-response', 'auth: corrupt custody record'),
        );
      }
      return ok(parsed);
    },

    async write(record) {
      try {
        await setItemAsync(STORE_KEY, JSON.stringify(record));
        return ok(undefined);
      } catch (thrown) {
        return err(nativeError(thrown));
      }
    },

    async clear() {
      try {
        await deleteItemAsync(STORE_KEY);
        return ok(undefined);
      } catch (thrown) {
        return err(nativeError(thrown));
      }
    },
  };
}
