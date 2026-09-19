import type { ExpoConfig } from 'expo/config';

const config: ExpoConfig = {
  name: 'Auqw',
  slug: 'auqw',
  version: '0.1.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'light',
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
  ],
};

export default config;
