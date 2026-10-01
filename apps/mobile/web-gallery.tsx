// Web-only gallery harness — mounts the ui-native GalleryScreen with the
// same providers App.tsx uses, nothing else. All fixtures; no session.
import React from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useFonts } from 'expo-font';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_700Bold,
} from '@expo-google-fonts/inter';
import { GalleryScreen } from '@auqw/ui-native';

export function WebGallery() {
  const [fontsLoaded] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_700Bold,
  });
  if (!fontsLoaded) {
    return null;
  }
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <GalleryScreen />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
