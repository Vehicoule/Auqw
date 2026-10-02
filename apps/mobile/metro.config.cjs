const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.resolver.assetExts.push('wasm');

// seam-dev.ts is the __DEV__ journey/seam harness — release bundling
// (NODE_ENV=production, which expo sets for export/release variants)
// swaps it for an empty module so its ~700 lines and the seam WASM
// asset stay out of the shipped JS. Its call sites sit behind
// __DEV__ gates; tsc still typechecks the real file.
if (process.env.NODE_ENV === 'production') {
  const defaultResolve = config.resolver.resolveRequest;
  config.resolver.resolveRequest = (context, moduleName, platform) => {
    if (moduleName.endsWith('seam-dev.ts')) {
      return { type: 'empty' };
    }
    // metro ≥0.84 may set resolver.resolveRequest to a non-function
    // object — call it only when callable, else fall back to the
    // resolution context's default.
    return typeof defaultResolve === 'function'
      ? defaultResolve(context, moduleName, platform)
      : context.resolveRequest(context, moduleName, platform);
  };
}

module.exports = config;
