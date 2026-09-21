// expo-asset stub for the web harness. `Asset.fromModule(n)` maps the
// static require() numeric handle to a fetchable asset URL served from
// dist/assets — downloadAsync resolves with localUri so the plugin
// loader can read the (placeholder) wasm bytes.

export class Asset {
  #module: number;
  localUri: string | null = null;
  uri = '';
  width = 0;
  height = 0;
  type = 'wasm';
  name = '';
  hash = null;
  downloaded = false;

  private constructor(moduleId: number) {
    this.#module = moduleId;
  }

  static fromModule(moduleId: number): Asset {
    const a = new Asset(moduleId);
    // Metro emits wasm assets under dist/assets/node_modules/…; the
    // placeholder content doesn't matter to the fake host — only that
    // fetch resolves.
    a.localUri = `/assets/plugin-${moduleId}.wasm`;
    a.uri = a.localUri;
    return a;
  }

  async downloadAsync(): Promise<this> {
    this.downloaded = true;
    return this;
  }
}
