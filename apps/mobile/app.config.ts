import type { ExpoConfig } from 'expo/config';

const config: ExpoConfig = {
  name: 'Auqw',
  slug: 'auqw',
  version: '0.0.1-alpha.1',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'automatic',
  // auqw://play|spin|cancel deep links drive the Slice-0 gate runs
  // (adb am start / simctl openurl); auqw://seam-* links are the
  // Slice 1.5 seam harness — no other deep links exist yet.
  scheme: 'auqw',
  ios: {
    bundleIdentifier: 'com.vehicoule.auqw',
  },
  android: {
    package: 'com.vehicoule.auqw',
    adaptiveIcon: {
      backgroundColor: '#E6F4FE',
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      monochromeImage: './assets/android-icon-monochrome.png',
    },
    predictiveBackGestureEnabled: true,
  },
  plugins: [
    [
      'expo-audio',
      {
        // Playback only — no mic permission, background playback
        // stays enabled (FOREGROUND_SERVICE + AudioControlsService).
        microphonePermission: false,
        recordAudioAndroid: false,
      },
    ],
    'expo-sqlite',
    // CI-secret alpha keystore → release builds sign with one stable
    // identity across CI runs (upgrade-install between alphas works);
    // no env → stock debug signing for local builds.
    './plugins/with-alpha-signing.cjs',
    // release APK splits per ABI (arm64-v8a + x86_64) + R8/shrink —
    // the 153 MB alpha.2 was half dead-arch libs and unminified dex.
    './plugins/with-release-abis.cjs',
    [
      'expo-navigation-bar',
      {
        // Android 16 edge-to-edge is mandatory — light buttons over the
        // app canvas; the style is re-applied per theme at runtime.
        style: 'light',
        enforceContrast: false,
      },
    ],
  ],
};

export default config;
