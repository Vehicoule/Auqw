// In-memory expo-file-system for the web harness. Implements only the
// surface the app touches (expo-transfer.ts, expo-artwork.ts,
// expo-audio-player.ts, App.tsx): File/Directory/FileHandle/FileMode/
// Paths.
//
// NOTE: in-memory = bytes do not survive reload — the startup
// integrity sweep correctly degrades ledger rows to streaming on every
// reload ("file vanished — degrading to streaming"). For a persistent
// variant, back `store` with IndexedDB.

type Bytes = Uint8Array;
// Shared via globalThis so the expo-asset stub can seed asset bytes
// (module instances are separately bundled; this is the seam).
const store: Map<string, Bytes> = ((globalThis as { __auqwFsStore?: Map<string, Bytes> })
  .__auqwFsStore ??= new Map());
const dirs = new Set<string>(['file:///docs/', 'file:///docs/downloads/']);

const norm = (...parts: (string | Directory | File)[]): string =>
  parts
    .map((p) => (typeof p === 'string' ? p : p.uri))
    .join('/')
    .replace(/\/+/g, '/')
    .replace(/([^:/])\/\//g, '$1/')
    .replace(/\/?$/, (m) => m);

export const FileMode = {
  ReadOnly: 'r',
  ReadWrite: 'rw',
  WriteOnly: 'w',
  Append: 'wa',
} as const;

export const Paths = {
  document: 'file:///docs/',
  cache: 'file:///cache/',
  get availableDiskSpace(): number {
    return 4.3 * 1024 ** 3; // fake roomy disk; override to test ENOSPC
  },
};

export class FileHandle {
  #path: string;
  #offset = 0;
  #closed = false;
  constructor(path: string, private mode: string) {
    this.#path = path;
    if (mode === FileMode.Append || mode === FileMode.WriteOnly) {
      this.#offset = mode === FileMode.Append ? (store.get(path)?.length ?? 0) : 0;
      if (mode === FileMode.WriteOnly) store.set(path, new Uint8Array(0));
    }
  }
  get size(): number {
    return store.get(this.#path)?.length ?? 0;
  }
  readBytes(n: number): Bytes {
    const data = store.get(this.#path) ?? new Uint8Array(0);
    const chunk = data.subarray(this.#offset, this.#offset + n);
    this.#offset += chunk.length;
    return chunk;
  }
  writeBytes(bytes: Bytes): void {
    if (this.#closed) throw new Error('handle closed');
    const cur = store.get(this.#path) ?? new Uint8Array(0);
    const head = cur.subarray(0, this.#offset);
    const next = new Uint8Array(this.#offset + bytes.length);
    next.set(head);
    next.set(bytes, this.#offset);
    store.set(this.#path, next);
    this.#offset += bytes.length;
  }
  close(): void {
    this.#closed = true;
  }
}

export class File {
  readonly uri: string;
  constructor(...parts: (string | Directory | File)[]) {
    this.uri = norm(...parts);
  }
  get exists(): boolean {
    return store.has(this.uri);
  }
  get parentDirectory(): Directory {
    return new Directory(this.uri.replace(/[^/]+$/, ''));
  }
  get name(): string {
    return this.uri.replace(/\/$/, '').split('/').pop() ?? '';
  }
  create(opts?: { intermediates?: boolean }): void {
    if (!store.has(this.uri)) store.set(this.uri, new Uint8Array(0));
    if (opts?.intermediates) {
      this.parentDirectory.create({ intermediates: true });
    }
  }
  delete(): void {
    store.delete(this.uri);
  }
  info(): { size: number } {
    return { size: store.get(this.uri)?.length ?? 0 };
  }
  open(mode: string): FileHandle {
    return new FileHandle(this.uri, mode);
  }
  move(to: File | Directory, opts?: { overwrite?: boolean }): void {
    this.moveSync(to, opts);
  }
  moveSync(to: File | Directory, _opts?: { overwrite?: boolean }): void {
    const target = to instanceof Directory ? norm(to.uri, this.name) : to.uri;
    const data = store.get(this.uri) ?? new Uint8Array(0);
    store.set(target, data);
    store.delete(this.uri);
  }
  // The plugin loader calls this for bundled wasm assets; the fake
  // host never parses the bytes, so a missing entry decodes empty.
  base64(): string {
    const data = store.get(this.uri) ?? new Uint8Array(0);
    let s = '';
    for (let i = 0; i < data.length; i += 0x8000) {
      s += String.fromCharCode(...data.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }
  text(): string {
    return new TextDecoder().decode(store.get(this.uri) ?? new Uint8Array(0));
  }
  write(data: string | Bytes): void {
    store.set(this.uri, typeof data === 'string' ? new TextEncoder().encode(data) : data);
  }
}

export class Directory {
  readonly uri: string;
  constructor(...parts: (string | Directory | File)[]) {
    this.uri = norm(...parts) + '/';
  }
  get exists(): boolean {
    return dirs.has(this.uri);
  }
  get name(): string {
    return this.uri.replace(/\/$/, '').split('/').pop() ?? '';
  }
  create(opts?: { intermediates?: boolean; idempotent?: boolean }): void {
    dirs.add(this.uri);
    if (opts?.intermediates) {
      let acc = 'file:///';
      for (const seg of this.uri.replace('file:///', '').split('/')) {
        if (seg.length > 0) {
          acc += seg + '/';
          dirs.add(acc);
        }
      }
    }
  }
  list(): (File | Directory)[] {
    const out: (File | Directory)[] = [];
    const depth = this.uri.split('/').length;
    for (const [path] of store) {
      if (path.startsWith(this.uri) && path.split('/').length === depth + 1) {
        out.push(new File(path));
      }
    }
    for (const d of dirs) {
      if (d.startsWith(this.uri) && d.split('/').length === depth + 2 && d !== this.uri) {
        out.push(new Directory(d));
      }
    }
    return out;
  }
  delete(): void {
    dirs.delete(this.uri);
  }
}
