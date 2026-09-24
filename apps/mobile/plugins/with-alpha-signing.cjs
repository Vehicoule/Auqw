// Alpha release signing: injects signingConfigs.alpha into the
// prebuild-generated android/app/build.gradle and points the release
// buildType at it. The keystore is repo-held — same convention as the
// RN template's debug.keystore — so every alpha build signs with one
// identity and users can upgrade-install between alphas. The real
// upload-key chain is the parked post-alpha signing decision.
const { withAppBuildGradle } = require('expo/config-plugins');

const ANCHOR = 'signingConfigs {\n        debug {';
const ALPHA = `signingConfigs {
        alpha {
            storeFile file('../../keystores/alpha.keystore')
            storePassword 'auqw-alpha'
            keyAlias 'auqw-alpha'
            keyPassword 'auqw-alpha'
        }
        debug {`;

module.exports = function withAlphaSigning(config) {
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
