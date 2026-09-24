// Release ABI split: the universal release APK carries every ABI's
// native libs (~130 MB of the 153 MB artifact). 32-bit x86 and
// armeabi-v7a are dead targets for this app, so the plugin pins
// reactNativeArchitectures to arm64-v8a + x86_64 and turns on AGP
// ABI splits — prebuild emits per-ABI APKs (no universal: it would
// carry only third-party jniLibs for the dropped ABIs, no RN runtime,
// and crash on the very 32-bit devices it claims to cover):
//   app-arm64-v8a-release.apk   (phones — the ~53 MB download)
//   app-x86_64-release.apk      (x86 emulators / testing)
// shrinkResources joins minify in the release buildType to trim
// unreferenced res entries.
const { withAppBuildGradle, withDangerousMod, withGradleProperties } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

const ABIS = "'arm64-v8a', 'x86_64'";
const SPLITS = `splits {
        abi {
            enable true
            reset()
            include ${ABIS}
            universalApk false
        }
    }
    `;

function setGradleProp(modResults, key, value) {
  const item = modResults.find(
    (entry) => entry.type === 'property' && entry.key === key,
  );
  if (item !== undefined) {
    item.value = value;
  } else {
    modResults.push({ type: 'property', key, value });
  }
}

module.exports = function withReleaseAbis(config) {
  config = withGradleProperties(config, (config) => {
    setGradleProp(
      config.modResults,
      'reactNativeArchitectures',
      'arm64-v8a,x86_64',
    );
    // The template defaults minify OFF — alpha.2 shipped a 36 MB
    // unshrunk dex. R8 + shrinkResources are the standard release pair.
    setGradleProp(
      config.modResults,
      'android.enableMinifyInReleaseBuilds',
      'true',
    );
    setGradleProp(
      config.modResults,
      'android.enableShrinkResourcesInReleaseBuilds',
      'true',
    );
    return config;
  });
  config = withAppBuildGradle(config, (config) => {
    let gradle = config.modResults.contents;
    if (gradle.includes('splits {')) return config;
    const anchor = 'packagingOptions {';
    if (!gradle.includes(anchor)) {
      throw new Error('with-release-abis: packagingOptions anchor not found');
    }
    gradle = gradle.replace(anchor, SPLITS + anchor);
    if (!gradle.includes('universalApk false')) {
      throw new Error('with-release-abis: splits block not patched');
    }
    config.modResults.contents = gradle;
    return config;
  });
  // JNA ships desktop AWT references that can't resolve under R8 — the
  // host paths using them never run on Android anyway. android/ is
  // generated, so the rules land at prebuild via a dangerous mod.
  config = withDangerousMod(config, [
    'android',
    (config) => {
      const rulesPath = path.join(
        config.modRequest.platformProjectRoot,
        'app',
        'proguard-rules.pro',
      );
      const rules = fs.readFileSync(rulesPath, 'utf8');
      const marker = '-dontwarn java.awt.**';
      if (!rules.includes(marker)) {
        fs.writeFileSync(
          rulesPath,
          `${rules}\n# JNA ships desktop AWT references that can't resolve under R8 — the\n# host paths using them never run on Android anyway.\n-dontwarn java.awt.**\n-dontwarn com.sun.jna.**\n`,
        );
      }
      return config;
    },
  ]);
  return config;
};
