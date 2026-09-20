import type { ExpoConfig } from 'expo/config';

const config: ExpoConfig = {
  name: 'Auqw',
  slug: 'auqw',
  version: '0.1.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'automatic',
  // auqw://play|spin|cancel deep links drive the Slice-0 gate runs
  // (adb am start / simctl openurl) — no other deep links exist yet.
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
    predictiveBackGestureEnabled: false,
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
  ],
};

export default config;
