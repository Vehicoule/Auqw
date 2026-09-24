// Alpha release signing: when AUQW_ALPHA_KEYSTORE_FILE points at a
// keystore (CI decodes it from a repo secret), injects
// signingConfigs.alpha into the prebuild-generated
// android/app/build.gradle and points the release buildType at it —
// one signature across alpha builds so installs upgrade cleanly.
// Credentials never enter the repo: the gradle block reads passwords
// from env at build time. With no env set the plugin is a no-op and
// release builds fall back to AGP's stock debug signing (local dev).
// The real upload-key chain is the parked post-alpha signing decision.
const { withAppBuildGradle } = require('expo/config-plugins');

const ANCHOR = 'signingConfigs {\n        debug {';
const ALPHA = `signingConfigs {
        alpha {
            storeFile file(System.getenv('AUQW_ALPHA_KEYSTORE_FILE'))
            storePassword System.getenv('AUQW_ALPHA_STORE_PASSWORD')
            keyAlias 'auqw-alpha'
            keyPassword System.getenv('AUQW_ALPHA_KEY_PASSWORD')
        }
        debug {`;

module.exports = function withAlphaSigning(config) {
  if (!process.env.AUQW_ALPHA_KEYSTORE_FILE) return config;
  return withAppBuildGradle(config, (config) => {
    let gradle = config.modResults.contents;
    if (gradle.includes('signingConfigs.alpha')) return config;
    if (!gradle.includes(ANCHOR)) {
      throw new Error('with-alpha-signing: signingConfigs anchor not found');
    }
    gradle = gradle.replace(ANCHOR, ALPHA);
    gradle = gradle.replace(
      /release \{[\s\S]*?signingConfig signingConfigs\.debug/,
      (match) => match.replace('signingConfigs.debug', 'signingConfigs.alpha'),
    );
    if (!gradle.includes('signingConfigs.alpha')) {
      throw new Error('with-alpha-signing: release signingConfig not patched');
    }
    config.modResults.contents = gradle;
    return config;
  });
};
