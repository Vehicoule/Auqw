/**
 * Internal cancellation sentinel shared by the storage implementation
 * and the bundled drivers. Thrown through driver boundaries so the
 * storage layer can map it to a typed `cancelled` error; never
 * exported through the package index.
 */
export const CANCELLED = Symbol('storage operation cancelled');
