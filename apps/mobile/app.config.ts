import type { ExpoConfig } from 'expo/config';

const config: ExpoConfig = {
  name: 'Auqw',
  slug: 'auqw',
  version: '0.1.0',
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
