/**
 * Persistence for the search screen's recents rail — the list of
 * submitted queries. Device-local by contract: recents belong to
 * the device the search ran on, so the store is not a
 * `PersistedState` section and export/import and sync never carry
 * it (the same class of data as `peaks_cache`). A platform without
 * a store keeps recents memory-only.
 */
export interface SearchHistoryStore {
  /**
   * The persisted list, newest first — empty when nothing was ever
   * recorded or the store itself failed; recents are a convenience,
   * never the only record of what the user searched.
   */
  load(): Promise<readonly string[]>;
  /**
   * Commit one submitted query. Implementations dedupe by exact
   * text (a re-search floats to the top), keep the list bounded at
   * `SEARCH_HISTORY_LIMIT`, and no-op on a blank query.
   */
  record(query: string): Promise<void>;
}

/**
 * The recents rail's depth — the bound a `SearchHistoryStore.record`
 * enforces and the shell's in-memory list mirrors.
 */
export const SEARCH_HISTORY_LIMIT = 8;
