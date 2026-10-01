// Web-only entry for the ui-native gallery harness. Registered under
// `main` in package.json for the export run — never shipped.
import '@expo/metro-runtime';
import { registerRootComponent } from 'expo';

import { WebGallery } from './web-gallery';

registerRootComponent(WebGallery);
