// Drop-in metro.config.js for the web harness — replaces
// apps/mobile/metro.config.js. Revert with `git checkout
// apps/mobile/metro.config.js` after testing.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);
config.resolver.assetExts.push('wasm');

const HARNESS = path.join(__dirname, 'web-harness');
const defaultResolve = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === 'web') {
    const remap = (file) => ({
      type: 'sourceFile',
      filePath: path.join(HARNESS, file),
    });
    // The plugin host / seam player / connectivity / FGS driver.
    if (moduleName === 'auqw-expo') {
      return remap('fake-auqw-expo.ts');
    }
    // Relative specifier — the app imports its own adapter file; alias
    // it by path tail, not package name.
    if (moduleName.endsWith('expo-connectivity.ts')) {
      return remap('expo-connectivity.ts');
    }
    if (moduleName === 'expo-file-system') {
      return remap('expo-file-system.ts');
    }
    if (moduleName === 'expo-asset') {
      return remap('expo-asset.ts');
    }
    if (moduleName === 'expo-audio') {
      return remap('expo-audio.ts');
    }
  }
  // metro ≥0.84 may set resolver.resolveRequest to a non-function
  // object — only call it when it is actually callable, else fall
  // back to the resolution context's default resolver.
  return typeof defaultResolve === 'function'
    ? defaultResolve(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
