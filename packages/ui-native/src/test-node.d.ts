declare module 'node:fs' {
  export function readdirSync(path: URL): readonly string[];
  export function readFileSync(path: URL, encoding: 'utf8'): string;
}

interface ImportMeta {
  readonly url: string;
}
