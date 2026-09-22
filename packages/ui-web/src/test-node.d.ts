declare module 'node:fs' {
  export function readdirSync(path: URL): readonly string[];
  export function readFileSync(path: URL, encoding: 'utf8'): string;
}

declare module 'node:module' {
  export function register(specifier: string, parentURL: string | URL): void;
}

interface ImportMeta {
  readonly url: string;
}

declare const process: {
  exitCode: number | undefined;
};

declare const console: {
  log(...args: readonly unknown[]): void;
  error(...args: readonly unknown[]): void;
};
