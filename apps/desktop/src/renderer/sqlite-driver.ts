import type { CancellationSignal } from '@auqw/application';
import type {
  SqliteConnection,
  SqliteDriver,
  SqlParams,
  SqlRow,
} from '@auqw/storage-sqlite';
// The cancellation sentinel is package-internal: SqliteStorage's
// #mapError classifies thrown === CANCELLED as a typed `cancelled`.
import { CANCELLED } from '../../../../packages/storage-sqlite/src/cancelled.ts';
import type { AuqwStorage } from '../shared/contract.ts';

/**
 * `SqliteDriver` over the `storage:*` IPC surface. The database lives
 * in the utility process, so the transaction callback's statements
 * become txId-pinned requests there — one `storage:execute`/`query`
 * per statement, `commit`/`rollback` closing the span.
 *
 * Cancellation is local observation plus a `storage:cancel` flag: the
 * signal is polled before every statement (it cannot cross IPC) and
 * subscribed while the tx is open, so a flip while `work` awaits
 * unrelated promises still poisons the tx — the next pinned statement
 * answers `cancelled`.
 */
export function createSqliteDriver(storage: AuqwStorage): SqliteDriver {
  return {
    backup: (tag) => storage.backup(tag),
    dropBackup: (tag) => storage.dropBackup(tag),
    async transaction<T>(
      work: (connection: SqliteConnection) => Promise<T>,
      signal?: CancellationSignal,
    ): Promise<T> {
      if (signal?.cancelled === true) {
        throw CANCELLED;
      }
      const { txId } = await storage.begin();
      let cancelSent = false;
      const flagCancelled = (): void => {
        if (!cancelSent) {
          cancelSent = true;
          // Fire-and-forget beside the CANCELLED throw; ordering is
          // preserved because the invoke dispatches synchronously.
          void storage.cancel(txId).then(
            () => undefined,
            () => undefined,
          );
        }
      };
      const check = (checkSignal: CancellationSignal | undefined): void => {
        if (checkSignal?.cancelled === true) {
          if (signal?.cancelled === true) {
            flagCancelled();
          }
          throw CANCELLED;
        }
      };
      const connection: SqliteConnection = {
        execute: (sql, params = [], statementSignal) => {
          check(statementSignal ?? signal);
          return storage.execute(txId, sql, params);
        },
        query: <R extends SqlRow>(
          sql: string,
          params: SqlParams = [],
          statementSignal?: CancellationSignal,
        ) => {
          check(statementSignal ?? signal);
          return storage
            .query(txId, sql, params)
            .then((result) => result.rows as readonly R[]);
        },
      };
      // Polls only run at statement boundaries — the subscription flags
      // the tx even when the callback is suspended between them.
      const unsubscribe = signal?.subscribe(flagCancelled);
      try {
        check(signal);
        const value = await work(connection);
        check(signal);
        await storage.commit(txId);
        return value;
      } catch (thrown) {
        try {
          await storage.rollback(txId);
        } catch {
          // The transaction already ended.
        }
        throw thrown;
      } finally {
        unsubscribe?.();
      }
    },
  };
}
