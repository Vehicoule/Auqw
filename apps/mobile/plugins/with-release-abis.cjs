// Release ABI split: the universal release APK carries every ABI's
// native libs (~130 MB of the 153 MB artifact). 32-bit x86 and
// armeabi-v7a are dead targets for this app, so the plugin pins
// reactNativeArchitectures to arm64-v8a + x86_64 and turns on AGP
// ABI splits — prebuild emits per-ABI APKs (no universal: it would
// carry only third-party jniLibs for the dropped ABIs, no RN runtime,
// and crash on the very 32-bit devices it claims to cover).
// The release workflow narrows packaging to arm64 via
// -Pauqw.abis=arm64-v8a; the default keeps x86_64 for emulator
// debug/testing:
//   app-arm64-v8a-release.apk   (phones — the ~53 MB download)
//   app-x86_64-release.apk      (local builds only, x86 emulators)
// shrinkResources joins minify in the release buildType to trim
// unreferenced res entries.
// JNA/UniFFI ProGuard keeps used to be injected into
// app/proguard-rules.pro here. They moved to
// modules/auqw-expo/android/consumer-rules.pro — the library that owns the
// JNA dependency now ships its own consumer rules, and AGP merges them
// automatically. (The old member-only keepclassmembers rule also let R8
// strip the @FieldOrder class annotation → Structure.getFieldOrder()
// crash on the first FFI call; consumer-rules.pro uses full keeps.)
const { withAppBuildGradle, withGradleProperties } = require('expo/config-plugins');

const ABIS = "(findProperty('auqw.abis') ?: 'arm64-v8a,x86_64').split(',') as String[]";
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
  return config;
};
