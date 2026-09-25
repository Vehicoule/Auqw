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
    // expo-audio's background-audio knob is disabled below — it would
    // ship Android's AudioControlsService, a second media player — so
    // the iOS background-audio mode is declared here directly instead.
    infoPlist: {
      UIBackgroundModes: ['audio'],
    },
  },
  web: {
    favicon: './assets/favicon.png',
  },
  android: {
    package: 'com.vehicoule.auqw',
    adaptiveIcon: {
      backgroundColor: '#eef0f7',
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      monochromeImage: './assets/android-icon-monochrome.png',
    },
    predictiveBackGestureEnabled: true,
  },
  plugins: [
    [
      'expo-splash-screen',
      {
        image: './assets/splash-icon.png',
        imageWidth: 320,
        resizeMode: 'contain',
        backgroundColor: '#eef0f7',
        dark: {
          image: './assets/splash-icon-dark.png',
          backgroundColor: '#1a1b26',
        },
      },
    ],
    [
      'expo-audio',
      {
        // Playback only — no mic permission. Background playback config
        // is off: on Android it would ship AudioControlsService, a
        // second MediaSessionService competing with the Media3 seam's
        // AuqwMediaSessionService (docs/specs/playback.md: one player
        // ships). iOS keeps background audio via ios.infoPlist above.
        microphonePermission: false,
        recordAudioAndroid: false,
        enableBackgroundPlayback: false,
      },
    ],
    'expo-sqlite',
    // CI-secret alpha keystore → release builds sign with one stable
    // identity across CI runs (upgrade-install between alphas works);
    // no env → stock debug signing for local builds.
    './plugins/with-alpha-signing.cjs',
    // release APK splits per ABI + R8/shrink — the 153 MB alpha.2 was
    // half dead-arch libs and unminified dex. CI passes
    // -Pauqw.abis=arm64-v8a (ships arm64 only); x86_64 stays in the
    // default for emulator debug builds.
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
