import { Directory, File, FileMode, Paths } from 'expo-file-system';
import { appError, createSha256, err, ok } from '@auqw/application';
import type {
  AppError,
  CancellationSignal,
  MediaTransferPort,
  Result,
  TransferSink,
} from '@auqw/application';

/**
 * expo-file-system backing for MediaTransferPort. Owned downloads
 * live under `<Paths.document>/downloads` — document dir, not cache,
 * so the OS never reclaims them under pressure (a reaped owned
 * download is indistinguishable from deletion).
 *
 * The `.part` contract: `begin` opens `<destPath>.part` (a bare file
 * name — the port owns the directory); `write` appends via one held
 * FileHandle; `commit` reports the durable offset (expo writes land
 * on writeBytes — there is no fsync primitive to defer them to);
 * `finalize` verifies the caller's sha-256 by hashing the finished
 * file back, then renames atomically; `abort(keep)` keeps or drops
 * the partial. `usage`/`freeBytes`/`sweepPartials`/`stat`/`removeFile`
 * cover the settings and startup-integrity surfaces.
 */

export type ExpoTransferDeps = {
  /** Injectable for tests; defaults to `<Paths.document>/downloads`. */
  readonly directory?: Directory;
};

function asTransferError(thrown: unknown): AppError {
  const message = thrown instanceof Error ? thrown.message : 'fs error';
  // ENOSPC surfaces as a message string on Android — typed so the
  // manager can mark the download storage-full instead of transient.
  if (/enospc|no space|insufficient/i.test(message)) {
    return appError('storage-full', 'out of storage');
  }
  return appError('internal', `transfer fs error: ${message}`);
}

function cancelled(): Result<never> {
  return err(appError('cancelled', 'cancelled'));
}

class ExpoTransferSink implements TransferSink {
  readonly #part: File;
  readonly #dest: File;
  #handle: ReturnType<File['open']> | null = null;
  #closed = false;

  constructor(part: File, dest: File) {
    this.#part = part;
    this.#dest = dest;
  }

  get handle(): ReturnType<File['open']> {
    // Lazily opened on first write so `begin` on a resumed .part
    // validates the offset before mutating anything.
    this.#handle ??= this.#part.open(FileMode.Append);
    return this.#handle;
  }

  #closeHandle(): void {
    try {
      this.#handle?.close();
    } catch {
      // A failed close still leaves the handle unusable — treat as closed.
    } finally {
      this.#handle = null;
    }
  }

  async write(bytes: Uint8Array): Promise<Result<void>> {
    if (this.#closed) {
      return err(appError('invalid-response', 'sink is closed'));
    }
    try {
      this.handle.writeBytes(bytes);
      return ok(undefined);
    } catch (thrown) {
      return err(asTransferError(thrown));
    }
  }

  async commit(): Promise<Result<number>> {
    if (this.#closed) {
      return err(appError('invalid-response', 'sink is closed'));
    }
    try {
      // writeBytes lands synchronously; size is the durable offset.
      const size = this.#handle?.size ?? this.#part.info().size ?? 0;
      return ok(size);
    } catch (thrown) {
      return err(asTransferError(thrown));
    }
  }

  /**
   * sha-256 over the .part — the finalize cross-check digest. Streamed
   * in bounded chunks: buffering a whole download in one JS allocation
   * can OOM the app mid-finalize on a memory-constrained phone.
   */
  #digestFile(): string {
    const CHUNK = 1024 * 1024;
    const hasher = createSha256();
    const handle = this.#part.open(FileMode.ReadOnly);
    try {
      for (;;) {
        const chunk = handle.readBytes(CHUNK);
        if (chunk.length === 0) {
          break;
        }
        hasher.update(chunk);
      }
    } finally {
      try {
        handle.close();
      } catch {
        // Best-effort — a failed close changes nothing about the digest.
      }
    }
    return hasher.digest();
  }

  async finalize(expected: string | null): Promise<Result<string>> {
    if (this.#closed) {
      return err(appError('invalid-response', 'sink is closed'));
    }
    this.#closed = true;
    try {
      this.#closeHandle();
      const digest = this.#digestFile();
      if (expected !== null && digest !== expected) {
        // Corrupt bytes can't be resumed — drop the partial.
        this.#part.delete();
        return err(
          appError('invalid-response', 'download checksum mismatch'),
        );
      }
      // Atomic replace: overwrite:true moves over an existing dest —
      // deleting it first would lose a valid download if the move fails.
      this.#part.moveSync(this.#dest, { overwrite: true });
      return ok(digest);
    } catch (thrown) {
      return err(asTransferError(thrown));
    }
  }

  async abort(keep: boolean): Promise<Result<void>> {
    this.#closed = true;
    try {
      this.#closeHandle();
      if (!keep && this.#part.exists) {
        this.#part.delete();
      }
      return ok(undefined);
    } catch (thrown) {
      return err(asTransferError(thrown));
    }
  }
}

export function createExpoTransfer(
  deps: ExpoTransferDeps = {},
): {
  transfer: MediaTransferPort;
  dir: string;
  uriFor: (name: string) => string;
} {
  const directory =
    deps.directory ?? new Directory(Paths.document, 'downloads');
  const PART_SUFFIX = '.part';

  const partFor = (name: string): File =>
    new File(directory, `${name}${PART_SUFFIX}`);
  const fileFor = (name: string): File => new File(directory, name);

  const transfer: MediaTransferPort = {
    async ensureDir(signal) {
      if (signal.cancelled) {
        return cancelled();
      }
      try {
        if (!directory.exists) {
          directory.create({ intermediates: true, idempotent: true });
        }
        return ok(undefined);
      } catch (thrown) {
        return err(asTransferError(thrown));
      }
    },

    async begin(input, signal) {
      if (signal.cancelled) {
        return cancelled();
      }
      try {
        // The contract is a bare file name — a path separator would
        // escape the managed directory.
        if (
          input.destPath.includes('/') ||
          input.destPath.includes('\\') ||
          input.destPath.length === 0 ||
          // `.part` is the staging suffix — a finalized name carrying
          // it is indistinguishable from a stale partial to the sweeper.
          input.destPath.endsWith(PART_SUFFIX)
        ) {
          return err(
            appError('invalid-response', 'destPath must be a bare name'),
          );
        }
        const part = partFor(input.destPath);
        if (input.resumeAtBytes > 0) {
          // Resume: the .part must already hold exactly the committed
          // prefix — any other size means the ledger lied.
          const size = part.exists ? (part.info().size ?? null) : null;
          if (size === null || size !== input.resumeAtBytes) {
            return err(
              appError(
                'invalid-response',
                `resume offset ${input.resumeAtBytes} != .part size ${size ?? 'missing'}`,
              ),
            );
          }
        } else if (part.exists) {
          part.delete();
        }
        if (!part.exists) {
          part.create({ intermediates: true });
        }
        const sink = new ExpoTransferSink(part, fileFor(input.destPath));
        return ok(sink);
      } catch (thrown) {
        return err(asTransferError(thrown));
      }
    },

    async sweepPartials(keepPaths, signal) {
      if (signal.cancelled) {
        return cancelled();
      }
      try {
        // A clean install has no transfer directory yet — that's
        // honestly "nothing to sweep", not an error.
        if (!directory.exists) {
          return ok(0);
        }
        const keep = new Set(keepPaths);
        let swept = 0;
        for (const entry of directory.list()) {
          if (signal.cancelled) {
            return cancelled();
          }
          if (!(entry instanceof File)) {
            continue;
          }
          if (!entry.name.endsWith(PART_SUFFIX) || keep.has(entry.name)) {
            continue;
          }
          entry.delete();
          swept += 1;
        }
        return ok(swept);
      } catch (thrown) {
        return err(asTransferError(thrown));
      }
    },

    async usage(signal) {
      if (signal.cancelled) {
        return cancelled();
      }
      try {
        // Missing directory on a clean install reads as zero bytes.
        if (!directory.exists) {
          return ok(0);
        }
        let total = 0;
        for (const entry of directory.list()) {
          if (signal.cancelled) {
            return cancelled();
          }
          if (entry instanceof File) {
            total += entry.info().size ?? 0;
          }
        }
        return ok(total);
      } catch (thrown) {
        return err(asTransferError(thrown));
      }
    },

    async freeBytes(signal) {
      if (signal.cancelled) {
        return cancelled();
      }
      try {
        return ok(Paths.availableDiskSpace);
      } catch (thrown) {
        return err(asTransferError(thrown));
      }
    },

    async removeFile(name, signal) {
      if (signal.cancelled) {
        return cancelled();
      }
      try {
        const file = fileFor(name);
        if (file.exists) {
          file.delete();
        }
        const part = partFor(name);
        if (part.exists) {
          part.delete();
        }
        return ok(undefined);
      } catch (thrown) {
        return err(asTransferError(thrown));
      }
    },

    async stat(name, signal) {
      if (signal.cancelled) {
        return cancelled();
      }
      try {
        const file = fileFor(name);
        if (!file.exists) {
          return ok({ exists: false, bytes: null });
        }
        return ok({ exists: true, bytes: file.info().size ?? null });
      } catch (thrown) {
        return err(asTransferError(thrown));
      }
    },
  };

  return {
    transfer,
    dir: directory.uri,
    // Full file:// URI for a finalized name — what the local player
    // must receive (the ledger stores bare names only).
    uriFor: (name: string): string => fileFor(name).uri,
  };
}
