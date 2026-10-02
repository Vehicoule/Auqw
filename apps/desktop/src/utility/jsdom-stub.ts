// Alias target for the utility bundle: pot-service statically imports
// jsdom, but the BotGuard session build it feeds runs only inside the
// dedicated pot-minter child — the utility itself never constructs a
// JSDOM (its mint path is createProcessMinter). A call reaching this
// class is a wiring bug, so it throws at construction, not later.
export class JSDOM {
  constructor() {
    throw new Error('jsdom is not bundled in the utility process');
  }
}
