/** Every renderer↔main channel name, in one map. */

export const CHANNELS = {
  appMeta: 'app:meta',
  dialogPickFolder: 'dialog:pickFolder',
  dialogPickFiles: 'dialog:pickFiles',
  netSnapshot: 'net:snapshot',
  netEvents: 'net:events',
  netSubscribe: 'net:subscribe',
  netUnsubscribe: 'net:unsubscribe',
  /** Main→renderer push of the OS theme source for the `adaptive`
      setting; subscribe/unsubscribe gate the platform watchers. */
  themeEvents: 'theme:events',
  themeSubscribe: 'theme:subscribe',
  themeUnsubscribe: 'theme:unsubscribe',
  secureGet: 'secure:get',
  secureSet: 'secure:set',
  secureDelete: 'secure:delete',
  storageBegin: 'storage:begin',
  storageCommit: 'storage:commit',
  storageRollback: 'storage:rollback',
  storageCancel: 'storage:cancel',
  storageExecute: 'storage:execute',
  storageExecMany: 'storage:execMany',
  storageQuery: 'storage:query',
  storageBackup: 'storage:backup',
  storageDropBackup: 'storage:dropBackup',
  utilityPing: 'utility:ping',
  hostPlugins: 'host:plugins',
  hostRequest: 'host:request',
  hostCancel: 'host:cancel',
  streamPrepare: 'stream:prepare',
  streamDevPrepare: 'stream:dev-prepare',
  streamServeUrl: 'stream:serve-url',
  streamOpen: 'stream:open',
  streamRead: 'stream:read',
  streamClose: 'stream:close',
  streamRelease: 'stream:release',
  streamMarks: 'stream:marks',
  streamCancel: 'stream:cancel',
  streamPort: 'stream:port',
  /** Main→renderer port delivery — carries the pump's MessagePort. */
  streamBytes: 'stream-bytes',
  syncStatus: 'sync:status',
  syncPairing: 'sync:pairing',
  syncDevices: 'sync:devices',
  syncUnpair: 'sync:unpair',
  syncDeltas: 'sync:deltas',
  syncImportDelta: 'sync:importDelta',
  syncTrigger: 'sync:trigger',
  syncLocalChanges: 'sync:localChanges',
  syncDrainApplied: 'sync:drainApplied',
  syncAckApplied: 'sync:ackApplied',
  syncMaterialized: 'sync:materialized',
  /** Pair TO a phone-hosted offer (desktop as caller). */
  syncDial: 'sync:dial',
  syncDialPayload: 'sync:dialPayload',
  /** Start/stop the `_auqw._tcp` browse for nearby pair hosts. */
  syncNearbyStart: 'sync:nearbyStart',
  syncNearbyStop: 'sync:nearbyStop',
  /** Main→renderer push: a nearby pair host appeared/disappeared. */
  syncNearby: 'sync:nearby',
  syncNearbySubscribe: 'sync:nearbySubscribe',
  syncNearbyUnsubscribe: 'sync:nearbyUnsubscribe',
  /** Main→renderer push: applied sync outcomes are queued for drain. */
  syncApplied: 'sync:applied',
  syncAppliedSubscribe: 'sync:appliedSubscribe',
  syncAppliedUnsubscribe: 'sync:appliedUnsubscribe',
  transferEnsureDir: 'transfer:ensureDir',
  transferBegin: 'transfer:begin',
  transferWrite: 'transfer:write',
  transferCommit: 'transfer:commit',
  transferFinalize: 'transfer:finalize',
  transferAbort: 'transfer:abort',
  transferStat: 'transfer:stat',
  transferRemove: 'transfer:remove',
  transferSweepPartials: 'transfer:sweepPartials',
  transferList: 'transfer:list',
  transferStatus: 'transfer:status',
  transferStats: 'transfer:stats',
  tagreadEnumerate: 'tagread:enumerate',
  tagreadFingerprint: 'tagread:fingerprint',
  tagreadRead: 'tagread:read',
  /** Renderer→main fire-and-forget: resolved ui-web scheme for the
      titlebar overlay. */
  chromeScheme: 'chrome:scheme',
  localAdd: 'local:add',
  localProbe: 'local:probe',
  localResolve: 'local:resolve',
  localRead: 'local:read',
  localList: 'local:list',
  localPlayback: 'local:playback',
  localSweep: 'local:sweep',
  /**
   * OAuth session trust — snapshot pull, flow verbs, the client-id
   * override, and the allowlisted verification-URL open. Token
   * material never crosses these channels.
   */
  authStatus: 'auth:status',
  authBegin: 'auth:begin',
  authCancel: 'auth:cancel',
  authSignOut: 'auth:signOut',
  authSetClient: 'auth:setClient',
  authRetry: 'auth:retry',
  authOpenUrl: 'auth:openUrl',
  /** Main→renderer push of each new auth snapshot. */
  authState: 'auth:state',
  authSubscribe: 'auth:subscribe',
  authUnsubscribe: 'auth:unsubscribe',
  /**
   * Release update check — the egress lives in main (the renderer
   * CSP admits only 'self'), so the renderer sees validated
   * snapshots plus the check/open verbs. The open verb carries no
   * URL: main opens the release URL its own snapshot recorded.
   */
  updateStatus: 'update:status',
  updateCheck: 'update:check',
  updateOpen: 'update:open',
  /** Main→renderer push of each new update snapshot. */
  updateState: 'update:state',
  updateSubscribe: 'update:subscribe',
  updateUnsubscribe: 'update:unsubscribe',
} as const;
