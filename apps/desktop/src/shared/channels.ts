/** Every renderer↔main channel name, in one map. */

export const CHANNELS = {
  appMeta: 'app:meta',
  dialogPickFolder: 'dialog:pickFolder',
  dialogPickFiles: 'dialog:pickFiles',
  netSnapshot: 'net:snapshot',
  netEvents: 'net:events',
  netSubscribe: 'net:subscribe',
  netUnsubscribe: 'net:unsubscribe',
  secureGet: 'secure:get',
  secureSet: 'secure:set',
  secureDelete: 'secure:delete',
  storageBegin: 'storage:begin',
  storageCommit: 'storage:commit',
  storageRollback: 'storage:rollback',
  storageCancel: 'storage:cancel',
  storageExecute: 'storage:execute',
  storageQuery: 'storage:query',
  storageBackup: 'storage:backup',
  storageDropBackup: 'storage:dropBackup',
  utilityPing: 'utility:ping',
} as const;

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];
