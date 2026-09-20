/** Minimal local declaration for the built-in node:sqlite surface used here. */
declare module 'node:sqlite' {
  export type SqliteBindValue = string | number | bigint | null | Uint8Array;

  export interface StatementResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }

  export class StatementSync {
    run(...params: SqliteBindValue[]): StatementResult;
    all(...params: SqliteBindValue[]): Record<string, unknown>[];
  }

  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
